const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
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
  appendLog,
  getStateSnapshot,
  setDiscordState
} = require("./state");
const {
  bringSessionToFront,
  createManagedSession,
  drainPendingOutput,
  initializeSessionManager,
  killAllManagedSessions,
  killSession,
  listManagedSessions,
  sendKeyToSession,
  sendCommandToSession,
  sendTextToSession
} = require("./session-manager");

let client = null;
let restartApp = null;
let notifyStateChanged = null;
const sessionStreams = new Map();

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
  initializeSessionManager({
    onSessionExit: async ({ sessionId, exitCode, pendingOutput }) => {
      await flushSessionOutput(sessionId, pendingOutput);
      await sendSessionMessage(sessionId, `Session ended: ${sessionId} (exit code ${exitCode}).`);
      stopSessionStream(sessionId);
    }
  });
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
      log(
        "info",
        `MessageCreate received from ${message.author.id} in ${describeChannel(message)}. Mentioned=${Boolean(
          nextClient.user && message.mentions.users.has(nextClient.user.id)
        )} RoleMention=${hasMentionedBotRole(message)} ContentPreview=${previewContent(message.content)}`
      );
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
  for (const sessionId of sessionStreams.keys()) {
    stopSessionStream(sessionId);
  }

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
    hasMentionedBotRole(message) ||
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
  const roleMentionPatterns = Array.from(message.mentions.roles.keys()).map(
    (roleId) => new RegExp(`<@&${escapeRegExp(roleId)}>`, "g")
  );
  mentionPatterns.push(...roleMentionPatterns);

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
    await message.react("\u{1F440}");
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
  const trimmedCommand = commandText.trim();
  const lowerCommand = trimmedCommand.toLowerCase();

  if (lowerCommand === "logs") {
    await sendLogs(message);
    return;
  }

  if (lowerCommand === "list") {
    await sendSessionList(message);
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

  if (lowerCommand === "kill all") {
    await killAllSessions(message);
    return;
  }

  const killMatch = trimmedCommand.match(/^kill\s+([a-z]+-\d+)$/i);
  if (killMatch) {
    await killSpecificSession(message, killMatch[1]);
    return;
  }

  const frontMatch = trimmedCommand.match(/^([a-z]+-\d+)\s+front$/i);
  if (frontMatch) {
    await frontSession(message, frontMatch[1]);
    return;
  }

  const typeMatch = trimmedCommand.match(/^([a-z]+-\d+)\s+t\s+([\s\S]+)$/i);
  if (typeMatch) {
    await typeIntoSession(message, typeMatch[1], typeMatch[2]);
    return;
  }

  const keyMatch = trimmedCommand.match(/^([a-z]+-\d+)\s+(enter|esc|ctrl\+c|ctrl\+l)$/i);
  if (keyMatch) {
    await sendSessionKey(message, keyMatch[1], keyMatch[2]);
    return;
  }

  const sessionCommandMatch = trimmedCommand.match(/^([a-z]+-\d+)\s+["']([\s\S]+)["']$/i);
  if (sessionCommandMatch) {
    await runSessionCommand(message, sessionCommandMatch[1], sessionCommandMatch[2]);
    return;
  }

  await message.reply(
    "Unknown command. Supported commands: `list`, `logs`, `screenshot`, `restart`, `open cmd`, `open powershell`, `open cursor`, `open vscode`, `open kiro`, `cmd-1 t explain the codebase`, `cmd-1 enter`, `cmd-1 esc`, `cmd-1 ctrl+c`, `cmd-1 front`, `kill cmd-1`, `kill all`."
  );
}

async function sendSessionList(message) {
  const sessions = listManagedSessions();

  if (sessions.length === 0) {
    await message.reply("No managed cmd or powershell sessions are currently open.");
    return;
  }

  const lines = sessions.map(
    (session) => `${session.id} | ${session.shell} | PID ${session.pid ?? "unknown"} | ${session.status}`
  );

  await message.reply(`Managed sessions:\n\`\`\`\n${lines.join("\n")}\n\`\`\``);
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
  if (target === "cmd" || target === "powershell") {
    await openManagedShell(message, target);
    return;
  }

  const mappedTarget = appLaunchMap[target];
  if (!mappedTarget) {
    await message.reply(`Unknown app target: ${target}`);
    return;
  }

  try {
    await launchDetached(mappedTarget.launchCommand);
    log("info", `Launched ${target} from Discord command.`);
    await message.reply(`Launched ${target}.`);
  } catch (error) {
    log("error", `Failed to launch ${target}: ${formatError(error)}`);
    await message.reply(`Failed to launch ${target}: ${formatError(error)}`);
  }
}

async function openManagedShell(message, shell) {
  try {
    const session = await createManagedSession(shell);
    ensureSessionStream(session.id, message.channelId);
    emitState();
    await message.reply(`Session created: ${session.id} (PID ${session.pid})`);
  } catch (error) {
    log("error", `Failed to create ${shell} session: ${formatError(error)}`);
    await message.reply(`Failed to create ${shell} session: ${formatError(error)}`);
  }
}

async function runSessionCommand(message, sessionId, commandText) {
  try {
    await sendCommandToSession(sessionId, commandText);
    ensureSessionStream(sessionId, message.channelId);
    log("info", `Sent command to ${sessionId}: ${commandText}`);
    await message.reply(`Sent to ${sessionId}: ${commandText}`);
  } catch (error) {
    log("error", `Failed to send command to ${sessionId}: ${formatError(error)}`);
    await message.reply(`Failed to send command to ${sessionId}: ${formatError(error)}`);
  }
}

async function typeIntoSession(message, sessionId, commandText) {
  try {
    await sendCommandToSession(sessionId, commandText);
    ensureSessionStream(sessionId, message.channelId);
    log("info", `Sent to ${sessionId}: ${commandText}`);
    await message.reply(`Sent to ${sessionId}: ${commandText}`);
  } catch (error) {
    log("error", `Failed to send command to ${sessionId}: ${formatError(error)}`);
    await message.reply(`Failed to send command to ${sessionId}: ${formatError(error)}`);
  }
}

async function sendSessionKey(message, sessionId, keyName) {
  try {
    await sendKeyToSession(sessionId, keyName);
    ensureSessionStream(sessionId, message.channelId);
    log("info", `Sent key to ${sessionId}: ${keyName.toLowerCase()}`);
    await message.reply(`Sent key to ${sessionId}: ${keyName.toLowerCase()}`);
  } catch (error) {
    log("error", `Failed to send key to ${sessionId}: ${formatError(error)}`);
    await message.reply(`Failed to send key to ${sessionId}: ${formatError(error)}`);
  }
}

async function frontSession(message, sessionId) {
  try {
    await bringSessionToFront(sessionId);
    log("info", `Brought session ${sessionId} to front.`);
    await message.reply(`Brought ${sessionId} to the front.`);
  } catch (error) {
    log("error", `Failed to bring ${sessionId} to front: ${formatError(error)}`);
    await message.reply(`Failed to bring ${sessionId} to front: ${formatError(error)}`);
  }
}

async function killSpecificSession(message, sessionId) {
  try {
    await killSession(sessionId);
    stopSessionStream(sessionId);
    emitState();
    await message.reply(`Killed ${sessionId}.`);
  } catch (error) {
    log("error", `Failed to kill ${sessionId}: ${formatError(error)}`);
    await message.reply(`Failed to kill ${sessionId}: ${formatError(error)}`);
  }
}

async function killAllSessions(message) {
  try {
    const sessions = await killAllManagedSessions();
    for (const session of sessions) {
      stopSessionStream(session.id);
    }
    emitState();
    await message.reply(
      sessions.length === 0
        ? "No managed cmd or powershell sessions were running."
        : `Killed ${sessions.length} managed session${sessions.length === 1 ? "" : "s"}.`
    );
  } catch (error) {
    log("error", `Failed to kill all sessions: ${formatError(error)}`);
    await message.reply(`Failed to kill all sessions: ${formatError(error)}`);
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

function ensureSessionStream(sessionId, channelId) {
  const existing = sessionStreams.get(sessionId);
  if (existing) {
    existing.channelId = channelId;
    return;
  }

  const intervalId = setInterval(() => {
    flushSessionOutput(sessionId).catch((error) => {
      log("warn", `Failed to flush output for ${sessionId}: ${formatError(error)}`);
    });
  }, 4000);

  sessionStreams.set(sessionId, {
    channelId,
    intervalId
  });
}

function stopSessionStream(sessionId) {
  const stream = sessionStreams.get(sessionId);
  if (!stream) {
    return;
  }

  clearInterval(stream.intervalId);
  sessionStreams.delete(sessionId);
}

async function flushSessionOutput(sessionId, forcedOutput = "") {
  const stream = sessionStreams.get(sessionId);
  if (!stream || !client) {
    return;
  }

  const output = forcedOutput || drainPendingOutput(sessionId);
  if (!output) {
    return;
  }

  await sendSessionMessage(sessionId, `\`\`\`\n${output.slice(-1700)}\n\`\`\``);
}

async function sendSessionMessage(sessionId, body) {
  const stream = sessionStreams.get(sessionId);
  if (!stream || !client) {
    return;
  }

  const channel = await client.channels.fetch(stream.channelId);
  if (!channel || !channel.isTextBased()) {
    return;
  }

  await channel.send(`**${sessionId}**\n${body}`);
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

function hasMentionedBotRole(message) {
  if (!message.guild || !message.guild.members.me) {
    return false;
  }

  return message.guild.members.me.roles.cache.some((role) => message.mentions.roles.has(role.id));
}

function previewContent(content) {
  if (!content) {
    return "[empty]";
  }

  return content.replace(/\s+/g, " ").slice(0, 80);
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
