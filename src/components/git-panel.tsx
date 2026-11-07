"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import styles from "./git-panel.module.css";

// Full-screen "mobile IDE" view for one terminal: source control (stage, commit,
// push), a file explorer, and the commit graph. All git work runs in a hidden
// background process in the terminal's folder (see src/main/git-service.js), so
// it never types into the terminal Claude may be using.

type Tab = "changes" | "files" | "history";

type FileChange = {
  path: string;
  originalPath?: string;
  status: string;
  untracked?: boolean;
};

type GitStatus = {
  cwd: string;
  root: string;
  isRepo: boolean;
  detectedCwd: string;
  branch: { name: string; upstream: string; ahead: number; behind: number; detached: boolean; noCommits: boolean } | null;
  staged: FileChange[];
  unstaged: FileChange[];
  conflicted: FileChange[];
  remotes: string[];
  lastCommit: { hash: string; subject: string; when: string } | null;
};

type TreeEntry = { name: string; path: string; type: "dir" | "file"; ignored?: boolean };

type LogRow = {
  graph: string;
  commit: {
    hash: string;
    shortHash: string;
    parents: string[];
    author: string;
    timestamp: number;
    refs: string[];
    subject: string;
  } | null;
};

type CommitDetail = {
  commit: { hash: string; author: string; email: string; timestamp: number; refs: string[]; parents: string[]; message: string };
  files: { path: string; added: number | null; removed: number | null; status: string }[];
};

type ActionStep = { command: string; ok: boolean; output: string; timedOut?: boolean };

type Viewer =
  | { kind: "diff"; title: string; subtitle: string; params: Record<string, string> }
  | { kind: "file"; path: string }
  | { kind: "commit"; hash: string };

type GitPanelProps = {
  apiBase: string;
  sessionId: string;
  sessionLabel: string;
  onClose: () => void;
};

const STATUS_POLL_MS = 5000;
const CWD_STORAGE_PREFIX = "siylo-git-cwd:";

const STATUS_LABELS: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  C: "Copied",
  U: "Untracked",
  T: "Type changed"
};

export function GitPanel({ apiBase, sessionId, sessionLabel, onClose }: GitPanelProps) {
  const [tab, setTab] = useState<Tab>("changes");
  const [cwdOverride, setCwdOverride] = useState("");
  const [isEditingFolder, setIsEditingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionSteps, setActionSteps] = useState<ActionStep[]>([]);
  const [isOutputOpen, setIsOutputOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const cwdOverrideRef = useRef("");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(CWD_STORAGE_PREFIX + sessionId) || "";
      cwdOverrideRef.current = stored;
      setCwdOverride(stored);
    } catch {
      // Storage is optional.
    }
  }, [sessionId]);

  const request = useCallback(
    async <T,>(route: string, params: Record<string, string> = {}, init?: RequestInit): Promise<T> => {
      const query = new URLSearchParams(params);
      if (cwdOverrideRef.current) {
        query.set("cwd", cwdOverrideRef.current);
      }
      const response = await fetch(
        `${apiBase}/sessions/${encodeURIComponent(sessionId)}/git/${route}?${query.toString()}`,
        { cache: "no-store", ...init }
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Request failed (${response.status}).`);
      }
      return payload as T;
    },
    [apiBase, sessionId]
  );

  const refreshStatus = useCallback(async () => {
    try {
      const next = await request<GitStatus>("status");
      setStatus(next);
      setStatusError("");
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingStatus(false);
    }
  }, [request]);

  useEffect(() => {
    void refreshStatus();
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshStatus();
      }
    }, STATUS_POLL_MS);
    return () => window.clearInterval(intervalId);
  }, [refreshStatus, cwdOverride]);

  async function runAction(action: string, body: Record<string, unknown> = {}) {
    setBusyAction(action);
    try {
      const result = await request<{ ok: boolean; steps: ActionStep[] }>("action", {}, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...body })
      });
      setActionSteps(result.steps);
      if (!result.ok) {
        setIsOutputOpen(true);
      }
      return result.ok;
    } catch (error) {
      setActionSteps([{ command: action, ok: false, output: error instanceof Error ? error.message : String(error) }]);
      setIsOutputOpen(true);
      return false;
    } finally {
      setBusyAction(null);
      void refreshStatus();
    }
  }

  function applyFolder(nextCwd: string) {
    const value = nextCwd.trim();
    cwdOverrideRef.current = value;
    setCwdOverride(value);
    try {
      if (value) {
        window.localStorage.setItem(CWD_STORAGE_PREFIX + sessionId, value);
      } else {
        window.localStorage.removeItem(CWD_STORAGE_PREFIX + sessionId);
      }
    } catch {
      // Storage is optional.
    }
    setIsEditingFolder(false);
    setIsLoadingStatus(true);
    setStatus(null);
  }

  const folderPath = status?.root || status?.cwd || status?.detectedCwd || "";
  const folderName = folderPath.split(/[\\/]/).filter(Boolean).pop() || folderPath || "…";
  const changeCount = (status?.staged.length || 0) + (status?.unstaged.length || 0) + (status?.conflicted.length || 0);

  return (
    <div className={styles.shell} data-no-hold="true" role="dialog" aria-label="Source control">
      <header className={styles.header}>
        <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Back to terminal">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.folderButton}
          onClick={() => {
            setFolderDraft(cwdOverride || folderPath);
            setIsEditingFolder((value) => !value);
          }}
          aria-label="Change folder"
        >
          <span className={styles.folderName}>{folderName}</span>
          <span className={styles.folderMeta}>
            {sessionLabel}
            {cwdOverride ? " · pinned folder" : " · follows terminal"}
          </span>
        </button>
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => {
            setIsLoadingStatus(true);
            void refreshStatus();
          }}
          aria-label="Refresh"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={isLoadingStatus ? styles.spin : ""}>
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
        </button>
      </header>

      {isEditingFolder ? (
        <form
          className={styles.folderEditor}
          onSubmit={(event) => {
            event.preventDefault();
            applyFolder(folderDraft);
          }}
        >
          <label className={styles.fieldLabel} htmlFor="git-folder">
            Folder on your PC
          </label>
          <input
            id="git-folder"
            className={styles.textInput}
            value={folderDraft}
            onChange={(event) => setFolderDraft(event.currentTarget.value)}
            placeholder="C:\\path\\to\\project"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <p className={styles.hint}>
            Terminal is in: <code>{status?.detectedCwd || "unknown"}</code>
          </p>
          <div className={styles.buttonRow}>
            <button type="submit" className={styles.primaryButton}>
              Use this folder
            </button>
            <button type="button" className={styles.secondaryButton} onClick={() => applyFolder("")}>
              Follow terminal
            </button>
          </div>
        </form>
      ) : null}

      <nav className={styles.tabs} aria-label="Views">
        {(
          [
            ["changes", `Changes${changeCount ? ` ${changeCount}` : ""}`],
            ["files", "Files"],
            ["history", "History"]
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={`${styles.tab} ${tab === value ? styles.tabActive : ""}`}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className={styles.body}>
        {statusError && !status ? (
          <div className={styles.emptyState}>
            <p>{statusError}</p>
            <button type="button" className={styles.secondaryButton} onClick={() => void refreshStatus()}>
              Try again
            </button>
          </div>
        ) : !status ? (
          <div className={styles.emptyState}>Loading…</div>
        ) : tab === "changes" ? (
          <ChangesView
            status={status}
            busyAction={busyAction}
            commitMessage={commitMessage}
            setCommitMessage={setCommitMessage}
            runAction={runAction}
            openDiff={(file, staged) =>
              setViewer({
                kind: "diff",
                title: baseName(file.path),
                subtitle: `${staged ? "Staged" : "Working tree"} · ${STATUS_LABELS[file.status] || file.status}`,
                params: {
                  path: file.path,
                  ...(staged ? { staged: "1" } : {}),
                  ...(file.untracked ? { untracked: "1" } : {})
                }
              })
            }
          />
        ) : tab === "files" ? (
          <FilesView status={status} request={request} openFile={(path) => setViewer({ kind: "file", path })} />
        ) : (
          <HistoryView request={request} openCommit={(hash) => setViewer({ kind: "commit", hash })} statusKey={status.lastCommit?.hash || ""} />
        )}
      </div>

      {actionSteps.length ? (
        <section className={`${styles.output} ${isOutputOpen ? styles.outputOpen : ""}`}>
          <button type="button" className={styles.outputToggle} onClick={() => setIsOutputOpen((value) => !value)}>
            <span className={actionSteps.every((step) => step.ok) ? styles.okDot : styles.errorDot} aria-hidden="true" />
            <span className={styles.outputSummary}>{actionSteps[actionSteps.length - 1]?.command}</span>
            <span className={styles.outputChevron}>{isOutputOpen ? "Hide" : "Output"}</span>
          </button>
          {isOutputOpen ? (
            <pre className={styles.outputLog}>
              {actionSteps
                .map((step) => `$ ${step.command}\n${step.output || (step.ok ? "(done)" : "")}${step.timedOut ? "\n(timed out)" : ""}`)
                .join("\n\n")}
            </pre>
          ) : null}
        </section>
      ) : null}

      {viewer ? (
        <ViewerOverlay
          viewer={viewer}
          request={request}
          onClose={() => setViewer(null)}
          onOpen={(next) => setViewer(next)}
        />
      ) : null}
    </div>
  );
}

/* ---------------- Changes ---------------- */

function ChangesView({
  status,
  busyAction,
  commitMessage,
  setCommitMessage,
  runAction,
  openDiff
}: {
  status: GitStatus;
  busyAction: string | null;
  commitMessage: string;
  setCommitMessage: (value: string) => void;
  runAction: (action: string, body?: Record<string, unknown>) => Promise<boolean>;
  openDiff: (file: FileChange, staged: boolean) => void;
}) {
  if (!status.isRepo) {
    return (
      <div className={styles.emptyState}>
        <p>
          <strong>{status.cwd}</strong> isn&apos;t a git repository.
        </p>
        <p className={styles.hint}>cd into a project in the terminal, or tap the folder name above to pick one.</p>
      </div>
    );
  }

  const branch = status.branch;
  const hasStaged = status.staged.length > 0;
  const hasChanges = status.unstaged.length > 0 || status.conflicted.length > 0;
  const isBusy = busyAction !== null;
  const canCommit = commitMessage.trim().length > 0 && (hasStaged || hasChanges) && !isBusy;
  // Like VS Code's smart commit: with nothing staged, commit everything.
  const stageAllOnCommit = !hasStaged;

  async function commit(push: boolean) {
    const ok = await runAction(push ? "commitPush" : "commit", {
      action: "commit",
      message: commitMessage,
      stageAll: stageAllOnCommit,
      push
    });
    if (ok) {
      setCommitMessage("");
    }
  }

  return (
    <div className={styles.scroll}>
      <div className={styles.branchBar}>
        <span className={styles.branchName}>
          <BranchIcon />
          {branch?.name || "HEAD"}
          {branch?.detached ? " (detached)" : ""}
        </span>
        <span className={styles.branchSync}>
          {branch?.upstream ? (
            <>
              ↑{branch.ahead} ↓{branch.behind}
            </>
          ) : status.remotes.length ? (
            "not published"
          ) : (
            "no remote"
          )}
        </span>
      </div>

      <div className={styles.syncRow}>
        <button type="button" className={styles.syncButton} disabled={isBusy || !status.remotes.length} onClick={() => void runAction("pull")}>
          {busyAction === "pull" ? "Pulling…" : `Pull${branch?.behind ? ` ${branch.behind}` : ""}`}
        </button>
        <button type="button" className={styles.syncButton} disabled={isBusy || !status.remotes.length} onClick={() => void runAction("push")}>
          {busyAction === "push" ? "Pushing…" : branch?.upstream ? `Push${branch.ahead ? ` ${branch.ahead}` : ""}` : "Publish"}
        </button>
        <button type="button" className={styles.syncButton} disabled={isBusy || !status.remotes.length} onClick={() => void runAction("fetch")}>
          {busyAction === "fetch" ? "Fetching…" : "Fetch"}
        </button>
      </div>

      <div className={styles.commitBox}>
        <textarea
          className={styles.commitInput}
          value={commitMessage}
          onChange={(event) => setCommitMessage(event.currentTarget.value)}
          placeholder={`Message (commit on ${branch?.name || "HEAD"})`}
          rows={3}
        />
        <div className={styles.buttonRow}>
          <button type="button" className={styles.primaryButton} disabled={!canCommit} onClick={() => void commit(false)}>
            {busyAction === "commit" ? "Committing…" : stageAllOnCommit ? "Commit all" : "Commit"}
          </button>
          <button
            type="button"
            className={styles.secondaryButton}
            disabled={!canCommit || !status.remotes.length}
            onClick={() => void commit(true)}
          >
            {busyAction === "commitPush" ? "Working…" : stageAllOnCommit ? "Commit all & push" : "Commit & push"}
          </button>
        </div>
        {!hasStaged && hasChanges ? (
          <p className={styles.hint}>Nothing staged, so Commit includes every change below.</p>
        ) : null}
        {!hasStaged && !hasChanges && status.lastCommit ? (
          <p className={styles.hint}>
            Clean. Last commit: {status.lastCommit.subject} ({status.lastCommit.when})
          </p>
        ) : null}
      </div>

      {status.conflicted.length ? (
        <ChangeSection
          title="Merge conflicts"
          files={status.conflicted}
          actionLabel="+"
          actionAria="Mark resolved (stage)"
          disabled={isBusy}
          onAction={(file) => void runAction("stage", { paths: [file.path] })}
          onOpen={(file) => openDiff(file, false)}
        />
      ) : null}

      {hasStaged ? (
        <ChangeSection
          title="Staged changes"
          files={status.staged}
          bulkLabel="Unstage all"
          onBulk={() => void runAction("unstageAll")}
          actionLabel="−"
          actionAria="Unstage"
          disabled={isBusy}
          onAction={(file) => void runAction("unstage", { paths: [file.path] })}
          onOpen={(file) => openDiff(file, true)}
        />
      ) : null}

      <ChangeSection
        title="Changes"
        files={status.unstaged}
        bulkLabel={status.unstaged.length ? "Stage all" : undefined}
        onBulk={() => void runAction("stageAll")}
        actionLabel="+"
        actionAria="Stage"
        disabled={isBusy}
        onAction={(file) => void runAction("stage", { paths: [file.path] })}
        onOpen={(file) => openDiff(file, false)}
        emptyText="No unstaged changes."
      />
    </div>
  );
}

function ChangeSection({
  title,
  files,
  bulkLabel,
  onBulk,
  actionLabel,
  actionAria,
  disabled,
  onAction,
  onOpen,
  emptyText
}: {
  title: string;
  files: FileChange[];
  bulkLabel?: string;
  onBulk?: () => void;
  actionLabel: string;
  actionAria: string;
  disabled: boolean;
  onAction: (file: FileChange) => void;
  onOpen: (file: FileChange) => void;
  emptyText?: string;
}) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>
          {title} <span className={styles.countBadge}>{files.length}</span>
        </span>
        {bulkLabel && onBulk ? (
          <button type="button" className={styles.linkButton} disabled={disabled} onClick={onBulk}>
            {bulkLabel}
          </button>
        ) : null}
      </div>
      {files.length === 0 && emptyText ? <p className={styles.hint}>{emptyText}</p> : null}
      <ul className={styles.fileList}>
        {files.map((file) => (
          <li key={`${file.path}:${file.status}`} className={styles.fileRow}>
            <button type="button" className={styles.fileMain} onClick={() => onOpen(file)}>
              <span className={styles.fileName}>{baseName(file.path)}</span>
              <span className={styles.fileDir}>{dirName(file.path)}</span>
            </button>
            <span className={`${styles.statusLetter} ${statusClass(file.status)}`} title={STATUS_LABELS[file.status] || file.status}>
              {file.status}
            </span>
            <button type="button" className={styles.rowAction} aria-label={`${actionAria} ${file.path}`} disabled={disabled} onClick={() => onAction(file)}>
              {actionLabel}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ---------------- Files ---------------- */

function FilesView({
  status,
  request,
  openFile
}: {
  status: GitStatus;
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  openFile: (path: string) => void;
}) {
  const [dirs, setDirs] = useState<Record<string, TreeEntry[] | "loading" | { error: string }>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  const changeMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of [...status.unstaged, ...status.staged, ...status.conflicted]) {
      if (!map.has(file.path)) map.set(file.path, file.status);
    }
    return map;
  }, [status]);

  const dirtyDirs = useMemo(() => {
    const set = new Set<string>();
    for (const filePath of changeMap.keys()) {
      const parts = filePath.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        set.add(parts.slice(0, index).join("/"));
      }
    }
    return set;
  }, [changeMap]);

  const loadDir = useCallback(
    async (dir: string) => {
      setDirs((current) => ({ ...current, [dir]: "loading" }));
      try {
        const result = await request<{ entries: TreeEntry[] }>("tree", { dir });
        setDirs((current) => ({ ...current, [dir]: result.entries }));
      } catch (error) {
        setDirs((current) => ({ ...current, [dir]: { error: error instanceof Error ? error.message : String(error) } }));
      }
    },
    [request]
  );

  const rootKey = status.root || status.cwd;
  useEffect(() => {
    setDirs({});
    setExpanded(new Set([""]));
    void loadDir("");
  }, [rootKey, loadDir]);

  function toggle(dir: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(dir)) {
        next.delete(dir);
      } else {
        next.add(dir);
        if (!dirs[dir]) void loadDir(dir);
      }
      return next;
    });
  }

  function renderDir(dir: string, depth: number): ReactNode {
    const entries = dirs[dir];
    if (!entries || entries === "loading") {
      return <li className={styles.treeHint} style={{ paddingLeft: 14 + depth * 16 }}>Loading…</li>;
    }
    if (!Array.isArray(entries)) {
      return <li className={styles.treeHint} style={{ paddingLeft: 14 + depth * 16 }}>{entries.error}</li>;
    }
    if (!entries.length) {
      return <li className={styles.treeHint} style={{ paddingLeft: 14 + depth * 16 }}>Empty folder</li>;
    }
    return entries.map((entry) => {
      const isOpen = expanded.has(entry.path);
      const change = changeMap.get(entry.path);
      const dirty = entry.type === "dir" && dirtyDirs.has(entry.path);
      return (
        <li key={entry.path}>
          <button
            type="button"
            className={`${styles.treeRow} ${entry.ignored ? styles.treeIgnored : ""}`}
            style={{ paddingLeft: 10 + depth * 16 }}
            onClick={() => (entry.type === "dir" ? toggle(entry.path) : openFile(entry.path))}
          >
            <span className={styles.treeChevron}>{entry.type === "dir" ? (isOpen ? "▾" : "▸") : ""}</span>
            <span className={entry.type === "dir" ? styles.treeFolderIcon : styles.treeFileIcon} aria-hidden="true" />
            <span className={`${styles.treeName} ${change ? statusClass(change) : ""}`}>{entry.name}</span>
            {change ? <span className={`${styles.statusLetter} ${statusClass(change)}`}>{change}</span> : null}
            {dirty ? <span className={styles.dirtyDot} aria-label="Contains changes" /> : null}
          </button>
          {entry.type === "dir" && isOpen ? <ul className={styles.treeList}>{renderDir(entry.path, depth + 1)}</ul> : null}
        </li>
      );
    });
  }

  return (
    <div className={styles.scroll}>
      <ul className={styles.treeList}>{renderDir("", 0)}</ul>
    </div>
  );
}

/* ---------------- History ---------------- */

const LANE_COLORS = ["#60a5fa", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"];

function HistoryView({
  request,
  openCommit,
  statusKey
}: {
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  openCommit: (hash: string) => void;
  statusKey: string;
}) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState("");
  const [allBranches, setAllBranches] = useState(false);

  useEffect(() => {
    let cancelled = false;
    request<{ rows: LogRow[]; isRepo: boolean }>("log", allBranches ? { all: "1" } : {})
      .then((result) => {
        if (!cancelled) {
          setRows(result.rows);
          setError(result.isRepo ? "" : "Not a git repository.");
        }
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [request, allBranches, statusKey]);

  if (error) {
    return <div className={styles.emptyState}>{error}</div>;
  }
  if (!rows) {
    return <div className={styles.emptyState}>Loading history…</div>;
  }
  if (!rows.length) {
    return <div className={styles.emptyState}>No commits yet.</div>;
  }

  const now = Date.now();
  return (
    <div className={styles.scroll}>
      <label className={styles.toggleRow}>
        <span>Include stashes &amp; all refs</span>
        <input type="checkbox" checked={allBranches} onChange={(event) => setAllBranches(event.currentTarget.checked)} />
      </label>
      <ul className={styles.historyList}>
        {rows.map((row, index) => (
          <li key={row.commit?.hash || `g${index}`}>
            {row.commit ? (
              <button type="button" className={styles.historyRow} onClick={() => openCommit(row.commit!.hash)}>
                <GraphCell graph={row.graph} />
                <span className={styles.historyBody}>
                  <span className={styles.historySubject}>
                    {row.commit.refs.map((ref) => (
                      <span key={ref} className={`${styles.refBadge} ${refClass(ref)}`}>
                        {formatRef(ref)}
                      </span>
                    ))}
                    {row.commit.subject}
                  </span>
                  <span className={styles.historyMeta}>
                    {row.commit.shortHash} · {row.commit.author} · {formatRelative(row.commit.timestamp, now)}
                  </span>
                </span>
              </button>
            ) : (
              <div className={styles.historyConnector}>
                <GraphCell graph={row.graph} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function GraphCell({ graph }: { graph: string }) {
  return (
    <span className={styles.graph} aria-hidden="true">
      {Array.from(graph).map((char, index) => {
        if (char === " ") return <span key={index}> </span>;
        const color = LANE_COLORS[Math.floor(index / 2) % LANE_COLORS.length];
        return (
          <span key={index} style={{ color }} className={char === "*" ? styles.graphNode : undefined}>
            {char === "*" ? "●" : char}
          </span>
        );
      })}
    </span>
  );
}

/* ---------------- Viewers (diff / file / commit) ---------------- */

function ViewerOverlay({
  viewer,
  request,
  onClose,
  onOpen
}: {
  viewer: Viewer;
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  onClose: () => void;
  onOpen: (viewer: Viewer) => void;
}) {
  const [wrap, setWrap] = useState(true);
  const history = useRef<Viewer[]>([]);

  const title =
    viewer.kind === "diff" ? viewer.title : viewer.kind === "file" ? baseName(viewer.path) : `Commit ${viewer.hash.slice(0, 7)}`;
  const subtitle =
    viewer.kind === "diff" ? viewer.subtitle : viewer.kind === "file" ? dirName(viewer.path) || "/" : "";

  return (
    <div className={styles.viewer}>
      <header className={styles.header}>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="Back"
          onClick={() => {
            const previous = history.current.pop();
            if (previous) onOpen(previous);
            else onClose();
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 5l-7 7 7 7" />
          </svg>
        </button>
        <div className={styles.viewerTitle}>
          <span className={styles.folderName}>{title}</span>
          {subtitle ? <span className={styles.folderMeta}>{subtitle}</span> : null}
        </div>
        {viewer.kind !== "commit" ? (
          <button type="button" className={`${styles.chipButton} ${wrap ? styles.chipActive : ""}`} onClick={() => setWrap((value) => !value)}>
            Wrap
          </button>
        ) : null}
      </header>
      <div className={styles.viewerBody}>
        {viewer.kind === "diff" ? (
          <DiffView params={viewer.params} request={request} wrap={wrap} />
        ) : viewer.kind === "file" ? (
          <FileView path={viewer.path} request={request} wrap={wrap} />
        ) : (
          <CommitView
            hash={viewer.hash}
            request={request}
            openDiff={(file) => {
              history.current.push(viewer);
              onOpen({
                kind: "diff",
                title: baseName(file.path),
                subtitle: `${viewer.hash.slice(0, 7)} · ${STATUS_LABELS[file.status] || file.status}`,
                params: { path: file.path, commit: viewer.hash }
              });
            }}
          />
        )}
      </div>
    </div>
  );
}

function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    setState({});
    load()
      .then((data) => !cancelled && setState({ data }))
      .catch((error) => !cancelled && setState({ error: error instanceof Error ? error.message : String(error) }));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function DiffView({
  params,
  request,
  wrap
}: {
  params: Record<string, string>;
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  wrap: boolean;
}) {
  const key = JSON.stringify(params);
  const { data, error } = useLoad(() => request<{ diff: string; truncated: boolean; binary: boolean }>("diff", params), [key]);

  if (error) return <div className={styles.emptyState}>{error}</div>;
  if (!data) return <div className={styles.emptyState}>Loading diff…</div>;
  if (data.binary) return <div className={styles.emptyState}>Binary file changed.</div>;
  if (!data.diff.trim()) return <div className={styles.emptyState}>No differences.</div>;

  const lines = parseDiff(data.diff);
  return (
    <div className={`${styles.code} ${wrap ? styles.codeWrap : ""}`}>
      {lines.map((line, index) => (
        <div key={index} className={`${styles.codeLine} ${styles[`diff_${line.kind}`] || ""}`}>
          <span className={styles.lineNo}>{line.oldNo ?? ""}</span>
          <span className={styles.lineNo}>{line.newNo ?? ""}</span>
          <span className={styles.lineText}>{line.text || " "}</span>
        </div>
      ))}
      {data.truncated ? <p className={styles.hint}>Diff truncated (too large for the phone).</p> : null}
    </div>
  );
}

function FileView({
  path,
  request,
  wrap
}: {
  path: string;
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  wrap: boolean;
}) {
  const { data, error } = useLoad(
    () => request<{ content: string; binary: boolean; truncated: boolean; size: number }>("file", { path }),
    [path]
  );

  if (error) return <div className={styles.emptyState}>{error}</div>;
  if (!data) return <div className={styles.emptyState}>Loading…</div>;
  if (data.binary) return <div className={styles.emptyState}>Binary file ({formatBytes(data.size)}).</div>;

  const lines = data.content.split(/\r?\n/);
  return (
    <div className={`${styles.code} ${wrap ? styles.codeWrap : ""}`}>
      {lines.map((line, index) => (
        <div key={index} className={styles.codeLine}>
          <span className={styles.lineNo}>{index + 1}</span>
          <span className={styles.lineText}>{line || " "}</span>
        </div>
      ))}
      {data.truncated ? <p className={styles.hint}>Showing the first {formatBytes(400_000)} of {formatBytes(data.size)}.</p> : null}
    </div>
  );
}

function CommitView({
  hash,
  request,
  openDiff
}: {
  hash: string;
  request: <T>(route: string, params?: Record<string, string>) => Promise<T>;
  openDiff: (file: CommitDetail["files"][number]) => void;
}) {
  const { data, error } = useLoad(() => request<CommitDetail>("commit", { hash }), [hash]);

  if (error) return <div className={styles.emptyState}>{error}</div>;
  if (!data) return <div className={styles.emptyState}>Loading commit…</div>;

  const [subject, ...bodyLines] = data.commit.message.split(/\r?\n/);
  const body = bodyLines.join("\n").trim();
  return (
    <div className={styles.scroll}>
      <div className={styles.commitHeader}>
        <h3 className={styles.commitSubject}>{subject}</h3>
        {body ? <p className={styles.commitBody}>{body}</p> : null}
        <p className={styles.historyMeta}>
          {data.commit.author} · {new Date(data.commit.timestamp).toLocaleString()}
        </p>
        <p className={styles.commitHash}>{data.commit.hash}</p>
        {data.commit.refs.length ? (
          <p>
            {data.commit.refs.map((ref) => (
              <span key={ref} className={`${styles.refBadge} ${refClass(ref)}`}>
                {formatRef(ref)}
              </span>
            ))}
          </p>
        ) : null}
      </div>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <span>
            Files changed <span className={styles.countBadge}>{data.files.length}</span>
          </span>
        </div>
        <ul className={styles.fileList}>
          {data.files.map((file) => (
            <li key={file.path} className={styles.fileRow}>
              <button type="button" className={styles.fileMain} onClick={() => openDiff(file)}>
                <span className={styles.fileName}>{baseName(file.path)}</span>
                <span className={styles.fileDir}>{dirName(file.path)}</span>
              </button>
              <span className={styles.numstat}>
                {file.added !== null ? <span className={styles.added}>+{file.added}</span> : null}
                {file.removed !== null ? <span className={styles.removed}>−{file.removed}</span> : null}
              </span>
              <span className={`${styles.statusLetter} ${statusClass(file.status)}`}>{file.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/* ---------------- helpers ---------------- */

type DiffLine = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo?: number; newNo?: number };

function parseDiff(diff: string): DiffLine[] {
  const result: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("new file mode") || raw.startsWith("deleted file mode") || raw.startsWith("similarity index") || raw.startsWith("rename ")) {
      if (raw.startsWith("diff --git") && result.length) {
        result.push({ kind: "meta", text: "" });
      }
      inHunk = false;
      if (raw.startsWith("rename ") || raw.startsWith("new file mode") || raw.startsWith("deleted file mode")) {
        result.push({ kind: "meta", text: raw });
      }
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      result.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.trim()) result.push({ kind: "meta", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      result.push({ kind: "add", text: raw.slice(1), newNo: newNo++ });
    } else if (raw.startsWith("-")) {
      result.push({ kind: "del", text: raw.slice(1), oldNo: oldNo++ });
    } else if (raw.startsWith("\\")) {
      result.push({ kind: "meta", text: raw });
    } else if (raw.length || oldNo || newNo) {
      result.push({ kind: "ctx", text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }

  // Drop the trailing empty context line produced by the final newline.
  while (result.length && result[result.length - 1].kind === "ctx" && !result[result.length - 1].text) {
    result.pop();
  }
  return result;
}

function statusClass(status: string) {
  switch (status) {
    case "A":
    case "U":
      return styles.statusAdded;
    case "D":
      return styles.statusDeleted;
    case "R":
    case "C":
      return styles.statusRenamed;
    default:
      return styles.statusModified;
  }
}

function refClass(ref: string) {
  if (ref.startsWith("HEAD")) return styles.refHead;
  if (ref.startsWith("tag: ")) return styles.refTag;
  if (ref.includes("/")) return styles.refRemote;
  return styles.refLocal;
}

function formatRef(ref: string) {
  return ref.replace(/^HEAD -> /, "● ").replace(/^tag: /, "🏷 ");
}

function baseName(filePath: string) {
  return filePath.split("/").pop() || filePath;
}

function dirName(filePath: string) {
  const parts = filePath.split("/");
  parts.pop();
  return parts.join("/");
}

function formatRelative(timestamp: number, now: number) {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={styles.inlineIcon}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="7" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 9.2c0 5-6 3.5-11.2 8" />
    </svg>
  );
}
