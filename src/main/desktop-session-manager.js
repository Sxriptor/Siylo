const { spawn } = require("node:child_process");
const {
  addSession,
  getSession,
  removeSession,
  updateSession
} = require("./state");

const desktopSessions = new Map();

const desktopLaunchMap = {
  browser: {
    shellLabel: "browser",
    launchCommand: "start \"\" https://127.0.0.1"
  },
  cursor: {
    shellLabel: "cursor",
    launchCommand: "start \"\" cursor"
  },
  kiro: {
    shellLabel: "kiro",
    launchCommand: "start \"\" kiro"
  },
  vscode: {
    shellLabel: "vscode",
    launchCommand: "start \"\" code"
  }
};

function isDesktopTarget(target) {
  return Boolean(desktopLaunchMap[normalizeDesktopTarget(target)]);
}

function normalizeDesktopTarget(target) {
  const normalizedTarget = String(target || "").trim().toLowerCase();
  if (!normalizedTarget) {
    return "";
  }

  if (normalizedTarget === "chrome" || normalizedTarget === "edge") {
    return "browser";
  }

  if (normalizedTarget === "code") {
    return "vscode";
  }

  return normalizedTarget;
}

async function openDesktopSession(target) {
  const normalizedTarget = normalizeDesktopTarget(target);
  const targetConfig = desktopLaunchMap[normalizedTarget];
  if (!targetConfig) {
    throw new Error(`Unsupported desktop session target: ${target}`);
  }

  const existingSession = getSession(normalizedTarget);
  if (desktopSessions.has(normalizedTarget) && existingSession) {
    return existingSession;
  }

  const pid = await launchDetached(targetConfig.launchCommand);
  const currentSession = getSession(normalizedTarget);
  const nextSession =
    updateSession(normalizedTarget, {
      shell: targetConfig.shellLabel,
      status: "active",
      lastCommand: `open ${normalizedTarget}`,
      pid
    }) ||
    addSession({
      id: normalizedTarget,
      shell: targetConfig.shellLabel,
      status: "active",
      lastCommand: `open ${normalizedTarget}`,
      pid
    });

  desktopSessions.set(normalizedTarget, {
    pid,
    target: normalizedTarget
  });

  await delay(900);
  return nextSession;
}

async function sendTextToDesktopSession(sessionId, text, options = {}) {
  const normalizedSessionId = normalizeDesktopTarget(sessionId);
  const session = requireDesktopSession(normalizedSessionId);
  const runtime = requireDesktopRuntime(normalizedSessionId);
  const keystrokes = escapeSendKeysText(text);

  await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$ws = New-Object -ComObject WScript.Shell",
    `if (-not [Microsoft.VisualBasic.Interaction]::AppActivate(${runtime.pid})) { throw 'Could not focus target window.' }`,
    "Start-Sleep -Milliseconds 250",
    `$ws.SendKeys('${keystrokes}')`,
    options.pressEnter === false ? "" : "$ws.SendKeys('{ENTER}')"
  ].filter(Boolean).join("; "));

  return (
    updateSession(normalizedSessionId, {
      status: "active",
      lastCommand: text
    }) || session
  );
}

async function sendKeyToDesktopSession(sessionId, keyName) {
  const normalizedSessionId = normalizeDesktopTarget(sessionId);
  const session = requireDesktopSession(normalizedSessionId);
  const runtime = requireDesktopRuntime(normalizedSessionId);
  const keyValue = normalizeDesktopKey(keyName);

  await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    "$ws = New-Object -ComObject WScript.Shell",
    `if (-not [Microsoft.VisualBasic.Interaction]::AppActivate(${runtime.pid})) { throw 'Could not focus target window.' }`,
    "Start-Sleep -Milliseconds 200",
    `$ws.SendKeys('${keyValue}')`
  ].join("; "));

  return (
    updateSession(normalizedSessionId, {
      status: "active",
      lastCommand: String(keyName || "").toLowerCase()
    }) || session
  );
}

async function bringDesktopSessionToFront(sessionId) {
  const normalizedSessionId = normalizeDesktopTarget(sessionId);
  const runtime = requireDesktopRuntime(normalizedSessionId);

  await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName Microsoft.VisualBasic",
    `if (-not [Microsoft.VisualBasic.Interaction]::AppActivate(${runtime.pid})) { throw 'Could not focus target window.' }`
  ].join("; "));
}

async function killDesktopSession(sessionId) {
  const normalizedSessionId = normalizeDesktopTarget(sessionId);
  const session = requireDesktopSession(normalizedSessionId);
  const runtime = desktopSessions.get(normalizedSessionId);

  if (runtime?.pid) {
    await runPowerShell(`Stop-Process -Id ${runtime.pid} -Force -ErrorAction Stop`);
  }

  desktopSessions.delete(normalizedSessionId);
  removeSession(normalizedSessionId);
  return session;
}

function hasDesktopSession(sessionId) {
  return desktopSessions.has(normalizeDesktopTarget(sessionId));
}

function requireDesktopSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Desktop session not found: ${sessionId}`);
  }

  return session;
}

function requireDesktopRuntime(sessionId) {
  const runtime = desktopSessions.get(sessionId);
  if (!runtime) {
    throw new Error(`Desktop runtime not found for ${sessionId}`);
  }

  return runtime;
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
      const pid = child.pid;
      child.unref();
      resolve(pid);
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

function escapeSendKeysText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("")
    .map((character) => {
      const escapedCharacter = sendKeysEscapeMap[character];
      if (escapedCharacter) {
        return escapedCharacter;
      }

      if (character === "\n") {
        return "{ENTER}";
      }

      if (character === "'") {
        return "''";
      }

      return character;
    })
    .join("");
}

function normalizeDesktopKey(keyName) {
  const normalizedKey = String(keyName || "").trim().toLowerCase();
  if (!normalizedKey) {
    throw new Error("Key command cannot be empty.");
  }

  const keyMap = {
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    down: "{DOWN}",
    enter: "{ENTER}",
    esc: "{ESC}",
    escape: "{ESC}",
    left: "{LEFT}",
    return: "{ENTER}",
    right: "{RIGHT}",
    space: " ",
    tab: "{TAB}",
    up: "{UP}",
    "ctrl+c": "^c",
    "ctrl+l": "^l",
    "ctrl+shift+p": "^+p"
  };

  if (keyMap[normalizedKey]) {
    return keyMap[normalizedKey];
  }

  if (normalizedKey.length === 1) {
    return escapeSendKeysText(normalizedKey);
  }

  throw new Error(`Unsupported desktop key command: ${keyName}`);
}

const sendKeysEscapeMap = {
  "%": "{%}",
  "(": "{(}",
  ")": "{)}",
  "+": "{+}",
  "^": "{^}",
  "[": "{[}",
  "]": "{]}",
  "{": "{{}",
  "}": "{}}",
  "~": "{~}"
};

module.exports = {
  bringDesktopSessionToFront,
  hasDesktopSession,
  isDesktopTarget,
  killDesktopSession,
  normalizeDesktopTarget,
  openDesktopSession,
  sendKeyToDesktopSession,
  sendTextToDesktopSession
};
