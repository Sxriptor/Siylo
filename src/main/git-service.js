// Git + file browsing for a terminal session's working folder.
//
// Every command runs as its own hidden background process (`git ...` with the
// session's folder as cwd), never through the session's own terminal, so it is
// safe to use while Claude/Codex is busy in that terminal.

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const GIT_TIMEOUT_MS = 30_000;
const NETWORK_TIMEOUT_MS = 120_000;
const MAX_DIFF_BYTES = 400_000;
const MAX_FILE_BYTES = 400_000;
const MAX_DIR_ENTRIES = 2000;
const LOG_LIMIT = 200;

// One queue per repository so index-writing commands never race (index.lock).
const repoQueues = new Map();

function runGit(cwd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeout || GIT_TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          // Fail instead of hanging on an invisible credential/editor prompt.
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_PAGER: "cat",
          // Read-only commands (status/log) must not grab index.lock while the
          // terminal's own git (or Claude) is working.
          GIT_OPTIONAL_LOCKS: options.write ? "1" : "0",
          LC_ALL: "C"
        }
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          timedOut: Boolean(error && error.killed)
        });
      }
    );
  });
}

function enqueue(key, task) {
  const previous = repoQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const cleanup = () => {
    if (repoQueues.get(key) === tail) {
      repoQueues.delete(key);
    }
  };
  // The stored tail never rejects; the caller still gets `next`'s error.
  const tail = next.then(cleanup, cleanup);
  repoQueues.set(key, tail);
  return next;
}

function expandHome(value) {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~\\") || value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isDirectory(candidate) {
  try {
    return Boolean(candidate) && fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Best guess at the folder a terminal is "in", read from what it has printed:
 * the last shell prompt (PS C:\x> / C:\x>) or the cwd line Claude Code / Codex
 * show in their header.
 */
function detectCwdFromScreen(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = String(lines[index] || "");
    const candidates = [];

    const psMatch = line.match(/^(?:\([^)]*\)\s*)?PS ([A-Za-z]:\\[^>]*|~[^>]*|\\\\[^>]+)>/);
    if (psMatch) candidates.push(psMatch[1]);

    const cmdMatch = line.match(/^([A-Za-z]:\\[^>]*)>/);
    if (cmdMatch) candidates.push(cmdMatch[1]);

    const headerMatch = line.match(/^[\s│|]*(?:cwd|directory):\s+(.+?)\s*[│|]?\s*$/i);
    if (headerMatch) candidates.push(headerMatch[1]);

    for (const candidate of candidates) {
      const resolved = expandHome(candidate.trim());
      if (isDirectory(resolved)) {
        return path.resolve(resolved);
      }
    }
  }

  return "";
}

async function resolveRepo(cwd) {
  const result = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) {
    return { cwd, root: "", isRepo: false };
  }
  return { cwd, root: path.resolve(result.stdout.trim()), isRepo: true };
}

/** Resolve a client-supplied relative path, refusing anything outside `base`. */
function resolveInside(base, relativePath = "") {
  const target = path.resolve(base, String(relativePath || "").replace(/^[/\\]+/, ""));
  const relative = path.relative(base, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Path is outside the project folder."), { statusCode: 400 });
  }
  return target;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function parseStatus(stdout) {
  // `git status --porcelain=v1 -b -z`
  const records = stdout.split("\0");
  let branch = { name: "", upstream: "", ahead: 0, behind: 0, detached: false, noCommits: false };
  const files = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;

    if (record.startsWith("## ")) {
      const header = record.slice(3);
      const noCommits = header.match(/^No commits yet on (.+)$/);
      if (noCommits) {
        branch = { ...branch, name: noCommits[1], noCommits: true };
        continue;
      }
      if (header.startsWith("HEAD (no branch)")) {
        branch = { ...branch, name: "HEAD", detached: true };
        continue;
      }
      const match = header.match(/^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/);
      if (match) {
        const tracking = match[3] || "";
        branch = {
          ...branch,
          name: match[1],
          upstream: match[2] || "",
          ahead: Number((tracking.match(/ahead (\d+)/) || [])[1] || 0),
          behind: Number((tracking.match(/behind (\d+)/) || [])[1] || 0)
        };
      }
      continue;
    }

    const x = record[0];
    const y = record[1];
    const filePath = record.slice(3);
    let originalPath = "";
    if (x === "R" || x === "C") {
      originalPath = records[index + 1] || "";
      index += 1;
    }

    files.push({ path: filePath, originalPath, index: x, worktree: y });
  }

  const conflictCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
  const staged = [];
  const unstaged = [];
  const conflicted = [];

  for (const file of files) {
    const pair = `${file.index}${file.worktree}`;
    if (conflictCodes.has(pair)) {
      conflicted.push({ path: file.path, status: "U" });
      continue;
    }
    if (pair === "??") {
      unstaged.push({ path: file.path, status: "U", untracked: true });
      continue;
    }
    if (file.index !== " " && file.index !== "?") {
      staged.push({ path: file.path, originalPath: file.originalPath, status: file.index });
    }
    if (file.worktree !== " " && file.worktree !== "?") {
      unstaged.push({ path: file.path, status: file.worktree });
    }
  }

  return { branch, staged, unstaged, conflicted };
}

async function getStatus(cwd) {
  const repo = await resolveRepo(cwd);
  if (!repo.isRepo) {
    return { ...repo, branch: null, staged: [], unstaged: [], conflicted: [], remotes: [] };
  }

  const [status, remotes, lastCommit] = await Promise.all([
    runGit(repo.root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]),
    runGit(repo.root, ["remote"]),
    runGit(repo.root, ["log", "-1", "--format=%h%x1f%s%x1f%ar"])
  ]);

  if (!status.ok) {
    throw new Error(status.stderr.trim() || "git status failed.");
  }

  const [hash, subject, when] = lastCommit.ok ? lastCommit.stdout.trim().split("\x1f") : [];

  return {
    ...repo,
    ...parseStatus(status.stdout),
    remotes: remotes.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean),
    lastCommit: hash ? { hash, subject, when } : null
  };
}

async function getLog(cwd, options = {}) {
  const repo = await resolveRepo(cwd);
  if (!repo.isRepo) {
    return { ...repo, rows: [] };
  }

  const scope = options.all ? ["--all"] : ["HEAD", "--branches", "--remotes", "--tags"];
  const result = await runGit(repo.root, [
    "log",
    "--graph",
    "--date-order",
    `-n${Math.min(Number(options.limit) || LOG_LIMIT, 1000)}`,
    "--format=%x1e%H%x1f%h%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s",
    ...scope,
    "--"
  ]);

  if (!result.ok) {
    // A repo with no commits yet has no HEAD to log.
    if (/does not have any commits|unknown revision|bad (default )?revision/i.test(result.stderr)) {
      return { ...repo, rows: [] };
    }
    throw new Error(result.stderr.trim() || "git log failed.");
  }

  const rows = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const marker = line.indexOf("\x1e");
    if (marker < 0) {
      rows.push({ graph: line.replace(/\s+$/, ""), commit: null });
      continue;
    }
    const [hash, shortHash, parents, author, timestamp, refs, subject] = line.slice(marker + 1).split("\x1f");
    rows.push({
      graph: line.slice(0, marker).replace(/\s+$/, ""),
      commit: {
        hash,
        shortHash,
        parents: parents ? parents.split(" ") : [],
        author,
        timestamp: Number(timestamp) * 1000,
        refs: refs ? refs.split(", ").filter(Boolean) : [],
        subject
      }
    });
  }

  return { ...repo, rows };
}

async function getCommit(cwd, hash) {
  if (!/^[0-9a-f]{4,64}$/i.test(String(hash || ""))) {
    throw Object.assign(new Error("Invalid commit hash."), { statusCode: 400 });
  }
  const repo = await resolveRepo(cwd);
  if (!repo.isRepo) {
    throw Object.assign(new Error("Not a git repository."), { statusCode: 400 });
  }

  const [meta, files] = await Promise.all([
    runGit(repo.root, ["show", "-s", "--format=%H%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%P%x1f%B", hash]),
    runGit(repo.root, ["show", "--format=", "--numstat", "-z", "--find-renames", hash])
  ]);
  const nameStatus = await runGit(repo.root, ["show", "--format=", "--name-status", "-z", "--find-renames", hash]);

  if (!meta.ok) {
    throw new Error(meta.stderr.trim() || "git show failed.");
  }

  const [fullHash, author, email, timestamp, refs, parents, ...bodyParts] = meta.stdout.split("\x1f");
  const statusByPath = new Map();
  const statusRecords = nameStatus.stdout.split("\0").filter(Boolean);
  for (let index = 0; index < statusRecords.length; index += 1) {
    const code = statusRecords[index];
    if (/^[RC]/.test(code)) {
      statusByPath.set(statusRecords[index + 2], code[0]);
      index += 2;
    } else {
      statusByPath.set(statusRecords[index + 1], code[0]);
      index += 1;
    }
  }

  const changed = [];
  const numRecords = files.stdout.split("\0");
  for (let index = 0; index < numRecords.length; index += 1) {
    const record = numRecords[index];
    if (!record) continue;
    const [added, removed, filePath] = record.split("\t");
    let resolvedPath = filePath;
    if (filePath === "" && numRecords[index + 2] !== undefined) {
      // rename: "a\tb\t" then old\0new\0
      resolvedPath = numRecords[index + 2];
      index += 2;
    }
    if (!resolvedPath) continue;
    changed.push({
      path: resolvedPath,
      added: added === "-" ? null : Number(added),
      removed: removed === "-" ? null : Number(removed),
      status: statusByPath.get(resolvedPath) || "M"
    });
  }

  return {
    ...repo,
    commit: {
      hash: fullHash,
      author,
      email,
      timestamp: Number(timestamp) * 1000,
      refs: refs ? refs.split(", ").filter(Boolean) : [],
      parents: parents ? parents.split(" ") : [],
      message: bodyParts.join("\x1f").trim()
    },
    files: changed
  };
}

function truncate(text, limit) {
  if (Buffer.byteLength(text, "utf8") <= limit) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, limit), truncated: true };
}

async function getDiff(cwd, options = {}) {
  const repo = await resolveRepo(cwd);
  if (!repo.isRepo) {
    throw Object.assign(new Error("Not a git repository."), { statusCode: 400 });
  }
  const filePath = String(options.path || "");
  resolveInside(repo.root, filePath);

  let result;
  if (options.commit) {
    if (!/^[0-9a-f]{4,64}$/i.test(String(options.commit))) {
      throw Object.assign(new Error("Invalid commit hash."), { statusCode: 400 });
    }
    result = await runGit(repo.root, ["show", "--format=", "--find-renames", options.commit, "--", filePath]);
  } else if (options.untracked) {
    // Show a brand-new file as an all-added diff.
    result = await runGit(repo.root, ["diff", "--no-index", "--", os.platform() === "win32" ? "NUL" : "/dev/null", filePath]);
    // --no-index exits 1 when there are differences; that's the normal case.
    result.ok = result.code === 0 || result.code === 1;
  } else {
    result = await runGit(repo.root, ["diff", ...(options.staged ? ["--cached"] : []), "--find-renames", "--", filePath]);
  }

  if (!result.ok) {
    throw new Error(result.stderr.trim() || "git diff failed.");
  }

  const { text, truncated } = truncate(result.stdout, MAX_DIFF_BYTES);
  return { ...repo, path: filePath, diff: text, truncated, binary: /^Binary files /m.test(text) };
}

async function listDirectory(cwd, relativeDir = "") {
  const repo = await resolveRepo(cwd);
  const base = repo.isRepo ? repo.root : cwd;
  const directory = resolveInside(base, relativeDir);
  const dirents = await fsp.readdir(directory, { withFileTypes: true });

  let entries = dirents
    .filter((dirent) => dirent.name !== ".git")
    .slice(0, MAX_DIR_ENTRIES)
    .map((dirent) => {
      const absolute = path.join(directory, dirent.name);
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        isDir = isDirectory(absolute);
      }
      return {
        name: dirent.name,
        path: toPosix(path.relative(base, absolute)),
        type: isDir ? "dir" : "file"
      };
    });

  if (repo.isRepo && entries.length) {
    // Paths are relative to the repo root; directories need a trailing slash so
    // "folder/" ignore patterns match.
    const rootRelative = (entry) => toPosix(path.relative(repo.root, path.join(base, entry.path)));
    const ignored = await checkIgnored(
      repo.root,
      entries.map((entry) => (entry.type === "dir" ? `${rootRelative(entry)}/` : rootRelative(entry)))
    );
    entries = entries.map((entry) => ({ ...entry, ignored: ignored.has(entry.path) }));
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  });

  return {
    ...repo,
    base,
    dir: toPosix(path.relative(base, directory)),
    entries,
    truncated: dirents.length > MAX_DIR_ENTRIES
  };
}

function checkIgnored(root, relativePaths) {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      ["check-ignore", "--stdin", "-z"],
      { cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (_error, stdout) => {
        // Exit 1 just means "nothing ignored".
        resolve(new Set(String(stdout || "").split("\0").filter(Boolean).map((value) => value.replace(/\/$/, ""))));
      }
    );
    child.stdin.end(relativePaths.join("\0") + "\0");
  });
}

async function readProjectFile(cwd, relativePath) {
  const repo = await resolveRepo(cwd);
  const base = repo.isRepo ? repo.root : cwd;
  const absolute = resolveInside(base, relativePath);
  const stat = await fsp.stat(absolute);
  if (!stat.isFile()) {
    throw Object.assign(new Error("Not a file."), { statusCode: 400 });
  }

  const handle = await fsp.open(absolute, "r");
  try {
    const length = Math.min(stat.size, MAX_FILE_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    const binary = buffer.subarray(0, Math.min(length, 8000)).includes(0);
    return {
      ...repo,
      path: toPosix(path.relative(base, absolute)),
      size: stat.size,
      binary,
      truncated: stat.size > MAX_FILE_BYTES,
      content: binary ? "" : buffer.toString("utf8")
    };
  } finally {
    await handle.close();
  }
}

function formatCommand(args) {
  return `git ${args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}

async function runAction(cwd, payload = {}) {
  const repo = await resolveRepo(cwd);
  if (!repo.isRepo) {
    throw Object.assign(new Error("This folder isn't a git repository."), { statusCode: 400 });
  }

  const action = String(payload.action || "");
  const paths = (Array.isArray(payload.paths) ? payload.paths : []).map((value) => {
    resolveInside(repo.root, value);
    return String(value);
  });

  return enqueue(repo.root, async () => {
    const steps = [];
    const run = async (args, options = {}) => {
      const result = await runGit(repo.root, args, { write: true, ...options });
      steps.push({
        command: formatCommand(args),
        ok: result.ok,
        output: `${result.stdout}${result.stderr}`.trim() || (result.ok ? "" : `exit code ${result.code}`),
        timedOut: result.timedOut
      });
      return result;
    };

    switch (action) {
      case "stage":
        if (!paths.length) throw Object.assign(new Error("No files given."), { statusCode: 400 });
        await run(["add", "--", ...paths]);
        break;
      case "stageAll":
        await run(["add", "-A"]);
        break;
      case "unstage": {
        if (!paths.length) throw Object.assign(new Error("No files given."), { statusCode: 400 });
        const hasHead = (await runGit(repo.root, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
        await run(hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-q", "--", ...paths]);
        break;
      }
      case "unstageAll": {
        const hasHead = (await runGit(repo.root, ["rev-parse", "--verify", "-q", "HEAD"])).ok;
        await run(hasHead ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "."]);
        break;
      }
      case "commit": {
        const message = String(payload.message || "").trim();
        if (!message) throw Object.assign(new Error("Write a commit message first."), { statusCode: 400 });
        if (payload.stageAll) {
          const add = await run(["add", "-A"]);
          if (!add.ok) break;
        }
        const commit = await run(["commit", "-m", message]);
        if (commit.ok && payload.push) {
          await pushCurrentBranch(repo.root, run);
        }
        break;
      }
      case "push":
        await pushCurrentBranch(repo.root, run);
        break;
      case "pull":
        await run(["pull", "--ff-only"], { timeout: NETWORK_TIMEOUT_MS });
        break;
      case "fetch":
        await run(["fetch", "--all", "--prune"], { timeout: NETWORK_TIMEOUT_MS });
        break;
      default:
        throw Object.assign(new Error(`Unknown git action: ${action}`), { statusCode: 400 });
    }

    const ok = steps.every((step) => step.ok);
    return { ...repo, action, ok, steps };
  });
}

async function pushCurrentBranch(root, run) {
  const upstream = await runGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  if (upstream.ok) {
    return run(["push"], { timeout: NETWORK_TIMEOUT_MS });
  }

  // First push of a new branch: publish it to the first remote, like VS Code's "Publish Branch".
  const [branch, remotes] = await Promise.all([
    runGit(root, ["symbolic-ref", "--short", "HEAD"]),
    runGit(root, ["remote"])
  ]);
  const remoteList = remotes.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const remote = remoteList.includes("origin") ? "origin" : remoteList[0];
  if (!branch.ok || !remote) {
    return run(["push"], { timeout: NETWORK_TIMEOUT_MS });
  }
  return run(["push", "-u", remote, branch.stdout.trim()], { timeout: NETWORK_TIMEOUT_MS });
}

module.exports = {
  detectCwdFromScreen,
  getCommit,
  getDiff,
  getLog,
  getStatus,
  isDirectory,
  listDirectory,
  readProjectFile,
  runAction
};
