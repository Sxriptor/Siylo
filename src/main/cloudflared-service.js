const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { appendLog, setRemoteAccessState } = require("./state");

const defaultTunnelName = "siylo-radio";
const startupGraceMs = 1200;
const cloudflaredCandidates = [
  process.env.CLOUDFLARED_PATH || "",
  "C:\\Program Files\\cloudflared\\cloudflared.exe",
  "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe"
];

let tunnelProcess = null;
let tunnelName = defaultTunnelName;

async function startCloudflaredTunnel(options = {}) {
  if (tunnelProcess) {
    return {
      pid: tunnelProcess.pid,
      tunnelName
    };
  }

  tunnelName = String(options.tunnelName || defaultTunnelName).trim() || defaultTunnelName;
  const executablePath = resolveCloudflaredExecutable();

  const pid = await spawnCloudflaredTerminal(executablePath, tunnelName);
  tunnelProcess = {
    pid,
    monitorId: null
  };
  await delay(startupGraceMs);
  const isRunning = await processExists(pid);
  if (!isRunning) {
    tunnelProcess = null;
    throw new Error("Cloudflared terminal exited too quickly.");
  }

  tunnelProcess.monitorId = setInterval(() => {
    processExists(pid)
      .then((stillRunning) => {
        if (stillRunning || !tunnelProcess || tunnelProcess.pid !== pid) {
          return;
        }

        clearInterval(tunnelProcess.monitorId);
        tunnelProcess = null;
        setRemoteAccessState({
          status: "stopped",
          lastError: "Cloudflared tunnel terminal exited."
        });
        appendLog("info", `Cloudflared tunnel terminal exited (PID ${pid}).`);
      })
      .catch(() => {});
  }, 3000);

  appendLog(
    "info",
    `Cloudflared tunnel started in cmd.exe for tunnel ${tunnelName} (PID ${pid}) using ${executablePath}.`
  );
  return {
    pid,
    tunnelName
  };
}

async function stopCloudflaredTunnel() {
  if (!tunnelProcess) {
    tunnelProcess = null;
    return false;
  }

  const pid = tunnelProcess.pid;
  clearInterval(tunnelProcess.monitorId);
  await killProcessTree(pid);
  appendLog("info", `Cloudflared tunnel terminal stopped (PID ${pid}).`);
  tunnelProcess = null;
  return true;
}

function isCloudflaredTunnelRunning() {
  return Boolean(tunnelProcess);
}

function spawnCloudflaredTerminal(executablePath, tunnelNameToRun) {
  return new Promise((resolve, reject) => {
    const escapedTunnelName = String(tunnelNameToRun).replace(/'/g, "''");
    const escapedExecutablePath = String(executablePath).replace(/'/g, "''");
    const launcher = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', '"${escapedExecutablePath}" tunnel run ${escapedTunnelName}') -PassThru -WorkingDirectory '${process.cwd().replace(/'/g, "''")}'; Write-Output $process.Id`
      ],
      {
        cwd: process.cwd(),
        shell: false,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
      }
    );

    let stdout = "";
    let stderr = "";

    launcher.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    launcher.once("error", reject);
    launcher.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell launcher exited with code ${code}.`));
        return;
      }

      const pid = Number(stdout.trim().split(/\s+/).pop());
      if (!Number.isInteger(pid) || pid <= 0) {
        reject(new Error(`Failed to capture cloudflared terminal PID. Output: ${stdout.trim() || "[empty]"}`));
        return;
      }

      resolve(pid);
    });
  });
}

function resolveCloudflaredExecutable() {
  for (const candidate of cloudflaredCandidates) {
    const normalizedCandidate = String(candidate || "").trim();
    if (normalizedCandidate && fs.existsSync(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }

  throw new Error(
    "cloudflared.exe was not found. Install Cloudflare Tunnel or set CLOUDFLARED_PATH to the executable."
  );
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function killProcessTree(pid) {
  return new Promise((resolve, reject) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });

    killer.once("error", reject);
    killer.once("close", (code) => {
      if (code === 0 || code === 128 || code === 255) {
        resolve();
        return;
      }

      reject(new Error(`taskkill exited with code ${code}.`));
    });
  });
}

function processExists(pid) {
  return new Promise((resolve, reject) => {
    const checker = spawn("tasklist", ["/FI", `PID eq ${pid}`], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    });

    let stdout = "";
    checker.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    checker.once("error", reject);
    checker.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`tasklist exited with code ${code}.`));
        return;
      }

      resolve(stdout.includes(String(pid)));
    });
  });
}

module.exports = {
  isCloudflaredTunnelRunning,
  startCloudflaredTunnel,
  stopCloudflaredTunnel
};
