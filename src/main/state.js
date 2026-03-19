const { loadConfig, saveConfig, encryptSecret } = require("./config-store");
const { hashSecret } = require("./security-utils");

const config = loadConfig();
const defaultTranscriptionModel = process.env.SIYLO_TRANSCRIBE_MODEL || "whisper-1";

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
    provider: resolveVoiceProvider(config),
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
    botToken:
      partialConfig.botToken === undefined
        ? state.config.botToken
        : String(partialConfig.botToken || "").trim(),
    authorizedUsers: Array.isArray(partialConfig.authorizedUsers)
      ? partialConfig.authorizedUsers.map((value) => String(value || "").trim()).filter(Boolean)
      : state.config.authorizedUsers,
    dashboardPort:
      partialConfig.dashboardPort === undefined
        ? state.config.dashboardPort
        : Number(partialConfig.dashboardPort) || state.config.dashboardPort,
    voiceServerPort:
      partialConfig.voiceServerPort === undefined
        ? state.config.voiceServerPort
        : Number(partialConfig.voiceServerPort) || state.config.voiceServerPort,
    remoteAccessEnabled:
      partialConfig.remoteAccessEnabled === undefined
        ? state.config.remoteAccessEnabled
        : Boolean(partialConfig.remoteAccessEnabled),
    remoteAccessPort:
      partialConfig.remoteAccessPort === undefined
        ? state.config.remoteAccessPort
        : Number(partialConfig.remoteAccessPort) || state.config.remoteAccessPort,
    remoteAccessUsername:
      partialConfig.remoteAccessUsername === undefined
        ? state.config.remoteAccessUsername
        : String(partialConfig.remoteAccessUsername || "").trim(),
    autoConnect:
      partialConfig.autoConnect === undefined
        ? state.config.autoConnect
        : Boolean(partialConfig.autoConnect),
    commandPrefix:
      partialConfig.commandPrefix === undefined
        ? state.config.commandPrefix
        : String(partialConfig.commandPrefix || "").trim() || state.config.commandPrefix
  };

  if (partialConfig.remoteAccessPassword !== undefined) {
    const trimmedPassword = String(partialConfig.remoteAccessPassword || "").trim();

    if (trimmedPassword) {
      const passwordRecord = hashSecret(trimmedPassword);
      nextConfig.remoteAccessPasswordHash = passwordRecord.hash;
      nextConfig.remoteAccessPasswordSalt = passwordRecord.salt;
    }
  }

  if (partialConfig.openAIApiKey !== undefined) {
    nextConfig.openAIApiKeyEncrypted = encryptSecret(partialConfig.openAIApiKey);
  }

  if (partialConfig.clearOpenAIApiKey) {
    nextConfig.openAIApiKeyEncrypted = "";
  }

  state.config = saveConfig({
    ...nextConfig
  });

  state.voice = {
    ...state.voice,
    port: state.config.voiceServerPort,
    provider: resolveVoiceProvider(state.config)
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
    openAIApiKeyConfigured: Boolean(configValue.openAIApiKeyEncrypted || configValue.openAIApiKey),
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

function resolveVoiceProvider(configValue) {
  if (process.env.OPENAI_API_KEY || configValue.openAIApiKeyEncrypted || configValue.openAIApiKey) {
    return `openai:${defaultTranscriptionModel}`;
  }

  return "unconfigured";
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
