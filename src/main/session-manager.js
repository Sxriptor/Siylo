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

async function createManagedSession(shell) {
  const normalizedShell = shell.toLowerCase();
  if (!["cmd", "powershell"].includes(normalizedShell)) {
    throw new Error(`Managed sessions are only supported for cmd and powershell. Received: ${shell}`);
  }

  const sessionId = getNextSessionId(normalizedShell);
  const executable = normalizedShell === "cmd" ? "cmd.exe" : "powershell.exe";
  const args = normalizedShell === "cmd" ? [] : ["-NoLogo"];
  const ptyProcess = pty.spawn(executable, args, {
    name: "xterm-color",
    cwd: process.cwd(),
    env: process.env,
    cols: 120,
    rows: 30
  });

  const session = addSession({
    id: sessionId,
    shell: normalizedShell,
    status: "active",
    lastCommand: `open ${normalizedShell}`,
    pid: ptyProcess.pid
  });

  runtimeSessions.set(sessionId, {
    process: ptyProcess,
    pendingOutput: "",
    closed: false
  });

  ptyProcess.onData((data) => {
    const runtime = runtimeSessions.get(sessionId);
    if (!runtime) {
      return;
    }

    runtime.pendingOutput = `${runtime.pendingOutput}${stripAnsi(data)}`.slice(-24000);
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

  appendLog("info", `Managed PTY session created: ${session.id} (PID ${ptyProcess.pid}).`);
  return session;
}

async function sendCommandToSession(sessionId, commandText) {
  const session = requireSession(sessionId);
  const runtime = requireRuntimeSession(sessionId);

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
  return getStateSnapshot().sessions.filter((session) =>
    ["cmd", "powershell"].includes(session.shell.toLowerCase())
  );
}

function drainPendingOutput(sessionId, maxLength = 1600) {
  const runtime = runtimeSessions.get(sessionId);
  if (!runtime || !runtime.pendingOutput) {
    return "";
  }

  const output = runtime.pendingOutput.slice(-maxLength);
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

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b][^\u0007]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f]/g,
    ""
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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
  sendCommandToSession
};
