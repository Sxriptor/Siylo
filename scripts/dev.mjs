import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import net from "node:net";

const rendererUrl = "http://127.0.0.1:3000";
const nextBin = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "next.cmd" : "next"
);
const electronBin = path.resolve(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "electron.cmd" : "electron"
);

const children = [];
let shuttingDown = false;

function run(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: process.cwd(),
    shell: process.platform === "win32",
    env: {
      ...process.env,
      ...extraEnv
    }
  });

  children.push(child);
  child.on("exit", (code) => {
    if (!shuttingDown && code && code !== 0) {
      shutdown(code);
    }
  });

  return child;
}

function waitForPort(port, host = "127.0.0.1", timeoutMs = 30000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host });

      socket.once("connect", () => {
        socket.end();
        resolve();
      });

      socket.once("error", () => {
        socket.destroy();

        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }

        setTimeout(attempt, 400);
      });
    };

    attempt();
  });
}

function shutdown(code = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  for (const child of children) {
    if (!child.killed) {
      child.kill();
    }
  }

  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run(nextBin, ["dev", "--hostname", "127.0.0.1", "--port", "3000"]);

try {
  await waitForPort(3000);
  const electron = run(electronBin, ["."], {
    NODE_ENV: "development",
    SIYLO_RENDERER_URL: rendererUrl
  });

  electron.on("exit", () => shutdown(0));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  shutdown(1);
}
