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
  config: {
    botToken: "",
    authorizedUsers: ["123456789012345678", "987654321098765432"],
    dashboardPort: 3000,
    autoConnect: false,
    commandPrefix: "@siylo"
  },
  sessions: [
    {
      id: "cmd-1",
      shell: "cmd",
      status: "idle",
      lastCommand: "npm run dev",
      createdAt: new Date().toISOString()
    }
  ],
  logs: [
    {
      id: "browser-preview",
      level: "info",
      message: "Browser dashboard preview loaded without Electron runtime access.",
      timestamp: new Date().toISOString()
    }
  ]
};

export function DashboardShell() {
  const [state, setState] = useState<SiyloState>(browserFallbackState);
  const [authorizedUsersInput, setAuthorizedUsersInput] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isStartingSession, setIsStartingSession] = useState(false);
  const isDesktop = typeof window !== "undefined" && Boolean(window.siylo);

  useEffect(() => {
    if (!window.siylo) {
      setState(browserFallbackState);
      return;
    }

    let mounted = true;

    window.siylo.getState().then((nextState) => {
      if (mounted) {
        setState(nextState);
      }
    });

    const unsubscribe = window.siylo.onStateChanged((nextState) => {
      setState(nextState);
    });

    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    setAuthorizedUsersInput(state.config.authorizedUsers.join("\n"));
  }, [state]);

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
      }
    ];
  }, [state]);

  const currentState = state;
  const agentState = currentState.isConnected ? "running" : "stopped";
  const connectionLabel = currentState.isConnected ? "Connected" : "Disconnected";
  const latestLog = currentState.logs[0]?.timestamp
    ? formatTimestamp(currentState.logs[0].timestamp)
    : "Awaiting activity";
  const machineName =
    typeof window !== "undefined" ? window.navigator.platform || "Local machine" : "Local machine";

  async function handleStartStop() {
    if (!window.siylo) {
      return;
    }

    if (currentState.isConnected) {
      const nextState = await window.siylo.stop();
      setState(nextState);
      return;
    }

    const nextState = await window.siylo.start();
    setState(nextState);
  }

  async function handleSaveUsers() {
    if (!window.siylo) {
      return;
    }

    setIsSaving(true);

    try {
      const nextState = await window.siylo.updateConfig({
        authorizedUsers: authorizedUsersInput
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean)
      });

      setState(nextState);
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

  return (
    <main className="shell">
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
          <Metric label="Discord" value={connectionLabel} />
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
              label="Command intake"
              value={currentState.isConnected ? "Authorized mentions only" : "Paused"}
            />
            <Row label="Tray mode" value="Primary control surface" />
            <Row
              label="Dashboard mode"
              value={isDesktop ? "Electron runtime" : "Browser preview"}
            />
          </dl>
          <div className="actionRow">
            <button className="actionButton" onClick={handleStartStop} disabled={!isDesktop}>
              {currentState.isConnected ? "Stop agent" : "Start agent"}
            </button>
            <button
              className="actionButton secondary"
              onClick={() => window.siylo?.openDashboard()}
              disabled={!isDesktop}
            >
              Open in browser
            </button>
          </div>
        </Panel>

        <Panel
          title="Authorized users"
          description="Only these Discord IDs can trigger actions on this machine."
        >
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
              onClick={handleSaveUsers}
              disabled={!isDesktop || isSaving}
            >
              {isSaving ? "Saving..." : "Save users"}
            </button>
          </div>
        </Panel>
      </section>

      <section className="grid twoCol">
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
