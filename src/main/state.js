const { loadConfig, saveConfig } = require("./config-store");
const { hashSecret } = require("./security-utils");

const config = loadConfig();

const state = {
  isConnected: false,
  discord: {
    status: "stopped",
    botTag: "",
    lastError: ""
  },
  voice: {
    status: "stopped",
    port: config.voiceServerPort,
    url: "",
    provider: "unconfigured",
    lastError: ""
  },
  remoteAccess: {
    status: "stopped",
    port: config.remoteAccessPort,
    url: "",
    localUrls: [],
    username: config.remoteAccessUsername,
    authConfigured: Boolean(config.remoteAccessUsername && config.remoteAccessPasswordHash),
    lastError: ""
  },
  update: {
    status: "idle",
    currentVersion: "",
    availableVersion: "",
    progressPercent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    errorMessage: ""
  },
  config,
  sessions: [],
  logs: [
    {
      id: "boot-1",
      level: "info",
      message: "Siylo initialized in local tray mode.",
      timestamp: new Date().toISOString()
    }
  ]
};

function createLog(level, message) {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    level,
    message,
    timestamp: new Date().toISOString()
  };
}

function appendLog(level, message) {
  state.logs = [createLog(level, message), ...state.logs].slice(0, 100);
  return state.logs[0];
}

function getStateSnapshot() {
  return {
    isConnected: state.isConnected,
    discord: state.discord,
    voice: state.voice,
    remoteAccess: state.remoteAccess,
    update: state.update,
    config: sanitizeConfig(state.config),
    sessions: state.sessions,
    logs: state.logs
  };
}

function setDiscordState(partialState) {
  state.discord = {
    ...state.discord,
    ...partialState
  };
  state.isConnected = state.discord.status === "connected";
  return getStateSnapshot();
}

function setVoiceState(partialState) {
  state.voice = {
    ...state.voice,
    ...partialState
  };

  if (typeof state.voice.port !== "number" || Number.isNaN(state.voice.port)) {
    state.voice.port = state.config.voiceServerPort;
  }

  return getStateSnapshot();
}

function setRemoteAccessState(partialState) {
  state.remoteAccess = {
    ...state.remoteAccess,
    ...partialState
  };

  if (typeof state.remoteAccess.port !== "number" || Number.isNaN(state.remoteAccess.port)) {
    state.remoteAccess.port = state.config.remoteAccessPort;
  }

  state.remoteAccess.username = state.config.remoteAccessUsername;
  state.remoteAccess.authConfigured = Boolean(
    state.config.remoteAccessUsername && state.config.remoteAccessPasswordHash
  );

  return getStateSnapshot();
}

function updateConfig(partialConfig) {
  const nextConfig = {
    ...state.config,
    ...partialConfig,
    authorizedUsers: Array.isArray(partialConfig.authorizedUsers)
      ? partialConfig.authorizedUsers.filter(Boolean)
      : state.config.authorizedUsers,
    voiceServerPort:
      partialConfig.voiceServerPort === undefined
        ? state.config.voiceServerPort
        : Number(partialConfig.voiceServerPort) || state.config.voiceServerPort,
    remoteAccessPort:
      partialConfig.remoteAccessPort === undefined
        ? state.config.remoteAccessPort
        : Number(partialConfig.remoteAccessPort) || state.config.remoteAccessPort
  };

  if (partialConfig.remoteAccessPassword !== undefined) {
    const trimmedPassword = String(partialConfig.remoteAccessPassword || "").trim();

    if (trimmedPassword) {
      const passwordRecord = hashSecret(trimmedPassword);
      nextConfig.remoteAccessPasswordHash = passwordRecord.hash;
      nextConfig.remoteAccessPasswordSalt = passwordRecord.salt;
    }
  }

  state.config = saveConfig({
    ...nextConfig
  });

  state.voice = {
    ...state.voice,
    port: state.config.voiceServerPort
  };
  state.remoteAccess = {
    ...state.remoteAccess,
    port: state.config.remoteAccessPort,
    username: state.config.remoteAccessUsername,
    authConfigured: Boolean(
      state.config.remoteAccessUsername && state.config.remoteAccessPasswordHash
    )
  };

  appendLog("info", "Configuration updated.");
  return getStateSnapshot();
}

function getConfig() {
  return state.config;
}

function sanitizeConfig(configValue) {
  return {
    botToken: configValue.botToken,
    authorizedUsers: configValue.authorizedUsers,
    dashboardPort: configValue.dashboardPort,
    voiceServerPort: configValue.voiceServerPort,
    remoteAccessEnabled: configValue.remoteAccessEnabled,
    remoteAccessPort: configValue.remoteAccessPort,
    remoteAccessUsername: configValue.remoteAccessUsername,
    remoteAccessPasswordConfigured: Boolean(configValue.remoteAccessPasswordHash),
    autoConnect: configValue.autoConnect,
    commandPrefix: configValue.commandPrefix
  };
}

function initializeUpdateState(currentVersion) {
  state.update = {
    ...state.update,
    currentVersion
  };

  return getStateSnapshot();
}

function setUpdateState(partialUpdate) {
  state.update = {
    ...state.update,
    ...partialUpdate
  };

  return getStateSnapshot();
}

function addSession(session) {
  const nextSession = {
    ...session,
    id: session.id || `cmd-${state.sessions.length + 1}`,
    createdAt: session.createdAt || new Date().toISOString()
  };
  state.sessions = [nextSession, ...state.sessions].slice(0, 10);
  return nextSession;
}

function getSession(sessionId) {
  return state.sessions.find((session) => session.id.toLowerCase() === sessionId.toLowerCase()) || null;
}

function updateSession(sessionId, partialSession) {
  let updatedSession = null;

  state.sessions = state.sessions.map((session) => {
    if (session.id.toLowerCase() !== sessionId.toLowerCase()) {
      return session;
    }

    updatedSession = {
      ...session,
      ...partialSession
    };

    return updatedSession;
  });

  return updatedSession;
}

function removeSession(sessionId) {
  const session = getSession(sessionId);
  state.sessions = state.sessions.filter((entry) => entry.id.toLowerCase() !== sessionId.toLowerCase());
  return session;
}

function clearSessions(predicate) {
  const removedSessions = [];
  const keepSessions = [];

  for (const session of state.sessions) {
    if (predicate(session)) {
      removedSessions.push(session);
    } else {
      keepSessions.push(session);
    }
  }

  state.sessions = keepSessions;
  return removedSessions;
}

function simulateSession(commandText) {
  const sessionId = `cmd-${state.sessions.length + 1}`;
  const session = {
    id: sessionId,
    shell: "cmd",
    status: "idle",
    lastCommand: commandText || "open cmd",
    createdAt: new Date().toISOString()
  };

  state.sessions = [session, ...state.sessions].slice(0, 10);
  appendLog("info", `Session created: ${sessionId}`);
  return getStateSnapshot();
}

module.exports = {
  addSession,
  appendLog,
  clearSessions,
  getConfig,
  getStateSnapshot,
  initializeUpdateState,
  getSession,
  removeSession,
  setDiscordState,
  setRemoteAccessState,
  setVoiceState,
  setUpdateState,
  updateSession,
  updateConfig,
  simulateSession
};
