const path = require("node:path");
const packageJson = require("../../package.json");
const { getStateSnapshot, initializeUpdateState, setUpdateState, subscribe, updateConfig } = require("./state");
const { initializeDiscordService, startDiscord, stopDiscord } = require("./discord-service");
const { startVoiceServer, stopVoiceServer } = require("./voice-server");
const {
  isRemoteAccessRunning,
  restartRemoteAccess,
  startRemoteAccess,
  stopRemoteAccess
} = require("./remote-access-manager");

let initialized = false;
let shutdownPromise = null;
const packageRoot = path.resolve(__dirname, "../..");

function initializeRuntime(options = {}) {
  if (initialized) {
    return getStateSnapshot();
  }

  const productionRoot = options.productionRoot || path.join(packageRoot, "out");
  const publicRoot = options.publicRoot || path.join(packageRoot, "public");
  const rendererUrl = options.rendererUrl || "http://127.0.0.1:3000";
  const isDev = Boolean(options.isDev);
  const onStateChanged = typeof options.onStateChanged === "function" ? options.onStateChanged : null;

  initializeUpdateState(packageJson.version || "0.0.0");
  setUpdateState({
    status: "disabled",
    errorMessage: "",
    availableVersion: ""
  });

  if (onStateChanged) {
    subscribe(onStateChanged);
  }

  initializeDiscordService({
    onStateChanged,
    restartApp: () => {}
  });

  initialized = true;
  return {
    isDev,
    productionRoot,
    publicRoot,
    rendererUrl
  };
}

async function startRuntime(options = {}) {
  const runtimeOptions = initializeRuntime(options);

  await startVoiceServer();

  const snapshot = getStateSnapshot();
  if (snapshot.config.autoConnect && snapshot.config.botToken) {
    await startDiscord(snapshot.config);
  }

  if (snapshot.config.remoteAccessEnabled) {
    await startRemoteAccess(runtimeOptions).catch(() => {});
  }

  return getStateSnapshot();
}

async function startAgentServices(options = {}) {
  const runtimeOptions = initializeRuntime(options);
  const snapshot = getStateSnapshot();

  if (snapshot.config.botToken) {
    await startDiscord(snapshot.config);
  }

  await startRemoteAccess(runtimeOptions).catch(() => {});
  return getStateSnapshot();
}

async function stopAgentServices() {
  await stopDiscord();
  await stopRemoteAccess().catch(() => {});
  return getStateSnapshot();
}

async function updateRuntimeConfig(partialConfig, options = {}) {
  const runtimeOptions = initializeRuntime(options);
  const wasRemoteAccessRunning = isRemoteAccessRunning();
  const snapshot = updateConfig(partialConfig);

  if (wasRemoteAccessRunning) {
    await restartRemoteAccess(runtimeOptions).catch(() => {});
  }

  return snapshot;
}

async function shutdownRuntime() {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    await stopAgentServices().catch(() => {});
    await stopVoiceServer().catch(() => {});
    return getStateSnapshot();
  })();

  try {
    return await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }
}

module.exports = {
  getStateSnapshot,
  initializeRuntime,
  startAgentServices,
  startRuntime,
  stopAgentServices,
  subscribe,
  shutdownRuntime,
  updateRuntimeConfig
};
