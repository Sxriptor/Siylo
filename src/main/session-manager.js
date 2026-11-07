const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const {
  addSession,
  appendLog,
  getSession,
  getStateSnapshot,
  removeSession,
  updateSession
} = require("./state");
const { detectCwdFromScreen } = require("./git-service");

const runtimeSessions = new Map();
const sessionEventListeners = new Set();
const sessionEvents = [];
const MAX_SESSION_EVENTS = 60;
const SNAPSHOT_MAX_LINES = 600;
const SCROLLBACK_LINES = 3000;
const ACTIVITY_TICK_MS = 350;
const PROMPT_SETTLE_MS = 350;
const BUSY_INDICATOR_SETTLE_MS = 1500;
const INPUT_WAIT_SETTLE_MS = 3500;
const TUI_IDLE_SETTLE_MS = 1200;
const MIN_COLS = 30;
const MAX_COLS = 220;
const MIN_ROWS = 10;
const MAX_ROWS = 120;

let sessionEventSeq = 0;
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
  const cols = clampInt(options.cols, MIN_COLS, MAX_COLS, 120);
  const rows = clampInt(options.rows, MIN_ROWS, MAX_ROWS, 30);
  const initialCwd = options.cwd || process.cwd();
  const ptyProcess = pty.spawn(executable, args, {
    name: "xterm-256color",
    cwd: initialCwd,
    env: options.env || process.env,
    cols,
    rows
  });

  const session = addSession({
    id: sessionId,
    shell: displayShell,
    status: "active",
    lastCommand: options.startupCommand || `open ${displayShell}`,
    pid: ptyProcess.pid
  });

  // A headless terminal emulator keeps an exact copy of what the real console
  // shows. ConPTY repaints lines with cursor movement, so simply stripping ANSI
  // codes produced duplicated / stale lines.
  const terminal = new Terminal({
    allowProposedApi: true,
    cols,
    rows,
    scrollback: SCROLLBACK_LINES,
    // Match ConPTY's own reflow/repaint behaviour so resizes don't leave
    // stale fragments of the previous width on screen.
    windowsPty: resolveWindowsPtyOptions()
  });

  const runtime = {
    process: ptyProcess,
    terminal,
    pendingOutput: "",
    recentOutput: "",
    isBusy: false,
    lastOutputAt: 0,
    closed: false,
    version: 0,
    snapshotCache: null,
    activity: "idle",
    runStartedAt: 0,
    submittedAt: 0,
    lastSubmittedCommand: "",
    sawBusyIndicator: false,
    waitingForInput: false,
    lastFinishedAt: 0,
    lastEventKind: "",
    interrupted: false,
    activityTimer: null,
    initialCwd,
    lastKnownCwd: ""
  };
  runtimeSessions.set(sessionId, runtime);

  runtime.activityTimer = setInterval(() => {
    evaluateSessionActivity(sessionId);
  }, ACTIVITY_TICK_MS);
  if (typeof runtime.activityTimer.unref === "function") {
    runtime.activityTimer.unref();
  }

  ptyProcess.onData((data) => {
    const activeRuntime = runtimeSessions.get(sessionId);
    if (!activeRuntime) {
      return;
    }

    activeRuntime.terminal.write(data, () => {
      activeRuntime.version += 1;
      activeRuntime.snapshotCache = null;
    });

    const cleaned = stripAnsi(data);
    activeRuntime.pendingOutput = `${activeRuntime.pendingOutput}${cleaned}`.slice(-24000);
    activeRuntime.recentOutput = `${activeRuntime.recentOutput}${cleaned}`.slice(-4000);
    activeRuntime.lastOutputAt = Date.now();
    activeRuntime.isBusy = detectBusyState(activeRuntime.recentOutput);

    if (!activeRuntime.isBusy && hasInteractivePrompt(activeRuntime.recentOutput)) {
      activeRuntime.recentOutput = activeRuntime.recentOutput.slice(-800);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    const exitedRuntime = runtimeSessions.get(sessionId);
    runtimeSessions.delete(sessionId);
    disposeRuntime(exitedRuntime);
    removeSession(sessionId);
    appendLog("info", `Managed session exited: ${sessionId} (code ${exitCode}).`);

    if (exitedRuntime && !exitedRuntime.closed) {
      emitSessionEvent({
        sessionId,
        kind: "exited",
        durationMs: exitedRuntime.runStartedAt ? Date.now() - exitedRuntime.runStartedAt : 0,
        command: exitedRuntime.lastSubmittedCommand,
        summary: `Exited with code ${exitCode}.`
      });
    }

    if (typeof onSessionExit === "function") {
      Promise.resolve()
        .then(() => onSessionExit({
          sessionId,
          exitCode,
          pendingOutput: exitedRuntime ? exitedRuntime.pendingOutput : ""
        }))
        .catch((error) => {
          appendLog("warn", `Session exit handler failed for ${sessionId}: ${formatError(error)}`);
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

async function sendCommandToSession(sessionId, commandText, options = {}) {
  return sendTextToSession(sessionId, commandText, options);
}

async function sendTextToSession(sessionId, commandText, options = {}) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);
  if (!options.allowBusy) {
    ensureSessionReadyForInput(sessionId, runtime);
  }

  const text = String(commandText || "");
  const pressEnter = options.pressEnter !== false;
  // TUIs such as Codex enable bracketed paste and treat a fast burst of
  // characters as a paste, swallowing an Enter that arrives too soon after it.
  // Send the text as a real paste in that case and press Enter separately.
  const usesBracketedPaste = Boolean(runtime.terminal.modes?.bracketedPasteMode);
  if (text) {
    runtime.process.write(usesBracketedPaste ? `\u001b[200~${text}\u001b[201~` : text);
  }

  if (pressEnter) {
    if (text) {
      await delay(usesBracketedPaste ? 220 : 60);
    }
    runtime.process.write("\r");
    markSessionSubmitted(runtime, text);
  }

  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: text || "enter"
    }) || session
  );
}

async function sendKeyToSession(sessionId, keyName) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);
  const keyValue = normalizeKeyCommand(keyName);
  const normalizedKeyName = String(keyName || "").trim().toLowerCase();

  runtime.process.write(keyValue);

  if (keyValue === "\r") {
    markSessionSubmitted(runtime, "");
  } else if (normalizedKeyName === "ctrl+c" || normalizedKeyName === "esc" || normalizedKeyName === "escape") {
    runtime.interrupted = runtime.activity === "running";
  }

  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: normalizedKeyName
    }) || session
  );
}

function resizeSession(sessionId, cols, rows) {
  const runtime = requireRuntimeSession(sessionId);
  const nextCols = clampInt(cols, MIN_COLS, MAX_COLS, runtime.terminal.cols);
  const nextRows = clampInt(rows, MIN_ROWS, MAX_ROWS, runtime.terminal.rows);

  if (nextCols === runtime.terminal.cols && nextRows === runtime.terminal.rows) {
    return { cols: nextCols, rows: nextRows, changed: false };
  }

  // ConPTY repaints the whole visible screen after a resize. Clear our copy of
  // the viewport first (scrollback is kept) so the repaint lands on a clean
  // screen instead of on top of reflowed fragments from the old width.
  runtime.terminal.resize(nextCols, nextRows);
  runtime.terminal.write("\u001b[H\u001b[2J");
  runtime.process.resize(nextCols, nextRows);
  runtime.version += 1;
  runtime.snapshotCache = null;
  return { cols: nextCols, rows: nextRows, changed: true };
}

async function bringSessionToFront() {
  throw new Error("Front is not supported for PTY-backed sessions.");
}

async function killSession(sessionId) {
  const session = requireSession(sessionId);
  const runtime = runtimeSessions.get(sessionId);

  if (runtime) {
    runtime.closed = true;
    try {
      runtime.process.kill();
    } catch (error) {
      appendLog("warn", `Failed to kill PTY for ${sessionId}: ${formatError(error)}`);
    }
    runtimeSessions.delete(sessionId);
    disposeRuntime(runtime);
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

function getManagedSessionSnapshot(sessionId, maxLines = SNAPSHOT_MAX_LINES) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime) {
    return null;
  }

  const screen = readTerminalScreen(runtime);
  const lines = screen.lines.slice(-maxLines);

  return {
    sessionId,
    activity: runtime.activity,
    cols: runtime.terminal.cols,
    rows: runtime.terminal.rows,
    isBusy: runtime.activity === "running",
    lastFinishedAt: runtime.lastFinishedAt,
    output: lines.join("\n"),
    runStartedAt: runtime.activity === "running" ? runtime.runStartedAt : 0,
    version: runtime.version,
    waitingForInput: runtime.waitingForInput
  };
}

/**
 * The folder a terminal is currently in, read from its last shell prompt (or
 * the cwd header Claude Code / Codex print). Falls back to the last folder we
 * saw, then the folder the session was started in.
 */
function getManagedSessionCwd(sessionId) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime) {
    return "";
  }

  const detected = detectCwdFromScreen(readTerminalScreen(runtime).lines);
  if (detected) {
    runtime.lastKnownCwd = detected;
  }
  return runtime.lastKnownCwd || runtime.initialCwd || process.cwd();
}

function getManagedSessionVersion(sessionId) {
  const runtime = runtimeSessions.get(sessionId);
  return runtime ? runtime.version : -1;
}

function getManagedSessionsStatus() {
  const statuses = [];

  for (const [sessionId, runtime] of runtimeSessions.entries()) {
    const screen = readTerminalScreen(runtime);
    const session = getSession(sessionId);
    statuses.push({
      id: sessionId,
      shell: session?.shell || "",
      activity: runtime.activity,
      isBusy: runtime.activity === "running",
      lastCommand: runtime.lastSubmittedCommand || "",
      lastFinishedAt: runtime.lastFinishedAt,
      lastEventKind: runtime.lastEventKind,
      lastLine: screen.lastLine.slice(0, 160),
      runStartedAt: runtime.activity === "running" ? runtime.runStartedAt : 0,
      version: runtime.version,
      waitingForInput: runtime.waitingForInput
    });
  }

  return statuses;
}

function getSessionEvents(sinceSeq = 0) {
  const since = Number(sinceSeq) || 0;
  return {
    events: sessionEvents.filter((event) => event.seq > since),
    seq: sessionEventSeq
  };
}

function onSessionEvent(listener) {
  sessionEventListeners.add(listener);
  return () => {
    sessionEventListeners.delete(listener);
  };
}

function markSessionSubmitted(runtime, commandText) {
  const now = Date.now();
  if (runtime.activity !== "running") {
    runtime.runStartedAt = now;
    runtime.sawBusyIndicator = false;
    runtime.interrupted = false;
  }

  runtime.activity = "running";
  runtime.submittedAt = now;
  runtime.waitingForInput = false;
  if (commandText) {
    runtime.lastSubmittedCommand = commandText.slice(0, 240);
  }
}

function evaluateSessionActivity(sessionId) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime || runtime.closed) {
    return;
  }

  const screen = readTerminalScreen(runtime);
  const now = Date.now();
  const quietMs = runtime.lastOutputAt > 0 ? now - runtime.lastOutputAt : Infinity;
  const busyIndicator = hasBusyIndicator(screen.viewportText);

  if (busyIndicator) {
    runtime.sawBusyIndicator = true;
    runtime.waitingForInput = false;
    if (runtime.activity !== "running") {
      // TUI tools (Codex, Claude Code...) can start working on their own.
      runtime.activity = "running";
      runtime.runStartedAt = now;
      runtime.submittedAt = now;
      runtime.interrupted = false;
    }
    return;
  }

  if (runtime.activity !== "running") {
    return;
  }

  const outputSinceSubmit = runtime.lastOutputAt > runtime.submittedAt;
  const sinceSubmitMs = now - runtime.submittedAt;
  const promptVisible = isShellPromptLine(screen.cursorLine) || isTuiIdlePrompt(screen);

  if (promptVisible && outputSinceSubmit && quietMs >= PROMPT_SETTLE_MS && sinceSubmitMs >= PROMPT_SETTLE_MS) {
    finishRun(sessionId, runtime, screen, runtime.interrupted ? "stopped" : "finished");
    return;
  }

  if (hasTuiInputMarker(screen.cursorLine) && outputSinceSubmit && quietMs >= TUI_IDLE_SETTLE_MS) {
    finishRun(sessionId, runtime, screen, runtime.interrupted ? "stopped" : "finished");
    return;
  }

  if (runtime.sawBusyIndicator && quietMs >= BUSY_INDICATOR_SETTLE_MS) {
    finishRun(sessionId, runtime, screen, runtime.interrupted ? "stopped" : "finished");
    return;
  }

  if (
    !runtime.waitingForInput &&
    outputSinceSubmit &&
    quietMs >= INPUT_WAIT_SETTLE_MS &&
    isInputRequestLine(screen.cursorLine)
  ) {
    runtime.waitingForInput = true;
    emitSessionEvent({
      sessionId,
      kind: "input",
      durationMs: now - runtime.runStartedAt,
      command: runtime.lastSubmittedCommand,
      summary: screen.cursorLine.trim().slice(0, 200)
    });
  }
}

function finishRun(sessionId, runtime, screen, kind) {
  const now = Date.now();
  const durationMs = runtime.runStartedAt ? now - runtime.runStartedAt : 0;
  runtime.activity = "idle";
  runtime.lastFinishedAt = now;
  runtime.lastEventKind = kind;
  runtime.waitingForInput = false;
  runtime.sawBusyIndicator = false;
  runtime.interrupted = false;
  runtime.isBusy = false;

  emitSessionEvent({
    sessionId,
    kind,
    durationMs,
    command: runtime.lastSubmittedCommand,
    summary: buildRunSummary(screen.lines)
  });
}

function emitSessionEvent(partialEvent) {
  sessionEventSeq += 1;
  const event = {
    ...partialEvent,
    at: Date.now(),
    seq: sessionEventSeq
  };
  sessionEvents.push(event);
  if (sessionEvents.length > MAX_SESSION_EVENTS) {
    sessionEvents.splice(0, sessionEvents.length - MAX_SESSION_EVENTS);
  }

  for (const listener of sessionEventListeners) {
    try {
      const result = listener(event);
      if (result && typeof result.catch === "function") {
        result.catch((error) => {
          appendLog("warn", `Session event listener failed: ${formatError(error)}`);
        });
      }
    } catch (error) {
      appendLog("warn", `Session event listener failed: ${formatError(error)}`);
    }
  }
}

function buildRunSummary(lines) {
  let startIndex = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isShellPromptWithCommand(lines[index]) || isTuiSubmittedPromptLine(lines[index])) {
      startIndex = index + 1;
      break;
    }
  }

  const meaningful = lines
    .slice(startIndex)
    .map((line) => line.trim())
    .filter((line) => line && !isShellPromptLine(line) && !isTerminalChromeLine(line))
    .map((line) => line.replace(/^[●•⏺]\s*/, ""));
  return meaningful.slice(-3).join(" · ").slice(0, 220);
}

function isTuiSubmittedPromptLine(line) {
  // "❯ fix the build" / "› explain this" - what the user sent to Codex / Claude Code.
  return /^\s*[│|]?\s*[›❯]\s+\S/.test(String(line || "")) && !/^\s*[›❯]\s+(Try "|Ask Codex)/.test(String(line || ""));
}

function isTerminalChromeLine(line) {
  const value = String(line || "").trim();
  return (
    /^[─━═│┃╭╮╰╯\s>›»❯]+$/.test(value) ||
    /^[⚠⏵✻✶✳✢·*]/.test(value) ||
    /^[›❯]\s+(Try "|Ask Codex)/.test(value) ||
    /\b(esc to interrupt|\? for shortcuts|shift\+tab to cycle|for agents)\b/i.test(value) ||
    /^gpt-[\w.-]+\s/i.test(value) ||
    /^(worked|brewed|cooked|churned|thought) for \d/i.test(value)
  );
}

function readTerminalScreen(runtime) {
  if (runtime.snapshotCache && runtime.snapshotCache.version === runtime.version) {
    return runtime.snapshotCache;
  }

  const buffer = runtime.terminal.buffer.active;
  const logicalLines = [];
  let cursorLogicalIndex = -1;
  const cursorAbsoluteY = buffer.baseY + buffer.cursorY;
  const viewportStart = buffer.baseY;
  const viewportLines = [];

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) {
      continue;
    }

    const text = line.translateToString(true);
    if (line.isWrapped && logicalLines.length > 0) {
      logicalLines[logicalLines.length - 1] += text;
    } else {
      logicalLines.push(text);
    }

    if (index === cursorAbsoluteY) {
      cursorLogicalIndex = logicalLines.length - 1;
    }

    if (index >= viewportStart) {
      viewportLines.push(text);
    }
  }

  let lastContentIndex = logicalLines.length - 1;
  while (lastContentIndex > cursorLogicalIndex && lastContentIndex >= 0 && !logicalLines[lastContentIndex].trim()) {
    lastContentIndex -= 1;
  }

  let firstContentIndex = 0;
  while (firstContentIndex < lastContentIndex && !logicalLines[firstContentIndex].trim()) {
    firstContentIndex += 1;
  }

  const lines = logicalLines
    .slice(firstContentIndex, lastContentIndex + 1)
    .map((line) => line.replace(/\s+$/g, ""));
  const cursorLine = cursorLogicalIndex >= 0 ? logicalLines[cursorLogicalIndex] || "" : "";
  // Last meaningful output line (skip the bare prompt) for tile previews.
  let lastLine = "";
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const candidate = lines[index].trim();
    if (candidate && !isShellPromptLine(candidate) && !isTerminalChromeLine(candidate)) {
      lastLine = isShellPromptWithCommand(candidate)
        ? `> ${candidate.replace(/^.*?>\s*/, "")}`
        : candidate.replace(/^[●•⏺]\s*/, "");
      break;
    }
  }

  runtime.snapshotCache = {
    version: runtime.version,
    lines,
    cursorLine,
    lastLine,
    viewportText: viewportLines.join("\n")
  };
  return runtime.snapshotCache;
}

function disposeRuntime(runtime) {
  if (!runtime) {
    return;
  }

  if (runtime.activityTimer) {
    clearInterval(runtime.activityTimer);
    runtime.activityTimer = null;
  }

  try {
    runtime.terminal.dispose();
  } catch {
    // ignore
  }
}

function hasBusyIndicator(viewportText) {
  const text = String(viewportText || "").toLowerCase();
  return (
    text.includes("esc to interrupt") ||
    text.includes("esc to cancel") ||
    /\bworking\d*\s*\(\d+s/.test(text)
  );
}

function isShellPromptLine(line) {
  const value = String(line || "").replace(/\s+$/g, "");
  return (
    /^(?:\([^)]*\)\s*)?ps\s+[^\n>]*>$/i.test(value) ||
    /^[a-z]:\\[^\n>]*>$/i.test(value) ||
    /^~\\[^\n>]*>$/i.test(value)
  );
}

function isShellPromptWithCommand(line) {
  const value = String(line || "").trim();
  return /^(?:\([^)]*\)\s*)?ps\s+[a-z~][^>]*>\s*\S/i.test(value) || /^[a-z]:\\[^>]*>\s*\S/i.test(value);
}

function hasTuiInputMarker(cursorLine) {
  // Codex ("› Ask Codex...") and Claude Code ("❯ Try ...") park the cursor on
  // their input line whenever they are waiting for you.
  return /^\s*[│|]?\s*[›❯](?:\s|$)/.test(String(cursorLine || ""));
}

function isTuiIdlePrompt(screen) {
  // Codex / Claude Code show an empty input marker when idle.
  const cursorLine = String(screen.cursorLine || "").trim();
  return /^[│|]?\s*[>›»❯]\s*[│|]?$/.test(cursorLine);
}

function isInputRequestLine(line) {
  const value = String(line || "").trim();
  if (!value || isShellPromptLine(value)) {
    return false;
  }

  return (
    /\?\s*$/.test(value) ||
    /:\s*$/.test(value) ||
    /\[(?:y\/n|yes\/no)\]/i.test(value) ||
    /\((?:y\/n|yes\/no)\)/i.test(value) ||
    /press (?:enter|any key)/i.test(value)
  );
}

function resolveWindowsPtyOptions() {
  if (process.platform !== "win32") {
    return undefined;
  }

  const buildNumber = Number(String(require("node:os").release()).split(".")[2]) || undefined;
  return { backend: "conpty", buildNumber };
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.max(min, Math.min(parsed, max));
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
  runtime.isBusy = detectBusyState(runtime.recentOutput);

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
  const tail = compact.slice(-1600);

  if (hasInteractivePrompt(tail) || hasCompletionFooter(tail)) {
    return false;
  }

  // Codex TUI: › prompt after the last "esc to interrupt" means session returned to idle
  const lastEscIdx = tail.lastIndexOf("esc to interrupt");
  if (lastEscIdx >= 0 && /(?:^|\n)\s*[›»❯]/.test(tail.slice(lastEscIdx))) {
    return false;
  }

  return (
    tail.includes("esc to interrupt") ||
    /\bworking\d*\s*\(\d+s/.test(tail) ||
    /^working\d*$/m.test(tail)
  );
}

function isCodexNoiseLine(value) {
  const normalized = value.trim().toLowerCase();
  return (
    isCodexCliStatusLine(normalized) ||
    /^explain this codebase$/.test(normalized) ||
    /^improve documentation in @filename$/.test(normalized) ||
    /^if the speaker says\b/.test(normalized) ||
    /\breturn hello\b/.test(normalized) ||
    /\btranscribe exactly\b/.test(normalized) ||
    /^tip:\s+/i.test(normalized) ||
    /^\[features\]\.collab/i.test(normalized) ||
    /^enable it with /i.test(normalized) ||
    /^https:\/\/developers\.openai\.com/i.test(normalized) ||
    /^heads up,/i.test(normalized) ||
    /^token usage:\s+total=/i.test(normalized) ||
    /^to continue this session,\s+run codex resume /i.test(normalized)
  );
}

function hasCompletionFooter(value) {
  return /token usage:\s+total=/i.test(value) || /to continue this session,\s+run codex resume /i.test(value);
}

function hasInteractivePrompt(value) {
  return (
    /(?:^|\n)(?:ps\s+)?[a-z]:\\[^\n>]*>\s*$/im.test(value) ||
    /(?:^|\n)~\\[^\n>]*>\s*$/im.test(value) ||
    /(?:^|\n)\s*[>›»❯]\s*$/m.test(value)
  );
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
  getManagedSessionCwd,
  getManagedSessionSnapshot,
  getManagedSessionsStatus,
  getManagedSessionVersion,
  getSessionEvents,
  onSessionEvent,
  resizeSession,
  sendKeyToSession,
  sendCommandToSession,
  sendTextToSession
};
