const { app } = require("electron");
const { autoUpdater } = require("electron-updater");

let isConfigured = false;
let onStatusChange = () => {};
let onLog = () => {};

function configureUpdater(handlers = {}) {
  onStatusChange = handlers.onStatusChange || (() => {});
  onLog = handlers.onLog || (() => {});

  onStatusChange({
    status: app.isPackaged ? "idle" : "disabled",
    currentVersion: app.getVersion()
  });

  if (isConfigured || !app.isPackaged) {
    return;
  }

  isConfigured = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    onLog("info", "Checking GitHub Releases for a newer build.");
    onStatusChange({
      status: "checking",
      currentVersion: app.getVersion(),
      errorMessage: "",
      progressPercent: 0
    });
  });

  autoUpdater.on("update-available", (info) => {
    onLog("info", `Update ${info.version} found. Download started automatically.`);
    onStatusChange({
      status: "available",
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      errorMessage: "",
      progressPercent: 0
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    onStatusChange({
      status: "downloading",
      currentVersion: app.getVersion(),
      progressPercent: Math.max(0, Math.min(100, progress.percent || 0)),
      bytesPerSecond: progress.bytesPerSecond || 0,
      transferredBytes: progress.transferred || 0,
      totalBytes: progress.total || 0
    });
  });

  autoUpdater.on("update-not-available", (info) => {
    onLog("info", `No update available. Current version is ${app.getVersion()}.`);
    onStatusChange({
      status: "idle",
      currentVersion: app.getVersion(),
      availableVersion: info?.version || "",
      errorMessage: "",
      progressPercent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    onLog("info", `Update ${info.version} downloaded and ready to install.`);
    onStatusChange({
      status: "downloaded",
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      progressPercent: 100,
      transferredBytes: 0,
      totalBytes: 0,
      bytesPerSecond: 0,
      errorMessage: ""
    });
  });

  autoUpdater.on("error", (error) => {
    const message = error instanceof Error ? error.message : String(error);
    onLog("error", `Updater error: ${message}`);
    onStatusChange({
      status: "error",
      currentVersion: app.getVersion(),
      errorMessage: message
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    onStatusChange({
      status: "disabled",
      currentVersion: app.getVersion(),
      errorMessage: "Auto-updates are only available in packaged builds."
    });
    return null;
  }

  return autoUpdater.checkForUpdates();
}

function installDownloadedUpdate() {
  if (!app.isPackaged) {
    return false;
  }

  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });

  return true;
}

module.exports = {
  checkForUpdates,
  configureUpdater,
  installDownloadedUpdate
};
