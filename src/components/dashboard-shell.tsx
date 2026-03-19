"use client";

import { useEffect, useMemo, useState } from "react";
import type { SiyloState } from "@/lib/siylo-types";

const levelTone: Record<string, string> = {
  info: "var(--accent)",
  warn: "var(--warning)",
  error: "var(--danger)",
};

const browserFallbackState: SiyloState = {
  isConnected: false,
  discord: {
    status: "stopped",
    botTag: "",
    lastError: ""
  },
  voice: {
    status: "stopped",
    port: 3210,
    url: "http://127.0.0.1:3210",
    provider: "unconfigured",
    lastError: ""
  },
  remoteAccess: {
    status: "stopped",
    port: 3443,
    url: "http://localhost:3443/radio",
    localUrls: ["http://localhost:3443/radio"],
    username: "",
    authConfigured: false,
    lastError: ""
  },
  update: {
    status: "disabled",
    currentVersion: "0.1.0",
    availableVersion: "",
    progressPercent: 0,
    transferredBytes: 0,
    totalBytes: 0,
    bytesPerSecond: 0,
    errorMessage: ""
  },
  config: {
    botToken: "",
    openAIApiKeyConfigured: false,
    authorizedUsers: ["123456789012345678", "987654321098765432"],
    dashboardPort: 3000,
    voiceServerPort: 3210,
    remoteAccessEnabled: false,
    remoteAccessPort: 3443,
    remoteAccessUsername: "",
    remoteAccessPasswordConfigured: false,
    autoConnect: false,
    commandPrefix: "@siylo"
  },
  sessions: [
    {
      id: "cmd-1",
      shell: "cmd",
      status: "idle",
      lastCommand: "npm run dev",
      createdAt: "2026-03-12T00:00:00.000Z"
    }
  ],
  logs: [
    {
      id: "browser-preview",
      level: "info",
      message: "Browser dashboard preview loaded without Electron runtime access.",
      timestamp: "2026-03-12T00:00:00.000Z"
    }
  ]
};

export function DashboardShell() {
  const [state, setState] = useState<SiyloState>(browserFallbackState);
  const [isDesktop, setIsDesktop] = useState(false);
  const [machineName, setMachineName] = useState("Local machine");
  const [authorizedUsersInput, setAuthorizedUsersInput] = useState("");
  const [botTokenInput, setBotTokenInput] = useState("");
  const [openAiApiKeyInput, setOpenAiApiKeyInput] = useState("");
  const [remoteAccessPortInput, setRemoteAccessPortInput] = useState("3443");
  const [remoteAccessEnabled, setRemoteAccessEnabled] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const [isCheckingForUpdates, setIsCheckingForUpdates] = useState(false);

  useEffect(() => {
    const siyloBridge = window.siylo;
    const desktopRuntime = Boolean(siyloBridge);
    setIsDesktop(desktopRuntime);
    setMachineName(window.navigator.platform || "Local machine");

    if (!siyloBridge) {
      setState(browserFallbackState);
      return;
    }

    let mounted = true;

    siyloBridge.getState().then((nextState) => {
      if (mounted) {
        setState(nextState);
      }
    });

    const unsubscribe = siyloBridge.onStateChanged((nextState) => {
      setState(nextState);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setAuthorizedUsersInput(state.config.authorizedUsers.join("\n"));
  }, [state.config.authorizedUsers]);

  useEffect(() => {
    setBotTokenInput(state.config.botToken);
  }, [state.config.botToken]);

  useEffect(() => {
    setRemoteAccessPortInput(String(state.config.remoteAccessPort));
  }, [state.config.remoteAccessPort]);

  useEffect(() => {
    setRemoteAccessEnabled(state.config.remoteAccessEnabled);
  }, [state.config.remoteAccessEnabled]);

  const commandExamples = useMemo(() => {
    const prefix = state?.config.commandPrefix || "@siylo";
    return [
      `${prefix} open powershell`,
      `${prefix} open cursor`,
      `${prefix} cmd-1 npm run dev`,
      `${prefix} screenshot`,
      `${prefix} logs`
    ];
  }, [state?.config.commandPrefix]);

  const settings = useMemo(() => {
    return [
      {
        label: "Start in system tray",
        value: "Enabled",
        hint: "Keeps Siylo available as a background agent first."
      },
      {
        label: "Auto-connect to Discord",
        value: state.config.autoConnect ? "Enabled" : "Disabled",
        hint: "Reconnects the local agent on launch."
      },
      {
        label: "Dashboard port",
        value: String(state.config.dashboardPort),
        hint: "Used when opening the local browser dashboard."
      },
      {
        label: "Authorized users",
        value: String(state.config.authorizedUsers.length),
        hint: "Discord IDs allowed to control this machine."
      },
      {
        label: "Voice backend",
        value: state.voice.status,
        hint: state.voice.url || state.voice.lastError || "Local speech execution service is idle."
      },
      {
        label: "Remote access",
        value: state.remoteAccess.status,
        hint:
          state.remoteAccess.url ||
          state.remoteAccess.lastError ||
          "Tunnel-only remote access is currently disabled."
      },
      {
        label: "Discord bot token",
        value: state.config.botToken ? "Stored" : "Missing",
        hint: "Used to connect the local agent to the Discord gateway."
      },
      {
        label: "OpenAI API key (local)",
        value: state.config.openAIApiKeyConfigured ? "Stored" : "Missing",
        hint: "Encrypted locally and used by voice transcription when no env var override is set."
      },
      {
        label: "Discord runtime",
        value: state.discord.status,
        hint: state.discord.botTag || state.discord.lastError || "No live Discord session yet."
      },
      {
        label: "Installed version",
        value: state.update.currentVersion || "Unknown",
        hint:
          state.update.availableVersion && state.update.availableVersion !== state.update.currentVersion
            ? `Latest release detected: ${state.update.availableVersion}`
            : "GitHub Releases updater is wired into the desktop runtime."
      }
    ];
  }, [state]);

  const currentState = state;
  const isDiscordActive =
    currentState.discord.status === "connecting" || currentState.discord.status === "connected";
  const isRemoteAccessActive =
    currentState.remoteAccess.status === "starting" || currentState.remoteAccess.status === "listening";
  const isAgentActive = isDiscordActive || isRemoteAccessActive;
  const agentState =
    isDiscordActive && isRemoteAccessActive
      ? "running"
      : isDiscordActive
        ? currentState.discord.status === "connected"
          ? "running"
          : "starting"
        : currentState.remoteAccess.status === "listening"
          ? "running"
          : currentState.remoteAccess.status === "starting"
            ? "starting"
            : "stopped";
  const connectionLabel =
    isRemoteAccessActive
      ? currentState.remoteAccess.url || "Remote access live"
      : isDiscordActive
        ? currentState.discord.botTag || currentState.discord.status
        : currentState.remoteAccess.lastError || currentState.discord.lastError || "stopped";
  const latestLog = currentState.logs[0]?.timestamp
    ? formatTimestamp(currentState.logs[0].timestamp)
    : "Awaiting activity";

  async function handleStartStop() {
    if (!window.siylo) {
      return;
    }

    if (isAgentActive) {
      const nextState = await window.siylo.stop();
      setState(nextState);
      return;
    }

    const nextState = await window.siylo.start();
    setState(nextState);
  }

  async function handleSaveConfig() {
    if (!window.siylo) {
      return;
    }

    setIsSaving(true);

    try {
      const nextState = await window.siylo.updateConfig({
        botToken: botTokenInput.trim(),
        ...(openAiApiKeyInput.trim() ? { openAIApiKey: openAiApiKeyInput.trim() } : {}),
        authorizedUsers: authorizedUsersInput
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean),
        remoteAccessEnabled,
        remoteAccessPort: Number(remoteAccessPortInput) || state.config.remoteAccessPort
      });

      setState(nextState);
      setOpenAiApiKeyInput("");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleClearOpenAiApiKey() {
    if (!window.siylo) {
      return;
    }

    setIsSaving(true);

    try {
      const nextState = await window.siylo.updateConfig({
        clearOpenAIApiKey: true
      });

      setState(nextState);
      setOpenAiApiKeyInput("");
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCreateSession() {
    if (!window.siylo) {
      return;
    }

    setIsStartingSession(true);

    try {
      const nextState = await window.siylo.simulateSession("open cmd");
      setState(nextState);
    } finally {
      setIsStartingSession(false);
    }
  }

  async function handleCheckForUpdates() {
    if (!window.siylo) {
      return;
    }

    setIsCheckingForUpdates(true);

    try {
      const nextState = await window.siylo.checkForUpdates();
      setState(nextState);
    } finally {
      setIsCheckingForUpdates(false);
    }
  }

  async function handleInstallUpdate() {
    if (!window.siylo) {
      return;
    }

    await window.siylo.installUpdate();
  }

  const showUpdateOverlay =
    isDesktop &&
    ["checking", "available", "downloading", "downloaded", "error"].includes(
      currentState.update.status
    );

  return (
    <main className="shell">
      {showUpdateOverlay ? (
        <UpdateOverlay state={currentState} onInstall={handleInstallUpdate} />
      ) : null}
      <section className="hero card">
        <div>
          <p className="eyebrow">Tray-first desktop agent</p>
          <h1>Siylo control surface</h1>
          <p className="lede">
            Local Discord-driven automation for terminal sessions, screenshots, and app
            launches, designed to stay quiet until you need it.
          </p>
          {!isDesktop ? (
            <p className="lede muted">
              Browser view is showing the same dashboard layout with preview data. Live controls
              remain available inside the Electron app.
            </p>
          ) : null}
        </div>
        <div className="heroGrid">
          <Metric label="Agent state" value={agentState} accent />
          <Metric label="Remote access" value={connectionLabel} />
          <Metric label="Latest event" value={latestLog} />
          <Metric label="Machine" value={machineName} />
        </div>
      </section>

      <section className="grid twoCol">
        <Panel
          title="Runtime status"
          description="Current app state mirrored from the local agent process."
        >
          <dl className="stackList">
            <Row label="Bot mention" value={currentState.config.commandPrefix} />
            <Row
              label="Discord"
              value={isDiscordActive ? currentState.discord.status : "Stopped"}
            />
            <Row
              label="Remote access"
              value={isRemoteAccessActive ? currentState.remoteAccess.status : "Stopped"}
            />
            <Row label="Tray mode" value="Primary control surface" />
            <Row
              label="Dashboard mode"
              value={isDesktop ? "Electron runtime" : "Browser preview"}
            />
          </dl>
          <div className="actionRow">
            <button className="actionButton" onClick={handleStartStop} disabled={!isDesktop}>
              {isAgentActive ? "Stop agent" : "Start agent"}
            </button>
            <button
              className="actionButton secondary"
              onClick={() => window.siylo?.openDashboard()}
              disabled={!isDesktop}
            >
              Open in browser
            </button>
            <button
              className="actionButton secondary"
              onClick={handleCheckForUpdates}
              disabled={!isDesktop || currentState.update.status === "downloading" || isCheckingForUpdates}
            >
              {isCheckingForUpdates || currentState.update.status === "checking"
                ? "Checking..."
                : "Check for updates"}
            </button>
          </div>
        </Panel>

        <Panel
          title="Credentials and access"
          description="Store the Discord bot token, OpenAI key, and allowed user IDs for this machine."
        >
          <label className="fieldLabel" htmlFor="bot-token">
            Discord bot token
          </label>
          <input
            id="bot-token"
            className="textInput"
            type="password"
            value={botTokenInput}
            disabled={!isDesktop}
            placeholder="Paste your Discord bot token"
            onChange={(event) => setBotTokenInput(event.target.value)}
          />
          <label className="fieldLabel" htmlFor="openai-api-key">
            OpenAI API key
          </label>
          <input
            id="openai-api-key"
            className="textInput"
            type="password"
            value={openAiApiKeyInput}
            disabled={!isDesktop}
            autoComplete="off"
            placeholder={
              currentState.config.openAIApiKeyConfigured
                ? "Stored locally. Enter a new key to replace it"
                : "Paste your OpenAI API key"
            }
            onChange={(event) => setOpenAiApiKeyInput(event.target.value)}
          />
          <p className="muted">
            Stored in the local config file using OS-backed encryption. Leave blank to keep the
            current key.
          </p>
          <div className="pillWrap">
            {currentState.config.authorizedUsers.map((userId) => (
              <span key={userId} className="pill">
                {userId}
              </span>
            ))}
          </div>
          <label className="fieldLabel" htmlFor="authorized-users">
            Authorized Discord IDs
          </label>
          <textarea
            id="authorized-users"
            className="textInput"
            rows={5}
            value={authorizedUsersInput}
            disabled={!isDesktop}
            onChange={(event) => setAuthorizedUsersInput(event.target.value)}
          />
          <div className="actionRow">
            <button
              className="actionButton"
              onClick={handleSaveConfig}
              disabled={!isDesktop || isSaving}
            >
              {isSaving ? "Saving..." : "Save configuration"}
            </button>
            <button
              className="actionButton secondary"
              onClick={handleClearOpenAiApiKey}
              disabled={!isDesktop || isSaving || !currentState.config.openAIApiKeyConfigured}
            >
              Clear OpenAI key
            </button>
          </div>
        </Panel>
      </section>

      <section className="grid twoCol">
        <Panel
          title="Remote access"
          description="Loopback-only origin for a named Cloudflare Tunnel. Public auth should be handled by Cloudflare Access."
        >
          <label className="fieldLabel" htmlFor="remote-access-enabled">
            Remote access mode
          </label>
          <select
            id="remote-access-enabled"
            className="textInput"
            value={remoteAccessEnabled ? "enabled" : "disabled"}
            disabled={!isDesktop}
            onChange={(event) => setRemoteAccessEnabled(event.target.value === "enabled")}
          >
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </select>
          <label className="fieldLabel" htmlFor="remote-access-port">
            Remote HTTPS port
          </label>
          <input
            id="remote-access-port"
            className="textInput"
            type="number"
            min={1}
            max={65535}
            value={remoteAccessPortInput}
            disabled={!isDesktop}
            onChange={(event) => setRemoteAccessPortInput(event.target.value)}
          />
          <div className="pillWrap">
            {currentState.remoteAccess.localUrls.map((remoteUrl) => (
              <span key={remoteUrl} className="pill">
                {remoteUrl}
              </span>
            ))}
          </div>
          <p className="muted">
            Status: {currentState.remoteAccess.status}. Local proxy stays loopback-only.
          </p>
          <p className="muted">
            Public access should go through a named Cloudflare Tunnel pointed at
            {" "}
            <code>{`http://localhost:${currentState.config.remoteAccessPort}`}</code>.
          </p>
          <p className="muted">
            Do not port-forward `3443` or `3210`. Put Cloudflare Access in front of the tunnel hostname and use that as the only public auth layer.
          </p>
          <div className="actionRow">
            <button
              className="actionButton"
              onClick={handleSaveConfig}
              disabled={!isDesktop || isSaving}
            >
              {isSaving ? "Saving..." : "Save remote access"}
            </button>
          </div>
        </Panel>

        <Panel
          title="Command examples"
          description="Simple mention-first commands aligned with the README."
        >
          <div className="codeList">
            {commandExamples.map((command) => (
              <code key={command}>{command}</code>
            ))}
          </div>
        </Panel>

        <Panel
          title="Session overview"
          description="Persistent shell sessions that can receive follow-up commands."
        >
          <div className="actionRow">
            <button
              className="actionButton"
              onClick={handleCreateSession}
              disabled={!isDesktop || isStartingSession}
            >
              {isStartingSession ? "Creating..." : "Create session"}
            </button>
          </div>
          <div className="sessionList">
            {currentState.sessions.length === 0 ? (
              <article className="sessionCard">
                <p>No sessions created yet. Use the button above to scaffold a local shell session.</p>
              </article>
            ) : null}
            {currentState.sessions.map((session) => (
              <article key={session.id} className="sessionCard">
                <div className="sessionTop">
                  <strong>{session.id}</strong>
                  <span className={`statusBadge ${session.status === "active" ? "active" : "idle"}`}>
                    {session.status}
                  </span>
                </div>
                <p>{session.shell}</p>
                <p className="muted">Last command: {session.lastCommand}</p>
                <p className="muted">Created {formatTimestamp(session.createdAt)}</p>
              </article>
            ))}
          </div>
        </Panel>
      </section>

      <section className="grid logLayout">
        <Panel
          title="Recent logs"
          description="Operational trail for received commands, actions, and ignored events."
        >
          <div className="logList">
            {currentState.logs.map((entry) => (
              <div key={entry.id} className="logEntry">
                <div className="logMeta">
                  <span>{formatTimestamp(entry.timestamp)}</span>
                  <span style={{ color: levelTone[entry.level] }}>{entry.level}</span>
                </div>
                <p>{entry.message}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel
          title="Settings snapshot"
          description="Early dashboard placeholders for the local configuration layer."
        >
          <dl className="stackList">
            {settings.map((setting) => (
              <div key={setting.label} className="settingItem">
                <div>
                  <dt>{setting.label}</dt>
                  <dd>{setting.hint}</dd>
                </div>
                <strong>{setting.value}</strong>
              </div>
            ))}
          </dl>
        </Panel>
      </section>
    </main>
  );
}

function UpdateOverlay({
  state,
  onInstall,
}: {
  state: SiyloState;
  onInstall: () => Promise<void>;
}) {
  const updateState = state.update;
  const progress = Math.round(updateState.progressPercent || 0);
  const speed =
    updateState.bytesPerSecond > 0 ? `${formatBytes(updateState.bytesPerSecond)}/s` : "";
  const downloadSize =
    updateState.transferredBytes > 0 && updateState.totalBytes > 0
      ? `${formatBytes(updateState.transferredBytes)} of ${formatBytes(updateState.totalBytes)}`
      : "";

  return (
    <section className="updateOverlay card" aria-live="polite">
      <div className="updateCopy">
        <p className="eyebrow">Updater</p>
        <h2>
          {updateState.status === "checking" && "Checking GitHub Releases"}
          {updateState.status === "available" && `Update ${updateState.availableVersion} found`}
          {updateState.status === "downloading" && `Downloading ${updateState.availableVersion}`}
          {updateState.status === "downloaded" && `Update ${updateState.availableVersion} ready`}
          {updateState.status === "error" && "Update check failed"}
        </h2>
        <p className="lede">
          {updateState.status === "checking" &&
            `Current build ${updateState.currentVersion} is comparing against the latest release.`}
          {updateState.status === "available" &&
            "The installer download started automatically in the background."}
          {updateState.status === "downloading" &&
            `${progress}% complete${downloadSize ? `, ${downloadSize}` : ""}${
              speed ? ` at ${speed}` : ""
            }.`}
          {updateState.status === "downloaded" &&
            "Restart the app to install the downloaded release."}
          {updateState.status === "error" &&
            (updateState.errorMessage || "The updater reported an unexpected error.")}
        </p>
      </div>
      {updateState.status === "downloading" ? (
        <div className="progressTrack" aria-hidden="true">
          <div className="progressFill" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {updateState.status === "downloaded" ? (
        <div className="actionRow">
          <button className="actionButton" onClick={onInstall}>
            Restart to install
          </button>
        </div>
      ) : null}
    </section>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const nextValue = value / 1024 ** exponent;

  return `${nextValue.toFixed(nextValue >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function Panel({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card panel">
      <div className="panelHeader">
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? "metricAccent" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
