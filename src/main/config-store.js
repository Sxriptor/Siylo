const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const defaultConfig = {
  botToken: "",
  openAIApiKeyEncrypted: "",
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
const encryptedSecretPrefix = "safe:";

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

function encryptSecret(secret) {
  const trimmedSecret = String(secret || "").trim();

  if (!trimmedSecret) {
    return "";
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure local secret storage is unavailable on this device.");
  }

  const encryptedValue = safeStorage.encryptString(trimmedSecret).toString("base64");
  return `${encryptedSecretPrefix}${encryptedValue}`;
}

function decryptSecret(secret) {
  const serializedSecret = String(secret || "").trim();

  if (!serializedSecret) {
    return "";
  }

  if (!serializedSecret.startsWith(encryptedSecretPrefix)) {
    return serializedSecret;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("Secure local secret storage is unavailable on this device.");
  }

  const encryptedBuffer = Buffer.from(
    serializedSecret.slice(encryptedSecretPrefix.length),
    "base64"
  );
  return safeStorage.decryptString(encryptedBuffer);
}

function coercePort(value, fallback) {
  const parsedValue = Number(value);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : fallback;
}

function normalizeConfig(nextConfig) {
  return {
    ...defaultConfig,
    botToken: String(nextConfig.botToken || "").trim(),
    openAIApiKeyEncrypted:
      String(nextConfig.openAIApiKeyEncrypted || "").trim() ||
      encryptSecret(nextConfig.openAIApiKey),
    authorizedUsers: Array.isArray(nextConfig.authorizedUsers)
      ? nextConfig.authorizedUsers.map((value) => String(value || "").trim()).filter(Boolean)
      : [...defaultConfig.authorizedUsers],
    dashboardPort: coercePort(nextConfig.dashboardPort, defaultConfig.dashboardPort),
    voiceServerPort: coercePort(nextConfig.voiceServerPort, defaultConfig.voiceServerPort),
    remoteAccessEnabled: Boolean(nextConfig.remoteAccessEnabled),
    remoteAccessPort: coercePort(nextConfig.remoteAccessPort, defaultConfig.remoteAccessPort),
    remoteAccessUsername: String(nextConfig.remoteAccessUsername || "").trim(),
    remoteAccessPasswordHash: String(nextConfig.remoteAccessPasswordHash || ""),
    remoteAccessPasswordSalt: String(nextConfig.remoteAccessPasswordSalt || ""),
    autoConnect: Boolean(nextConfig.autoConnect),
    commandPrefix: String(nextConfig.commandPrefix || "").trim() || defaultConfig.commandPrefix
  };
}

function saveConfig(nextConfig) {
  const filePath = getConfigPath();
  ensureDirectory(filePath);
  const normalizedConfig = normalizeConfig(nextConfig);
  fs.writeFileSync(filePath, JSON.stringify(normalizedConfig, null, 2));
  return normalizedConfig;
}

module.exports = {
  decryptSecret,
  defaultConfig,
  encryptSecret,
  loadConfig,
  saveConfig
};
