const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const defaultConfig = {
  botToken: "",
  openAIApiKeyEncrypted: "",
  elevenLabsApiKeyEncrypted: "",
  elevenLabsVoiceId: "",
  elevenLabsModelId: "",
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
const localEncryptedSecretPrefix = "local:";
let electronSafeStorage = null;

try {
  const electron = require("electron");
  if (electron?.safeStorage && electron?.app) {
    electronSafeStorage = electron.safeStorage;
  }
} catch {}

function getConfigPath() {
  return path.join(getConfigDirectory(), "siylo.config.json");
}

function getConfigDirectory() {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Siylo");
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Siylo");
  }

  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "siylo");
}

function getSecretsKeyPath() {
  return path.join(getConfigDirectory(), "siylo.secrets.key");
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

  if (electronSafeStorage?.isEncryptionAvailable()) {
    const encryptedValue = electronSafeStorage.encryptString(trimmedSecret).toString("base64");
    return `${encryptedSecretPrefix}${encryptedValue}`;
  }

  const encryptedValue = encryptWithLocalKey(trimmedSecret);
  return `${localEncryptedSecretPrefix}${encryptedValue}`;
}

function decryptSecret(secret) {
  const serializedSecret = String(secret || "").trim();

  if (!serializedSecret) {
    return "";
  }

  if (!serializedSecret.startsWith(encryptedSecretPrefix)) {
    if (serializedSecret.startsWith(localEncryptedSecretPrefix)) {
      return decryptWithLocalKey(serializedSecret.slice(localEncryptedSecretPrefix.length));
    }

    return serializedSecret;
  }

  if (!electronSafeStorage?.isEncryptionAvailable()) {
    throw new Error(
      "This secret was stored with Electron secure storage and cannot be read from the CLI runtime. Re-enter it with `siylo`."
    );
  }

  const encryptedBuffer = Buffer.from(
    serializedSecret.slice(encryptedSecretPrefix.length),
    "base64"
  );
  return electronSafeStorage.decryptString(encryptedBuffer);
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
    elevenLabsApiKeyEncrypted:
      String(nextConfig.elevenLabsApiKeyEncrypted || "").trim() ||
      encryptSecret(nextConfig.elevenLabsApiKey),
    elevenLabsVoiceId: String(nextConfig.elevenLabsVoiceId || "").trim(),
    elevenLabsModelId: String(nextConfig.elevenLabsModelId || "").trim(),
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

function getOrCreateLocalSecretsKey() {
  const filePath = getSecretsKeyPath();
  ensureDirectory(filePath);

  if (fs.existsSync(filePath)) {
    return Buffer.from(fs.readFileSync(filePath, "utf8").trim(), "base64");
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(filePath, key.toString("base64"));
  return key;
}

function encryptWithLocalKey(secret) {
  const iv = crypto.randomBytes(12);
  const key = getOrCreateLocalSecretsKey();
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    value: encrypted.toString("base64")
  });
}

function decryptWithLocalKey(payload) {
  const parsed = JSON.parse(payload);
  const key = getOrCreateLocalSecretsKey();
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(parsed.iv, "base64")
  );
  decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.value, "base64")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  decryptSecret,
  defaultConfig,
  encryptSecret,
  loadConfig,
  saveConfig
};
