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
  simulateSession,
  updateConfig
} = require("./state");
const {
  initializeDiscordService,
  startDiscord,
  stopDiscord
} = require("./discord-service");

const isDev = process.env.NODE_ENV === "development";
const rendererUrl = process.env.SIYLO_RENDERER_URL || "http://127.0.0.1:3000";
const assetsPath = path.join(app.getAppPath(), "public");
const trayIconPath = path.join(assetsPath, "logo.png");
const appIconPath = path.join(assetsPath, "logo.ico");

let tray = null;
let mainWindow = null;

function broadcastState() {
  const snapshot = getStateSnapshot();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("siylo:state-changed", snapshot);
  }

  if (tray) {
    const trayStatus = snapshot.isConnected
      ? "Connected"
      : snapshot.discord.status === "connecting"
        ? "Connecting"
        : snapshot.discord.status === "error"
          ? "Error"
          : "Stopped";
    tray.setToolTip(`Siylo (${trayStatus})`);
    tray.setContextMenu(buildTrayMenu());
  }
}

function buildTrayMenu() {
  const snapshot = getStateSnapshot();
  const canStart = !snapshot.isConnected && snapshot.discord.status !== "connecting";

  return Menu.buildFromTemplate([
    { label: "Siylo", enabled: false },
    { type: "separator" },
    {
      label: snapshot.isConnected
        ? "Running"
        : snapshot.discord.status === "connecting"
          ? "Connecting..."
          : "Start",
      enabled: canStart,
      click: async () => {
        await startDiscord(getStateSnapshot().config);
        broadcastState();
      }
    },
    {
      label: "Stop",
      enabled: snapshot.isConnected || snapshot.discord.status === "connecting",
      click: async () => {
        await stopDiscord();
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
        shell.openExternal(rendererUrl);
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

  mainWindow.loadURL(rendererUrl);
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
    const snapshot = await startDiscord(getStateSnapshot().config);
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:stop", async () => {
    const snapshot = await stopDiscord();
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:update-config", (_, partialConfig) => {
    const snapshot = updateConfig(partialConfig);
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:simulate-session", (_, commandText) => {
    const snapshot = simulateSession(commandText);
    broadcastState();
    return snapshot;
  });
  ipcMain.handle("siylo:open-dashboard", () => shell.openExternal(rendererUrl));
}

app.whenReady().then(() => {
  appendLog("info", "Electron shell ready.");
  initializeDiscordService({
    onStateChanged: broadcastState,
    restartApp: () => {
      app.relaunch();
      app.exit(0);
    }
  });
  createMainWindow();
  createTray();
  registerIpc();
  broadcastState();

  const snapshot = getStateSnapshot();
  if (snapshot.config.autoConnect && snapshot.config.botToken) {
    startDiscord(snapshot.config).then(() => {
      broadcastState();
    });
  }
});

app.on("window-all-closed", (event) => {
  event.preventDefault();
});

app.on("before-quit", () => {
  app.isQuiting = true;
  stopDiscord();
});

app.on("activate", () => {
  showWindow();
});
