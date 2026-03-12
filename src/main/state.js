const { loadConfig, saveConfig } = require("./config-store");

const config = loadConfig();

const state = {
  isConnected: false,
  discord: {
    status: "stopped",
    botTag: "",
    lastError: ""
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
    config: state.config,
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

function updateConfig(partialConfig) {
  state.config = saveConfig({
    ...state.config,
    ...partialConfig,
    authorizedUsers: Array.isArray(partialConfig.authorizedUsers)
      ? partialConfig.authorizedUsers.filter(Boolean)
      : state.config.authorizedUsers
  });

  appendLog("info", "Configuration updated.");
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
  getStateSnapshot,
  getSession,
  removeSession,
  setDiscordState,
  updateSession,
  updateConfig,
  simulateSession
};
