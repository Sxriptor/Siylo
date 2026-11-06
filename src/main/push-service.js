const fs = require("node:fs");
const path = require("node:path");
const webPush = require("web-push");
const { appendLog } = require("./state");

const MAX_SUBSCRIPTIONS = 12;
const VISIBLE_CLIENT_WINDOW_MS = 6000;
const MIN_NOTIFY_DURATION_MS = 2500;

let storeCache = null;
let lastVisibleClientAt = 0;
let lastVisibleSessionId = "";

function getStorePath() {
  if (process.env.SIYLO_PUSH_STORE) {
    return process.env.SIYLO_PUSH_STORE;
  }

  const { app } = require("electron");
  return path.join(app.getPath("userData"), "siylo.push.json");
}

function loadStore() {
  if (storeCache) {
    return storeCache;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(getStorePath(), "utf8"));
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      appendLog("warn", `Push store unreadable, recreating: ${formatError(error)}`);
    }
  }

  storeCache = {
    vapidPublicKey: String(parsed.vapidPublicKey || ""),
    vapidPrivateKey: String(parsed.vapidPrivateKey || ""),
    subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions.filter(isValidSubscription) : []
  };

  if (!storeCache.vapidPublicKey || !storeCache.vapidPrivateKey) {
    const keys = webPush.generateVAPIDKeys();
    storeCache.vapidPublicKey = keys.publicKey;
    storeCache.vapidPrivateKey = keys.privateKey;
    saveStore();
  }

  return storeCache;
}

function saveStore() {
  if (!storeCache) {
    return;
  }

  const filePath = getStorePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(storeCache, null, 2));
}

function getVapidPublicKey() {
  return loadStore().vapidPublicKey;
}

function addSubscription(subscription) {
  if (!isValidSubscription(subscription)) {
    throw new Error("Invalid push subscription.");
  }

  const store = loadStore();
  const normalized = {
    endpoint: subscription.endpoint,
    keys: {
      auth: subscription.keys.auth,
      p256dh: subscription.keys.p256dh
    },
    createdAt: new Date().toISOString()
  };
  store.subscriptions = [
    normalized,
    ...store.subscriptions.filter((entry) => entry.endpoint !== normalized.endpoint)
  ].slice(0, MAX_SUBSCRIPTIONS);
  saveStore();
  appendLog("info", "Push notification subscription registered.");
  return { subscribed: true, count: store.subscriptions.length };
}

function removeSubscription(endpoint) {
  const store = loadStore();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((entry) => entry.endpoint !== endpoint);
  if (store.subscriptions.length !== before) {
    saveStore();
  }

  return { subscribed: false, count: store.subscriptions.length };
}

function hasSubscription(endpoint) {
  return loadStore().subscriptions.some((entry) => entry.endpoint === endpoint);
}

function noteClientVisibility(visible, sessionId = "") {
  if (visible) {
    lastVisibleClientAt = Date.now();
    lastVisibleSessionId = String(sessionId || "");
  }
}

function isClientVisible() {
  return Date.now() - lastVisibleClientAt < VISIBLE_CLIENT_WINDOW_MS;
}

async function sendPushToAll(payload) {
  const store = loadStore();
  if (store.subscriptions.length === 0) {
    return { sent: 0, failed: 0 };
  }

  webPush.setVapidDetails("mailto:siylo@localhost", store.vapidPublicKey, store.vapidPrivateKey);
  const body = JSON.stringify(payload);
  let sent = 0;
  let failed = 0;
  const expired = new Set();

  await Promise.all(
    store.subscriptions.map(async (subscription) => {
      try {
        await webPush.sendNotification(subscription, body, { TTL: 600, urgency: "high" });
        sent += 1;
      } catch (error) {
        failed += 1;
        const statusCode = Number(error?.statusCode || 0);
        if (statusCode === 404 || statusCode === 410) {
          expired.add(subscription.endpoint);
        } else {
          appendLog("warn", `Push send failed (${statusCode || "network"}): ${formatError(error)}`);
        }
      }
    })
  );

  appendLog(
    failed > 0 ? "warn" : "info",
    `Push "${payload.title}" delivered to ${sent} device(s)${failed ? `, ${failed} failed` : ""}.`
  );

  if (expired.size > 0) {
    store.subscriptions = store.subscriptions.filter((entry) => !expired.has(entry.endpoint));
    saveStore();
  }

  return { sent, failed };
}

function handleSessionEventForPush(event) {
  if (!event || !["finished", "input", "exited"].includes(event.kind)) {
    return undefined;
  }

  if (event.kind === "finished" && Number(event.durationMs || 0) < MIN_NOTIFY_DURATION_MS) {
    return undefined;
  }

  // The open PWA already shows an in-app banner; skip pushing while the user
  // is actively looking at the session that just changed.
  if (isClientVisible() && lastVisibleSessionId === event.sessionId) {
    appendLog("info", `Skipped push for ${event.sessionId}: it is open on screen.`);
    return undefined;
  }

  if (loadStore().subscriptions.length === 0) {
    return undefined;
  }

  return sendPushToAll(buildNotificationPayload(event));
}

function buildNotificationPayload(event) {
  const label = formatSessionLabel(event.sessionId);
  const duration = formatDuration(event.durationMs);
  const command = String(event.command || "").trim();
  let title = `${label} finished`;
  if (event.kind === "input") {
    title = `${label} needs input`;
  } else if (event.kind === "exited") {
    title = `${label} closed`;
  }

  const details = [];
  if (command) {
    details.push(command.length > 60 ? `${command.slice(0, 57)}...` : command);
  }
  if (duration && event.kind === "finished") {
    details.push(duration);
  }

  const body = [details.join(" · "), String(event.summary || "").trim()].filter(Boolean).join("\n").slice(0, 240);

  return {
    title,
    body: body || "Tap to open the terminal.",
    sessionId: event.sessionId,
    kind: event.kind,
    tag: `siylo-${event.sessionId}`,
    url: `/radio?session=${encodeURIComponent(event.sessionId)}`
  };
}

function formatSessionLabel(sessionId) {
  const normalized = String(sessionId || "").trim().toLowerCase();
  const labels = { codex: "Codex", cursor: "Cursor", powershell: "PowerShell", cmd: "CMD" };
  if (labels[normalized]) {
    return labels[normalized];
  }
  const numbered = normalized.match(/^(cmd|powershell)-(\d+)$/);
  if (numbered) {
    return `${labels[numbered[1]]} ${numbered[2]}`;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function formatDuration(durationMs) {
  const totalSeconds = Math.round(Number(durationMs || 0) / 1000);
  if (totalSeconds <= 0) {
    return "";
  }
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function isValidSubscription(subscription) {
  return Boolean(
    subscription &&
      typeof subscription.endpoint === "string" &&
      /^https:\/\//.test(subscription.endpoint) &&
      subscription.keys &&
      typeof subscription.keys.auth === "string" &&
      typeof subscription.keys.p256dh === "string"
  );
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  addSubscription,
  buildNotificationPayload,
  getVapidPublicKey,
  handleSessionEventForPush,
  hasSubscription,
  noteClientVisibility,
  removeSubscription,
  sendPushToAll
};
