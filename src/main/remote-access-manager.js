const { appendLog, setRemoteAccessState } = require("./state");
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
  return require("./state").getStateSnapshot();
}

module.exports = {
  isRemoteAccessRunning,
  restartRemoteAccess,
  startRemoteAccess,
  stopRemoteAccess
};
