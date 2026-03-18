const path = require("node:path");
const {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  shell
} = require("electron");
const {
  appendLog,
  getStateSnapshot,
  initializeUpdateState,
  setUpdateState,
  simulateSession,
  updateConfig
} = require("./state");
const {
  initializeDiscordService,
  startDiscord,
  stopDiscord
} = require("./discord-service");
const {
  checkForUpdates,
  configureUpdater,
  installDownloadedUpdate
} = require("./update-service");
const {
  startVoiceServer,
  stopVoiceServer
} = require("./voice-server");
const {
  isRemoteAccessRunning,
  restartRemoteAccess,
  startRemoteAccess,
  stopRemoteAccess
} = require("./remote-access-manager");

const isDev = process.env.NODE_ENV === "development";
const rendererUrl = process.env.SIYLO_RENDERER_URL || "http://127.0.0.1:3000";
const assetsPath = path.join(app.getAppPath(), "public");
const productionRootPath = path.join(app.getAppPath(), "out");
const productionRendererPath = path.join(app.getAppPath(), "out", "index.html");
const trayIconPath = path.join(assetsPath, "logo.png");
const appIconPath = path.join(assetsPath, "logo.ico");

let tray = null;
let mainWindow = null;

async function startAgentServices() {
  const config = getStateSnapshot().config;

  if (config.botToken) {
    await startDiscord(config);
  } else {
    appendLog("warn", "Start agent skipped Discord because no bot token is configured.");
  }

  await startRemoteAccess({
    isDev,
    rendererUrl,
    productionRoot: productionRootPath,
    publicRoot: assetsPath
  }).catch((error) => {
    appendLog("error", `Remote access start failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  return getStateSnapshot();
}

async function stopAgentServices() {
  await stopDiscord();
  await stopRemoteAccess().catch((error) => {
    appendLog("warn", `Remote access shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  });

  return getStateSnapshot();
}

function broadcastState() {
  const snapshot = getStateSnapshot();
  const agentRunning =
    snapshot.isConnected ||
    snapshot.discord.status === "connecting" ||
    snapshot.remoteAccess.status === "starting" ||
    snapshot.remoteAccess.status === "listening";
  const trayStatus = agentRunning
    ? snapshot.remoteAccess.status === "starting" || snapshot.discord.status === "connecting"
      ? "Connecting"
      : "Running"
    : snapshot.discord.status === "error" || snapshot.remoteAccess.status === "error"
      ? "Error"
      : "Stopped";

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("siylo:state-changed", snapshot);
  }

  if (tray) {
    tray.setToolTip(`Siylo (${trayStatus})`);
    tray.setContextMenu(buildTrayMenu());
  }
}

function buildTrayMenu() {
  const snapshot = getStateSnapshot();
  const isAgentRunning =
    snapshot.isConnected ||
    snapshot.discord.status === "connecting" ||
    snapshot.remoteAccess.status === "starting" ||
    snapshot.remoteAccess.status === "listening";
  const canStart = !isAgentRunning;

  return Menu.buildFromTemplate([
    { label: "Siylo", enabled: false },
    { type: "separator" },
    {
      label: isAgentRunning
        ? snapshot.discord.status === "connecting" || snapshot.remoteAccess.status === "starting"
          ? "Connecting..."
          : "Running"
        : "Start",
      enabled: canStart,
      click: async () => {
        await startAgentServices();
        broadcastState();
      }
    },
    {
      label: "Stop",
      enabled: isAgentRunning,
      click: async () => {
        await stopAgentServices();
        broadcastState();
      }
    },
    {
      label: "Settings",
      click: () => {
        showWindow();
      }
    },
    { type: "separator" },
    {
      label: "Open Dashboard",
      click: () => {
        if (isDev) {
          shell.openExternal(rendererUrl);
          return;
        }

        showWindow();
      }
    },
    {
      label: "Check for updates",
      enabled: app.isPackaged,
      click: () => {
        checkForUpdates().catch((error) => {
          appendLog("error", error instanceof Error ? error.message : String(error));
          broadcastState();
        });
      }
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      }
    }
  ]);
}

function createTray() {
  const image = nativeImage.createFromPath(trayIconPath).resize({
    width: process.platform === "win32" ? 16 : 18,
    height: process.platform === "win32" ? 16 : 18
  });

  tray = new Tray(image);
  tray.setToolTip("Siylo");
  tray.setContextMenu(buildTrayMenu());
  tray.on("double-click", () => {
    showWindow();
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 700,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0b1020",
    title: "Siylo",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("ready-to-show", () => {
    if (isDev) {
      mainWindow.show();
    }
  });

  if (isDev) {
    mainWindow.loadURL(rendererUrl);
    return;
  }

  mainWindow.loadFile(productionRendererPath);
}

function showWindow() {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.show();
  mainWindow.focus();
}

function registerIpc() {
  ipcMain.handle("siylo:get-state", () => getStateSnapshot());
  ipcMain.handle("siylo:start", async () => {
    const snapshot = await startAgentServices();
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:stop", async () => {
    const snapshot = await stopAgentServices();
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:check-for-updates", async () => {
    await checkForUpdates();
    return getStateSnapshot();
  });
  ipcMain.handle("siylo:install-update", () => {
    installDownloadedUpdate();
    return getStateSnapshot();
  });
  ipcMain.handle("siylo:update-config", async (_, partialConfig) => {
    const wasRemoteAccessRunning = isRemoteAccessRunning();
    updateConfig(partialConfig);
    if (wasRemoteAccessRunning) {
      await restartRemoteAccess({
        isDev,
        rendererUrl,
        productionRoot: productionRootPath,
        publicRoot: assetsPath
      }).catch((error) => {
        appendLog("error", `Remote access restart failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    broadcastState();
    return getStateSnapshot();
  });
  ipcMain.handle("siylo:simulate-session", (_, commandText) => {
    const snapshot = simulateSession(commandText);
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:open-dashboard", () => {
    if (isDev) {
      return shell.openExternal(rendererUrl);
    }

    showWindow();
    return undefined;
  });
}

app.whenReady().then(() => {
  appendLog("info", "Electron shell ready.");
  initializeUpdateState(app.getVersion());
  initializeDiscordService({
    onStateChanged: broadcastState,
    restartApp: () => {
      app.relaunch();
      app.exit(0);
    }
  });
  configureUpdater({
    onLog: appendLog,
    onStatusChange: (partialUpdate) => {
      setUpdateState(partialUpdate);
      broadcastState();
    }
  });
  createMainWindow();
  createTray();
  registerIpc();
  broadcastState();

  startVoiceServer()
    .then(() => {
      broadcastState();
    })
    .catch((error) => {
      appendLog("error", `Voice backend failed to start: ${error instanceof Error ? error.message : String(error)}`);
      broadcastState();
    });

  const snapshot = getStateSnapshot();
  if (snapshot.config.autoConnect && snapshot.config.botToken) {
    startDiscord(snapshot.config).then(() => {
      broadcastState();
    });
  }

  if (app.isPackaged) {
    setTimeout(() => {
      checkForUpdates().catch((error) => {
        appendLog("error", error instanceof Error ? error.message : String(error));
        broadcastState();
      });
    }, 3000);
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  app.isQuiting = true;
  stopAgentServices().catch((error) => {
    appendLog("warn", `Agent shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  stopVoiceServer().catch((error) => {
    appendLog("warn", `Voice backend shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
  });
});

app.on("activate", () => {
  showWindow();
});
