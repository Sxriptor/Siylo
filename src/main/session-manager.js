const { spawn } = require("node:child_process");
const {
  addSession,
  appendLog,
  getSession,
  getStateSnapshot,
  removeSession,
  updateSession
} = require("./state");

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
  const windowTitle = `Siylo-${sessionId}`;

  const script =
    normalizedShell === "cmd"
      ? `$p = Start-Process cmd.exe -ArgumentList '/k title ${escapeSingleQuoted(windowTitle)}' -PassThru -WindowStyle Normal; $p.Id`
      : `$p = Start-Process powershell.exe -ArgumentList '-NoExit','-Command',\"$host.UI.RawUI.WindowTitle = '${escapePowerShellSingleQuoted(
          windowTitle
        )}'\" -PassThru -WindowStyle Normal; $p.Id`;

  const pidOutput = await runPowerShell(script);
  const pid = Number.parseInt(pidOutput.trim(), 10);

  if (!Number.isFinite(pid)) {
    throw new Error(`Could not determine process id for ${sessionId}.`);
  }

  const session = addSession({
    id: sessionId,
    shell: normalizedShell,
    status: "idle",
    lastCommand: `open ${normalizedShell}`,
    pid,
    windowTitle
  });

  appendLog("info", `Managed session created: ${session.id} (PID ${pid}).`);
  return session;
}

async function sendCommandToSession(sessionId, commandText) {
  const session = requireSession(sessionId);

  const escapedKeys = escapeSendKeys(commandText);
  const script = [
    "$wshell = New-Object -ComObject WScript.Shell",
    buildActivationScript(session),
    "Start-Sleep -Milliseconds 200",
    `$wshell.SendKeys('${escapePowerShellSingleQuoted(escapedKeys)}')`,
    "Start-Sleep -Milliseconds 100",
    "$wshell.SendKeys('{ENTER}')",
    "Start-Sleep -Milliseconds 700",
    buildForegroundWindowInfoScript()
  ].join("; ");

  const windowInfo = parseWindowInfo(await runPowerShell(script));
  return (
    updateSession(sessionId, {
      status: "active",
      lastCommand: commandText,
      pid: windowInfo.pid || session.pid,
      windowTitle: windowInfo.title || session.windowTitle
    }) || session
  );
}

async function bringSessionToFront(sessionId) {
  const session = requireSession(sessionId);

  const script = [
    "$wshell = New-Object -ComObject WScript.Shell",
    buildActivationScript(session),
    "Start-Sleep -Milliseconds 250",
    buildForegroundWindowInfoScript()
  ].join("; ");

  const windowInfo = parseWindowInfo(await runPowerShell(script));
  return (
    updateSession(sessionId, {
      status: "active",
      pid: windowInfo.pid || session.pid,
      windowTitle: windowInfo.title || session.windowTitle
    }) || session
  );
}

async function killSession(sessionId) {
  const session = requireSession(sessionId);
  const pid = session.pid;

  if (!pid) {
    removeSession(sessionId);
    return session;
  }

  await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
  removeSession(sessionId);
  appendLog("info", `Managed session killed: ${sessionId}.`);
  return session;
}

async function killAllManagedSessions() {
  const sessions = getStateSnapshot().sessions.filter((session) =>
    ["cmd", "powershell"].includes(session.shell.toLowerCase())
  );

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

function requireSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return session;
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || stdout.trim() || `PowerShell exited with code ${code}`));
    });
  });
}

function buildActivationScript(session) {
  const attempts = [];

  if (session.pid) {
    attempts.push(`$ok = $wshell.AppActivate(${session.pid})`);
  }

  if (session.windowTitle) {
    attempts.push(`if (-not $ok) { $ok = $wshell.AppActivate('${escapePowerShellSingleQuoted(session.windowTitle)}') }`);
  }

  attempts.push("if (-not $ok) { throw 'Session window could not be activated.' }");
  return attempts.join("; ");
}

function buildForegroundWindowInfoScript() {
  return [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; using System.Text; public static class SiyloWindowInfo { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid); [DllImport(\"user32.dll\", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count); }'",
    "$hwnd = [SiyloWindowInfo]::GetForegroundWindow()",
    "$activePid = 0",
    "[SiyloWindowInfo]::GetWindowThreadProcessId($hwnd, [ref]$activePid) | Out-Null",
    "$titleBuilder = New-Object System.Text.StringBuilder 1024",
    "[SiyloWindowInfo]::GetWindowText($hwnd, $titleBuilder, $titleBuilder.Capacity) | Out-Null",
    "Write-Output ('SIYLO_WINDOW|' + $activePid + '|' + $titleBuilder.ToString())"
  ].join("; ");
}

function parseWindowInfo(output) {
  const markerLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("SIYLO_WINDOW|"));

  if (!markerLine) {
    return {
      pid: null,
      title: ""
    };
  }

  const [, pidValue, ...titleParts] = markerLine.split("|");
  const pid = Number.parseInt(pidValue, 10);

  return {
    pid: Number.isFinite(pid) ? pid : null,
    title: titleParts.join("|").trim()
  };
}

function escapeSingleQuoted(value) {
  return value.replace(/'/g, "''");
}

function escapePowerShellSingleQuoted(value) {
  return value.replace(/'/g, "''");
}

function escapeSendKeys(value) {
  return value.replace(/[+^%~(){}[\]]/g, "{$&}");
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
  killAllManagedSessions,
  killSession,
  listManagedSessions,
  sendCommandToSession
};
