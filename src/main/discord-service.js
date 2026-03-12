const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { app } = require("electron");
const {
  AttachmentBuilder,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials
} = require("discord.js");
const screenshot = require("screenshot-desktop");
const {
  addSession,
  appendLog,
  getStateSnapshot,
  setDiscordState
} = require("./state");

let client = null;
let restartApp = null;
let notifyStateChanged = null;

const appLaunchMap = {
  cmd: {
    shellLabel: "cmd",
    launchCommand: "start \"\" cmd"
  },
  powershell: {
    shellLabel: "powershell",
    launchCommand: "start \"\" powershell"
  },
  vscode: {
    shellLabel: "vscode",
    launchCommand: "start \"\" code"
  },
  cursor: {
    shellLabel: "cursor",
    launchCommand: "start \"\" cursor"
  },
  kiro: {
    shellLabel: "kiro",
    launchCommand: "start \"\" kiro"
  },
  browser: {
    shellLabel: "browser",
    launchCommand: "start \"\" https://127.0.0.1"
  }
};

function emitState() {
  if (typeof notifyStateChanged === "function") {
    notifyStateChanged(getStateSnapshot());
  }
}

function setStatus(partialState) {
  setDiscordState(partialState);
  emitState();
}

function log(level, message) {
  appendLog(level, message);
  emitState();
}

function initializeDiscordService(options = {}) {
  restartApp = options.restartApp || null;
  notifyStateChanged = options.onStateChanged || null;
}

async function startDiscord(config) {
  if (client) {
    return getStateSnapshot();
  }

  if (!config.botToken) {
    log("error", "Start requested without a Discord bot token.");
    setStatus({
      status: "error",
      lastError: "Missing Discord bot token."
    });
    return getStateSnapshot();
  }

  setStatus({
    status: "connecting",
    botTag: "",
    lastError: ""
  });
  log("info", "Connecting to Discord gateway.");

  const nextClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
  });

  nextClient.once(Events.ClientReady, (readyClient) => {
    log("info", `Discord bot connected as ${readyClient.user.tag}.`);
    setStatus({
      status: "connected",
      botTag: readyClient.user.tag,
      lastError: ""
    });
  });

  nextClient.on(Events.MessageCreate, async (message) => {
    try {
      await handleIncomingMessage(message);
    } catch (error) {
      log("error", `Failed to handle Discord message: ${formatError(error)}`);
    }
  });

  nextClient.on(Events.Error, (error) => {
    log("error", `Discord client error: ${formatError(error)}`);
    setStatus({
      status: "error",
      lastError: formatError(error)
    });
  });

  nextClient.on(Events.ShardDisconnect, (_, shardId) => {
    log("warn", `Discord shard ${shardId} disconnected.`);
    setStatus({
      status: "stopped"
    });
  });

  nextClient.on(Events.ShardResume, (shardId) => {
    log("info", `Discord shard ${shardId} resumed.`);
    setStatus({
      status: "connected",
      lastError: ""
    });
  });

  try {
    await nextClient.login(config.botToken);
    client = nextClient;
    return getStateSnapshot();
  } catch (error) {
    await safeDestroy(nextClient);
    log("error", `Discord login failed: ${formatError(error)}`);
    setStatus({
      status: "error",
      lastError: formatError(error)
    });
    return getStateSnapshot();
  }
}

async function stopDiscord() {
  if (client) {
    await safeDestroy(client);
    client = null;
  }

  log("info", "Discord connection stopped.");
  setStatus({
    status: "stopped",
    botTag: "",
    lastError: ""
  });
  return getStateSnapshot();
}

async function safeDestroy(instance) {
  try {
    await instance.destroy();
  } catch {
    // Ignore client teardown failures.
  }
}

function isCommandMessage(message) {
  if (!client || !client.user || message.author.bot) {
    return false;
  }

  if (message.channel.type === ChannelType.DM) {
    return true;
  }

  const configuredPrefix = getStateSnapshot().config.commandPrefix || "@siylo";
  return (
    message.mentions.users.has(client.user.id) ||
    message.content.trim().toLowerCase().startsWith(configuredPrefix.trim().toLowerCase())
  );
}

function extractCommandText(message) {
  if (!client || !client.user) {
    return "";
  }

  const configuredPrefix = getStateSnapshot().config.commandPrefix || "@siylo";
  const mentionPatterns = [
    new RegExp(`<@!?${client.user.id}>`, "g"),
    new RegExp(`^@${escapeRegExp(client.user.username)}`, "i"),
    new RegExp(`^${escapeRegExp(configuredPrefix)}`, "i")
  ];

  let nextText = message.content;
  for (const pattern of mentionPatterns) {
    nextText = nextText.replace(pattern, " ");
  }

  return nextText.trim();
}

async function handleIncomingMessage(message) {
  if (!isCommandMessage(message)) {
    return;
  }

  log("info", `Matched command message from ${message.author.id} in ${describeChannel(message)}.`);
  const commandText = extractCommandText(message);
  if (!commandText) {
    log("warn", `Command message from ${message.author.id} had no parsed command body.`);
    return;
  }

  log("info", `Received Discord command from ${message.author.id}: ${commandText}`);

  try {
    await message.react("👀");
  } catch (error) {
    log("warn", `Could not add reaction to Discord command: ${formatError(error)}`);
  }

  const authorizedUsers = getStateSnapshot().config.authorizedUsers;
  if (!authorizedUsers.includes(message.author.id)) {
    log("warn", `Ignored command from unauthorized Discord ID ${message.author.id}.`);
    return;
  }

  await dispatchCommand(message, commandText);
}

async function dispatchCommand(message, commandText) {
  const lowerCommand = commandText.toLowerCase();

  if (lowerCommand === "logs") {
    await sendLogs(message);
    return;
  }

  if (lowerCommand === "screenshot") {
    await sendScreenshot(message);
    return;
  }

  if (lowerCommand === "restart") {
    await message.reply("Restarting Siylo.");
    log("info", "Restart requested from Discord.");
    if (typeof restartApp === "function") {
      restartApp();
    }
    return;
  }

  if (lowerCommand.startsWith("open ")) {
    const target = lowerCommand.slice("open ".length).trim();
    await openTarget(message, target);
    return;
  }

  await message.reply(
    "Unknown command. Supported commands: `logs`, `screenshot`, `restart`, `open cmd`, `open powershell`, `open cursor`, `open vscode`, `open kiro`."
  );
}

async function sendLogs(message) {
  const entries = getStateSnapshot().logs
    .slice(0, 12)
    .reverse()
    .map((entry) => `[${entry.level.toUpperCase()}] ${entry.timestamp} ${entry.message}`);

  const payload = `Recent Siylo logs:\n\`\`\`\n${entries.join("\n").slice(0, 1800)}\n\`\`\``;
  await message.reply(payload);
}

async function sendScreenshot(message) {
  const imagePath = path.join(os.tmpdir(), `siylo-screenshot-${Date.now()}.jpg`);

  try {
    await screenshot({ filename: imagePath });
    const attachment = new AttachmentBuilder(imagePath, { name: "siylo-screenshot.jpg" });
    await message.reply({
      content: "Current desktop screenshot.",
      files: [attachment]
    });
    log("info", "Screenshot captured and sent to Discord.");
  } catch (error) {
    log("error", `Screenshot command failed: ${formatError(error)}`);
    await message.reply(`Screenshot failed: ${formatError(error)}`);
  } finally {
    await fs.rm(imagePath, { force: true }).catch(() => {});
  }
}

async function openTarget(message, target) {
  const mappedTarget = appLaunchMap[target];
  if (!mappedTarget) {
    await message.reply(`Unknown app target: ${target}`);
    return;
  }

  try {
    await launchDetached(mappedTarget.launchCommand);
    const session = addSession({
      shell: mappedTarget.shellLabel,
      status: "idle",
      lastCommand: `open ${target}`
    });
    log("info", `Launched ${target} from Discord command.`);
    emitState();
    await message.reply(`Launched ${target}. Session created: ${session.id}`);
  } catch (error) {
    log("error", `Failed to launch ${target}: ${formatError(error)}`);
    await message.reply(`Failed to launch ${target}: ${formatError(error)}`);
  }
}

function launchDetached(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function describeChannel(message) {
  if (message.channel.type === ChannelType.DM) {
    return "DM";
  }

  return message.guild ? `${message.guild.name} / ${message.channel.id}` : "unknown channel";
}

function getClient() {
  return client;
}

module.exports = {
  getClient,
  initializeDiscordService,
  startDiscord,
  stopDiscord
};
