const { spawn } = require("node:child_process");
const screenshot = require("screenshot-desktop");

async function captureDesktopFrame(options = {}) {
  const format = normalizeImageFormat(options.format);
  const imageBuffer = await screenshot({ format });
  const screen = await getPrimaryScreenMetrics().catch(() => ({
    width: 0,
    height: 0
  }));

  return {
    contentType: format === "jpg" ? "image/jpeg" : "image/png",
    imageBuffer,
    screen
  };
}

async function moveDesktopPointer({ x, y, click = false }) {
  const nextX = clampCoordinate(x);
  const nextY = clampCoordinate(y);

  await runPowerShell([
    "$ErrorActionPreference = 'Stop'",
    "$typeDefinition = 'using System; using System.Runtime.InteropServices; public static class MouseControl { [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\"user32.dll\")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize); [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public MOUSEINPUT mi; } [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; } public static void LeftClick() { INPUT[] inputs = new INPUT[2]; inputs[0].type = 0; inputs[0].mi.dwFlags = 0x0002; inputs[1].type = 0; inputs[1].mi.dwFlags = 0x0004; SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))); } }'",
    "Add-Type -TypeDefinition $typeDefinition",
    `[MouseControl]::SetCursorPos(${nextX}, ${nextY}) | Out-Null`,
    click ? "Start-Sleep -Milliseconds 60" : "",
    click ? "[MouseControl]::LeftClick()" : ""
  ].filter(Boolean).join("; "));

  return {
    status: "ok",
    x: nextX,
    y: nextY
  };
}

function getPrimaryScreenMetrics() {
  return runPowerShell([
    "Add-Type -AssemblyName System.Windows.Forms",
    "$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    "[Console]::Out.Write(\"$($screen.Width),$($screen.Height)\")"
  ].join("; ")).then((output) => {
    const [width, height] = output.split(",").map((value) => Number(value));

    return {
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0
    };
  });
}

function clampCoordinate(value) {
  const parsedValue = Math.round(Number(value));
  if (!Number.isFinite(parsedValue)) {
    return 0;
  }

  return Math.max(0, Math.min(parsedValue, 32767));
}

function normalizeImageFormat(format) {
  const normalizedFormat = String(format || "").trim().toLowerCase();
  return normalizedFormat === "jpg" || normalizedFormat === "jpeg" ? "jpg" : "png";
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }

      reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
    });
  });
}

module.exports = {
  captureDesktopFrame,
  getPrimaryScreenMetrics,
  moveDesktopPointer
};
