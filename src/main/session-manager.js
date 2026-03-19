const pty = require("node-pty");
const {
  addSession,
  appendLog,
  getSession,
  getStateSnapshot,
  removeSession,
  updateSession
} = require("./state");

const runtimeSessions = new Map();

let onSessionExit = null;

function initializeSessionManager(options = {}) {
  onSessionExit = options.onSessionExit || null;
}

function getNextSessionId(shell) {
  const prefix = shell.toLowerCase();
  const sessions = getStateSnapshot().sessions.filter((session) => session.shell.toLowerCase() === prefix);
  let nextNumber = 1;

  while (sessions.some((session) => session.id.toLowerCase() === `${prefix}-${nextNumber}`)) {
    nextNumber += 1;
  }

  return `${prefix}-${nextNumber}`;
}

async function createManagedSession(shell, options = {}) {
  const normalizedShell = shell.toLowerCase();
  const runtimeShell = (options.runtimeShell || normalizedShell).toLowerCase();
  const displayShell = (options.displayShell || normalizedShell).toLowerCase();
  if (!["cmd", "powershell"].includes(runtimeShell)) {
    throw new Error(`Managed sessions are only supported for cmd and powershell runtimes. Received: ${runtimeShell}`);
  }

  const sessionId = options.sessionId || getNextSessionId(displayShell);
  if (runtimeSessions.has(sessionId)) {
    throw new Error(`Session already exists: ${sessionId}`);
  }

  const executable = options.executable || (runtimeShell === "cmd" ? "cmd.exe" : "powershell.exe");
  const args = Array.isArray(options.args) ? options.args : runtimeShell === "cmd" ? [] : ["-NoLogo"];
  const ptyProcess = pty.spawn(executable, args, {
    name: "xterm-color",
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    cols: options.cols || 120,
    rows: options.rows || 30
  });

  const session = addSession({
    id: sessionId,
    shell: displayShell,
    status: "active",
    lastCommand: options.startupCommand || `open ${displayShell}`,
    pid: ptyProcess.pid
  });

  runtimeSessions.set(sessionId, {
    process: ptyProcess,
    pendingOutput: "",
    recentOutput: "",
    isBusy: false,
    closed: false
  });

  ptyProcess.onData((data) => {
    const runtime = runtimeSessions.get(sessionId);
    if (!runtime) {
      return;
    }

    const cleaned = stripAnsi(data);
    runtime.pendingOutput = `${runtime.pendingOutput}${cleaned}`.slice(-24000);
    runtime.recentOutput = `${runtime.recentOutput}${cleaned}`.slice(-4000);
    runtime.isBusy = detectBusyState(runtime.recentOutput);

    if (!runtime.isBusy && hasInteractivePrompt(runtime.recentOutput)) {
      runtime.recentOutput = runtime.recentOutput.slice(-800);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const runtime = runtimeSessions.get(sessionId);
    runtimeSessions.delete(sessionId);
    removeSession(sessionId);
    appendLog("info", `Managed session exited: ${sessionId} (code ${exitCode}).`);

    if (typeof onSessionExit === "function") {
      onSessionExit({
        sessionId,
        exitCode,
        pendingOutput: runtime ? runtime.pendingOutput : ""
      });
    }
  });

  if (options.startupCommand) {
    await delay(options.startupDelayMs ?? 220);
    ptyProcess.write(options.startupCommand);
    await delay(90);
    ptyProcess.write("\r");
  }

  appendLog("info", `Managed PTY session created: ${session.id} (PID ${ptyProcess.pid}).`);
  return session;
}

async function sendCommandToSession(sessionId, commandText) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);
  ensureSessionReadyForInput(sessionId, runtime);

  runtime.process.write(commandText);
  await delay(90);
  runtime.process.write("\r");

  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: commandText
    }) || session
  );
}

async function sendTextToSession(sessionId, commandText) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);
  ensureSessionReadyForInput(sessionId, runtime);

  runtime.process.write(commandText);
  await delay(90);
  runtime.process.write("\r");

  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: commandText
    }) || session
  );
}

async function sendKeyToSession(sessionId, keyName) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);
  const keyValue = normalizeKeyCommand(keyName);

  runtime.process.write(keyValue);

  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: keyName.toLowerCase()
    }) || session
  );
}

async function bringSessionToFront() {
  throw new Error("Front is not supported for PTY-backed sessions.");
}

async function killSession(sessionId) {
  const session = requireSession(sessionId);
  const runtime = runtimeSessions.get(sessionId);

  if (runtime) {
    runtime.closed = true;
    runtime.process.kill();
    runtimeSessions.delete(sessionId);
  }

  removeSession(sessionId);
  appendLog("info", `Managed session killed: ${sessionId}.`);
  return session;
}

async function killAllManagedSessions() {
  const sessions = listManagedSessions();
  const killed = [];

  for (const session of sessions) {
    try {
      await killSession(session.id);
      killed.push(session);
    } catch (error) {
      appendLog("warn", `Failed to kill ${session.id}: ${formatError(error)}`);
    }
  }

  return killed;
}

function listManagedSessions() {
  return getStateSnapshot().sessions.filter((session) => runtimeSessions.has(session.id));
}

function hasManagedSession(sessionId) {
  return runtimeSessions.has(sessionId);
}

function getManagedSessionSnapshot(sessionId, maxLength = 6000) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime) {
    return null;
  }

  const output = compactTerminalOutput(runtime.recentOutput || runtime.pendingOutput || "").slice(-maxLength).trim();

  return {
    sessionId,
    isBusy: runtime.isBusy,
    output
  };
}

function drainPendingOutput(sessionId, maxLength = 1600) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime || !runtime.pendingOutput) {
    return "";
  }

  const output = compactTerminalOutput(runtime.pendingOutput).slice(-maxLength);
  runtime.pendingOutput = "";
  return output.trim();
}

function requireSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return session;
}

function requireRuntimeSession(sessionId) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime) {
    throw new Error(`Managed runtime not found for ${sessionId}`);
  }

  return runtime;
}

function ensureSessionReadyForInput(sessionId, runtime) {
  if (runtime.isBusy) {
    throw new Error(
      `Session ${sessionId} appears busy. Wait for the current run to finish or send \`${sessionId} ctrl+c\` first.`
    );
  }
}

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b][^\u0007]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g,
    ""
  );
}

function compactTerminalOutput(value) {
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ");

  const compactedLines = [];
  let skipSpinnerBlock = false;

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.replace(/\s+$/g, "");
    const trimmed = line.trim();
    const previous = compactedLines[compactedLines.length - 1] || "";
    const previousTrimmed = previous.trim();

    if (containsTransientStatus(trimmed)) {
      skipSpinnerBlock = true;
      continue;
    }

    if (isSpinnerFragment(trimmed) || isCodexNoiseLine(trimmed)) {
      skipSpinnerBlock = true;
      continue;
    }

    if (skipSpinnerBlock) {
      if (!trimmed || isTransientStatusLine(trimmed) || isSpinnerFragment(trimmed) || isCodexNoiseLine(trimmed)) {
        continue;
      }

      skipSpinnerBlock = false;
    }

    if (!trimmed) {
      if (previousTrimmed) {
        compactedLines.push("");
      }
      continue;
    }

    if (trimmed === previousTrimmed) {
      continue;
    }

    if (isTransientStatusLine(trimmed)) {
      continue;
    }

    if (isCodexNoiseLine(trimmed)) {
      continue;
    }

    if (
      trimmed.length <= 6 &&
      previousTrimmed &&
      (previousTrimmed.startsWith(trimmed) || trimmed.startsWith(previousTrimmed))
    ) {
      continue;
    }

    compactedLines.push(line);
  }

  return compactedLines.join("\n").replace(/\n{3,}/g, "\n\n");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeKeyCommand(keyName) {
  const rawKey = String(keyName || "").trim();
  if (!rawKey) {
    throw new Error("Key command cannot be empty.");
  }

  if (rawKey.length === 1) {
    return rawKey;
  }

  const keyMap = {
    enter: "\r",
    return: "\r",
    esc: "\u001b",
    escape: "\u001b",
    tab: "\t",
    space: " ",
    backspace: "\b",
    delete: "\u007f",
    up: "\u001b[A",
    down: "\u001b[B",
    right: "\u001b[C",
    left: "\u001b[D",
    "ctrl+c": "\u0003",
    "ctrl+l": "\u000c",
    "ctrl+d": "\u0004",
    "ctrl+z": "\u001a"
  };

  const normalizedKey = rawKey.toLowerCase();
  const mappedKey = keyMap[normalizedKey];
  if (!mappedKey) {
    throw new Error(`Unsupported key command: ${keyName}`);
  }

  return mappedKey;
}

function isTransientStatusLine(value) {
  const normalized = value.trim().toLowerCase();
  return (
    /^working\d*(?:\s*\(\d+s.*\))?$/i.test(value) ||
    /^running\s+/i.test(value) ||
    /^explain this codebase$/i.test(value) ||
    isCodexCliStatusLine(normalized) ||
    isSpinnerFragment(normalized) ||
    isRepeatedSpinnerNoise(normalized) ||
    /^\d+$/.test(normalized)
  );
}

function isSpinnerFragment(value) {
  return /^(w|wo|wor|work|worki|workin|working\d*|orking|rking|king|ing|ng|g|\d+)?$/i.test(value);
}

function isRepeatedSpinnerNoise(value) {
  if (!value) {
    return false;
  }

  const tokens = value.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) {
    return false;
  }

  return tokens.every((token) => isSpinnerFragment(token) || token === "working");
}

function containsTransientStatus(value) {
  return (
    /working\d*\s*\(\d+s.*esc to interrupt/i.test(value) ||
    (/\bworking\b/i.test(value) && /\besc to interrupt\b/i.test(value)) ||
    isCodexCliStatusLine(value.trim().toLowerCase()) ||
    isRepeatedSpinnerNoise(value.trim().toLowerCase())
  );
}

function isCodexCliStatusLine(value) {
  return (
    /^working\d*$/.test(value) ||
    /^gpt-[\w.-]+\s+(low|medium|high)(?:\s+\d+%\s+left)?\s+~?\\/.test(value) ||
    /^gpt-[\w.-]+\s+(low|medium|high)(?:\s+\d+%\s+left)?\s+[a-z]:\\/.test(value) ||
    /^implement\s+\{[^}]+\}$/.test(value)
  );
}

function detectBusyState(value) {
  const compact = value.toLowerCase();
  if (hasInteractivePrompt(compact) || hasCompletionFooter(compact)) {
    return false;
  }

  return (
    compact.includes("esc to interrupt") ||
    /\bworking\d*\s*\(\d+s/.test(compact) ||
    /^working\d*$/m.test(compact)
  );
}

function isCodexNoiseLine(value) {
  const normalized = value.trim().toLowerCase();
  return (
    isCodexCliStatusLine(normalized) ||
    /^explain this codebase$/.test(normalized) ||
    /^token usage:\s+total=/i.test(normalized) ||
    /^to continue this session,\s+run codex resume /i.test(normalized)
  );
}

function hasCompletionFooter(value) {
  return /token usage:\s+total=/i.test(value) || /to continue this session,\s+run codex resume /i.test(value);
}

function hasInteractivePrompt(value) {
  return /(?:^|\n)(?:ps\s+)?[a-z]:\\[^\n>]*>\s*$/im.test(value) || /(?:^|\n)~\\[^\n>]*>\s*$/im.test(value);
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

module.exports = {
  bringSessionToFront,
  createManagedSession,
  drainPendingOutput,
  initializeSessionManager,
  killAllManagedSessions,
  killSession,
  listManagedSessions,
  hasManagedSession,
  getManagedSessionSnapshot,
  sendKeyToSession,
  sendCommandToSession,
  sendTextToSession
};
