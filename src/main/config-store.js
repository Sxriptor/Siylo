const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const defaultConfig = {
  botToken: "",
  authorizedUsers: [],
  dashboardPort: 3000,
  voiceServerPort: 3210,
  remoteAccessEnabled: false,
  remoteAccessPort: 3443,
  remoteAccessUsername: "",
  remoteAccessPasswordHash: "",
  remoteAccessPasswordSalt: "",
  autoConnect: false,
  commandPrefix: "@siylo"
};

function getConfigPath() {
  return path.join(app.getPath("userData"), "siylo.config.json");
}

function ensureDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

function loadConfig() {
  const filePath = getConfigPath();

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return {
      ...defaultConfig,
      ...JSON.parse(raw)
    };
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      console.error("Failed to load Siylo config:", error);
    }

    return { ...defaultConfig };
  }
}

function saveConfig(nextConfig) {
  const filePath = getConfigPath();
  ensureDirectory(filePath);
  fs.writeFileSync(filePath, JSON.stringify(nextConfig, null, 2));
  return nextConfig;
}

module.exports = {
  defaultConfig,
  loadConfig,
  saveConfig
};
