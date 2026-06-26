#!/usr/bin/env node

const os = require("node:os");
const process = require("node:process");
const readline = require("node:readline");
const {
  getStateSnapshot,
  startAgentServices,
  startRuntime,
  stopAgentServices,
  subscribe,
  shutdownRuntime,
  updateRuntimeConfig
} = require("../main/runtime");

readline.emitKeypressEvents(process.stdin);

const command = String(process.argv[2] || "").trim().toLowerCase() || "dashboard";
let currentState = null;
let notice = "Press S to start or stop the agent, C to configure, Q to quit.";
let renderTimer = null;
let keypressHandler = null;
let isPromptOpen = false;

main().catch(async (error) => {
  await shutdownRuntime().catch(() => {});
  process.stderr.write(`${formatError(error)}\n`);
  process.exit(1);
});

async function main() {
  if (command === "init") {
    await startRuntime();
    currentState = getStateSnapshot();
    await runConfigWizard();
    await shutdownRuntime();
    return;
  }

  if (command === "start") {
    await startRuntime();
    currentState = await startAgentServices();
    renderHeadlessSummary(currentState);
    installShutdownHandlers();
    await waitForever();
    return;
  }

  if (command === "config") {
    await startRuntime();
    currentState = getStateSnapshot();
    await runConfigWizard();
    await shutdownRuntime();
    return;
  }

  await runDashboard();
}

async function runDashboard() {
  await startRuntime();
  currentState = getStateSnapshot();
  installShutdownHandlers();

  subscribe((nextState) => {
    currentState = nextState;
    renderDashboard();
  });

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    renderHeadlessSummary(currentState);
    await waitForever();
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  keypressHandler = async (_, key = {}) => {
    if (isPromptOpen) {
      return;
    }

    if (key.ctrl && key.name === "c") {
      await exitDashboard();
      return;
    }

    if (key.name === "q" || key.name === "escape") {
      await exitDashboard();
      return;
    }

    if (key.name === "s" || key.name === "return") {
      await toggleAgent();
      return;
    }

    if (key.name === "c") {
      await runConfigWizard();
      return;
    }

    if (key.name === "a") {
      currentState = await updateRuntimeConfig({
        autoConnect: !currentState.config.autoConnect
      });
      notice = `Auto-connect ${currentState.config.autoConnect ? "enabled" : "disabled"}.`;
      renderDashboard();
      return;
    }

    if (key.name === "r") {
      currentState = await updateRuntimeConfig({
        remoteAccessEnabled: !currentState.config.remoteAccessEnabled
      });
      notice = `Remote access ${currentState.config.remoteAccessEnabled ? "enabled" : "disabled"}.`;
      renderDashboard();
    }
  };

  process.stdin.on("keypress", keypressHandler);
  renderDashboard();
  renderTimer = setInterval(() => {
    if (!isPromptOpen) {
      renderDashboard();
    }
  }, 1000);
}

async function toggleAgent() {
  notice = isAgentRunning(currentState) ? "Stopping Siylo agent..." : "Starting Siylo agent...";
  renderDashboard();
  currentState = isAgentRunning(currentState)
    ? await stopAgentServices()
    : await startAgentServices();
  notice = isAgentRunning(currentState)
    ? "Siylo agent is live."
    : "Siylo agent is idle. Voice server remains available locally.";
  renderDashboard();
}

async function runConfigWizard() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive config requires a TTY.");
  }

  isPromptOpen = true;
  const wasRaw = Boolean(process.stdin.isRaw);
  process.stdin.setRawMode(true);
  renderPromptShell();

  const nextConfig = {};
  const state = getStateSnapshot();
  const authorizedUsersDefault = state.config.authorizedUsers.join(", ");

  try {
    const botToken = await promptLine("Discord bot token", {
      secret: true
    });
    const authorizedUsers = await promptLine("Authorized Discord user IDs (comma separated)", {
      defaultValue: authorizedUsersDefault
    });
    const openAiApiKey = await promptLine("OpenAI API key", {
      secret: true
    });
    const elevenLabsApiKey = await promptLine("ElevenLabs API key", {
      secret: true
    });
    const elevenLabsVoiceId = await promptLine("ElevenLabs voice ID", {
      defaultValue: state.config.elevenLabsVoiceId
    });
    const elevenLabsModelId = await promptLine("ElevenLabs model ID", {
      defaultValue: state.config.elevenLabsModelId
    });
    const commandPrefix = await promptLine("Discord command prefix", {
      defaultValue: state.config.commandPrefix
    });
    const autoConnect = await promptLine("Auto-connect on launch? (y/n)", {
      defaultValue: state.config.autoConnect ? "y" : "n"
    });
    const remoteAccessEnabled = await promptLine("Enable remote access? (y/n)", {
      defaultValue: state.config.remoteAccessEnabled ? "y" : "n"
    });
    const remoteAccessPort = await promptLine("Remote access port", {
      defaultValue: String(state.config.remoteAccessPort)
    });
    const voiceServerPort = await promptLine("Voice server port", {
      defaultValue: String(state.config.voiceServerPort)
    });

    if (botToken) {
      nextConfig.botToken = botToken;
    }
    if (openAiApiKey) {
      nextConfig.openAIApiKey = openAiApiKey;
    }
    if (elevenLabsApiKey) {
      nextConfig.elevenLabsApiKey = elevenLabsApiKey;
    }

    nextConfig.authorizedUsers = splitList(authorizedUsers);
    nextConfig.elevenLabsVoiceId = elevenLabsVoiceId;
    nextConfig.elevenLabsModelId = elevenLabsModelId;
    nextConfig.commandPrefix = commandPrefix || state.config.commandPrefix;
    nextConfig.autoConnect = parseYesNo(autoConnect, state.config.autoConnect);
    nextConfig.remoteAccessEnabled = parseYesNo(
      remoteAccessEnabled,
      state.config.remoteAccessEnabled
    );
    nextConfig.remoteAccessPort = Number(remoteAccessPort) || state.config.remoteAccessPort;
    nextConfig.voiceServerPort = Number(voiceServerPort) || state.config.voiceServerPort;

    currentState = await updateRuntimeConfig(nextConfig);
    notice = "Configuration saved.";
  } finally {
    process.stdin.setRawMode(wasRaw);
    isPromptOpen = false;
    renderDashboard();
  }
}

function renderDashboard() {
  if (!process.stdout.isTTY || !currentState) {
    return;
  }

  const width = Math.max(88, Math.min(process.stdout.columns || 120, 140));
  const lines = [
    gradientLine("SIYLO CONTROL", width),
    dim(center("Local agent + radio surface", width)),
    "",
    box(
      "Status",
      [
        metricLine("Agent", isAgentRunning(currentState) ? paint("RUNNING", "green") : paint("IDLE", "amber")),
        metricLine("Discord", summarizeStatus(currentState.discord.status, currentState.discord.botTag || currentState.discord.lastError)),
        metricLine("Voice", summarizeStatus(currentState.voice.status, currentState.voice.url || currentState.voice.provider)),
        metricLine("Remote", summarizeStatus(currentState.remoteAccess.status, currentState.remoteAccess.url || currentState.remoteAccess.lastError)),
        metricLine("Machine", `${os.hostname()} (${process.platform})`)
      ],
      width
    ),
    box(
      "Config",
      [
        metricLine("Authorized users", String(currentState.config.authorizedUsers.length)),
        metricLine("OpenAI", currentState.config.openAIApiKeyConfigured ? paint("configured", "green") : paint("missing", "red")),
        metricLine("ElevenLabs", currentState.config.elevenLabsApiKeyConfigured ? paint("configured", "green") : paint("missing", "red")),
        metricLine("Prefix", currentState.config.commandPrefix),
        metricLine("Remote access", currentState.config.remoteAccessEnabled ? `enabled on ${currentState.config.remoteAccessPort}` : "disabled")
      ],
      width
    ),
    box(
      "Sessions",
      currentState.sessions.length === 0
        ? [dim("No managed sessions yet.")]
        : currentState.sessions.slice(0, 5).map((session) => {
            return `${paint(session.id, "cyan")}  ${session.shell}  ${dim(session.status)}  ${trimText(session.lastCommand, width - 32)}`;
          }),
      width
    ),
    box(
      "Recent Logs",
      currentState.logs.slice(0, 6).reverse().map((entry) => {
        return `${paint(levelLabel(entry.level), levelTone(entry.level))} ${trimText(entry.message, width - 16)}`;
      }),
      width
    ),
    box(
      "Controls",
      [
        `${paint("S / Enter", "cyan")} start or stop agent`,
        `${paint("C", "cyan")} configure secrets and ports`,
        `${paint("A", "cyan")} toggle auto-connect`,
        `${paint("R", "cyan")} toggle remote access`,
        `${paint("Q / Esc", "cyan")} quit`
      ],
      width
    ),
    "",
    paint(` ${notice} `, "ink")
  ];

  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${lines.join("\n")}\n`);
}

function renderPromptShell() {
  const width = Math.max(88, Math.min(process.stdout.columns || 120, 140));
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`${gradientLine("SIYLO SETUP", width)}\n`);
  process.stdout.write(`${dim(center("Leave a field blank to keep its current value.", width))}\n\n`);
}

function renderHeadlessSummary(state) {
  const lines = [
    "Siylo runtime started.",
    `Discord: ${state.discord.status}${state.discord.botTag ? ` (${state.discord.botTag})` : ""}`,
    `Voice: ${state.voice.status}${state.voice.url ? ` -> ${state.voice.url}` : ""}`,
    `Remote access: ${state.remoteAccess.status}${state.remoteAccess.url ? ` -> ${state.remoteAccess.url}` : ""}`
  ];

  process.stdout.write(`${lines.join("\n")}\n`);
}

async function promptLine(label, options = {}) {
  const defaultValue = String(options.defaultValue || "");
  const secret = Boolean(options.secret);
  let value = "";

  process.stdout.write(`${paint(label, "cyan")}${defaultValue ? dim(` [${defaultValue}]`) : ""}\n> `);

  return new Promise((resolve, reject) => {
    const onKeypress = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        reject(new Error("Prompt cancelled."));
        return;
      }

      if (key.name === "return") {
        cleanup();
        process.stdout.write("\n\n");
        resolve(value || defaultValue);
        return;
      }

      if (key.name === "backspace") {
        if (!value) {
          return;
        }

        value = value.slice(0, -1);
        rewritePromptValue(value, secret);
        return;
      }

      if (key.sequence && !key.ctrl && !key.meta && text) {
        value += text;
        rewritePromptValue(value, secret);
      }
    };

    const cleanup = () => {
      process.stdin.off("keypress", onKeypress);
    };

    process.stdin.on("keypress", onKeypress);
  });
}

function rewritePromptValue(value, secret) {
  process.stdout.write("\r\x1b[2K> ");
  process.stdout.write(secret ? "•".repeat(value.length) : value);
}

function installShutdownHandlers() {
  const shutdown = async () => {
    await exitDashboard();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function exitDashboard() {
  if (renderTimer) {
    clearInterval(renderTimer);
    renderTimer = null;
  }

  if (keypressHandler) {
    process.stdin.off("keypress", keypressHandler);
    keypressHandler = null;
  }

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  process.stdout.write("\x1b[2J\x1b[H");
  await shutdownRuntime().catch(() => {});
  process.exit(0);
}

function box(title, bodyLines, width) {
  const innerWidth = width - 4;
  const top = `┌${"─".repeat(width - 2)}┐`;
  const header = `│ ${paint(title.toUpperCase(), "ink")}${" ".repeat(Math.max(0, innerWidth - title.length))} │`;
  const divider = `├${"─".repeat(width - 2)}┤`;
  const lines = bodyLines.map((line) => `│ ${padVisible(line, innerWidth)} │`);
  const bottom = `└${"─".repeat(width - 2)}┘`;
  return [top, header, divider, ...lines, bottom].join("\n");
}

function metricLine(label, value) {
  return `${paint(label.toUpperCase(), "slate")}  ${value}`;
}

function summarizeStatus(status, detail) {
  const tone =
    status === "connected" || status === "listening"
      ? "green"
      : status === "starting" || status === "connecting"
        ? "amber"
        : status === "error"
          ? "red"
          : "slate";
  return `${paint(String(status || "unknown"), tone)}${detail ? ` ${dim(trimText(detail, 56))}` : ""}`;
}

function gradientLine(text, width) {
  const padded = center(text, width);
  const chars = padded.split("");
  return chars
    .map((char, index) => {
      const ratio = chars.length <= 1 ? 0 : index / (chars.length - 1);
      const red = Math.round(42 + (ratio * 22));
      const green = Math.round(112 + (ratio * 78));
      const blue = Math.round(245 - (ratio * 60));
      return `\x1b[38;2;${red};${green};${blue}m${char}`;
    })
    .join("") + "\x1b[0m";
}

function center(value, width) {
  const text = String(value || "");
  const padding = Math.max(0, Math.floor((width - text.length) / 2));
  return `${" ".repeat(padding)}${text}`.padEnd(width, " ");
}

function padVisible(value, width) {
  const plain = stripAnsi(String(value || ""));
  if (plain.length >= width) {
    return `${trimAnsi(value, width - 1)} `;
  }

  return `${value}${" ".repeat(width - plain.length)}`;
}

function trimText(value, width) {
  const text = String(value || "");
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function trimAnsi(value, width) {
  return trimText(stripAnsi(value), width);
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function paint(value, tone) {
  const palette = {
    amber: "\x1b[38;2;240;178;70m",
    cyan: "\x1b[38;2;107;214;255m",
    green: "\x1b[38;2;96;214;141m",
    ink: "\x1b[38;2;235;244;255m",
    red: "\x1b[38;2;255;112;112m",
    slate: "\x1b[38;2;135;155;176m"
  };

  return `${palette[tone] || palette.ink}${value}\x1b[0m`;
}

function dim(value) {
  return `\x1b[2m${value}\x1b[0m`;
}

function levelLabel(level) {
  return String(level || "info").toUpperCase().padEnd(5, " ");
}

function levelTone(level) {
  if (level === "error") {
    return "red";
  }

  if (level === "warn") {
    return "amber";
  }

  return "green";
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseYesNo(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["y", "yes", "true", "1"].includes(normalized)) {
    return true;
  }

  if (["n", "no", "false", "0"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function isAgentRunning(state) {
  return ["connected", "connecting"].includes(state.discord.status) ||
    ["starting", "listening"].includes(state.remoteAccess.status);
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function waitForever() {
  return new Promise(() => {});
}
