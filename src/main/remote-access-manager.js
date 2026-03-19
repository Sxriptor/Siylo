const { appendLog, getConfig, getStateSnapshot, setRemoteAccessState } = require("./state");
const {
  isCloudflaredTunnelRunning,
  startCloudflaredTunnel,
  stopCloudflaredTunnel
} = require("./cloudflared-service");
const {
  restartRemoteAccessServer,
  startRemoteAccessServer,
  stopRemoteAccessServer
} = require("./remote-access-server");

let currentOptions = null;

async function startRemoteAccess(options = {}) {
  currentOptions = {
    ...currentOptions,
    ...options
  };

  const config = getConfig();
  if (!config.remoteAccessEnabled) {
    const localUrls = [`http://127.0.0.1:${config.remoteAccessPort}/radio`];
    setRemoteAccessState({
      status: "stopped",
      port: config.remoteAccessPort,
      url: localUrls[0],
      localUrls,
      lastError: ""
    });
    appendLog("info", "Remote access start skipped because remote access is disabled.");
    return getStateSnapshot();
  }

  setRemoteAccessState({
    status: "starting",
    lastError: ""
  });

  const serverState = await startRemoteAccessServer(currentOptions);
  if (serverState.status === "error") {
    return requireState();
  }

  try {
    await startCloudflaredTunnel({
      tunnelName: "siylo-radio"
    });
  } catch (error) {
    await stopRemoteAccessServer().catch(() => {});
    setRemoteAccessState({
      status: "error",
      lastError: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }

  setRemoteAccessState({
    status: "listening",
    lastError: ""
  });
  appendLog("info", "Remote access agent started.");
  return requireState();
}

async function stopRemoteAccess() {
  await stopCloudflaredTunnel().catch((error) => {
    appendLog("warn", `Failed to stop cloudflared tunnel: ${error instanceof Error ? error.message : String(error)}`);
  });
  await stopRemoteAccessServer();
  setRemoteAccessState({
    status: "stopped",
    lastError: ""
  });
  appendLog("info", "Remote access agent stopped.");
  return requireState();
}

async function restartRemoteAccess(options = {}) {
  currentOptions = {
    ...currentOptions,
    ...options
  };

  await stopRemoteAccess();
  return startRemoteAccess(currentOptions);
}

function isRemoteAccessRunning() {
  return isCloudflaredTunnelRunning();
}

function requireState() {
  return getStateSnapshot();
}

module.exports = {
  isRemoteAccessRunning,
  restartRemoteAccess,
  startRemoteAccess,
  stopRemoteAccess
};
