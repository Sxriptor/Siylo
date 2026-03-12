const { loadConfig, saveConfig } = require("./config-store");

const config = loadConfig();

const state = {
  isConnected: false,
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
    config: state.config,
    sessions: state.sessions,
    logs: state.logs
  };
}

function startAgent() {
  if (!state.isConnected) {
    state.isConnected = true;
    appendLog("info", "Discord connection activated.");
  }

  return getStateSnapshot();
}

function stopAgent() {
  if (state.isConnected) {
    state.isConnected = false;
    appendLog("info", "Discord connection stopped.");
  }

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
  appendLog,
  getStateSnapshot,
  startAgent,
  stopAgent,
  updateConfig,
  simulateSession
};
