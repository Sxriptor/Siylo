"use client";

import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./radio-shell.module.css";

const DEFAULT_SESSION_IDS = ["cmd-1", "cmd-2", "cursor", "codex"];
const LAUNCHER_TARGETS = ["cmd", "powershell", "cursor", "codex"] as const;
const SESSION_STORAGE_KEY = "siylo-radio-session-id";
const RADIO_API_BASE = process.env.NEXT_PUBLIC_RADIO_API_BASE?.replace(/\/$/, "") ?? "";
const HOLD_TO_RECORD_DELAY_MS = 1000;
const DOUBLE_TAP_WINDOW_MS = 360;
const SESSION_POLL_INTERVAL_MS = 900;
const PENDING_SESSION_GRACE_MS = 5000;

type RadioStatus = "idle" | "listening" | "processing" | "executed" | "error";

type VoiceResponse = {
  output?: string;
  route?: string;
  sessionId?: string;
  transcript?: string;
  status?: string;
  error?: string;
};

type SessionStreamResponse = {
  error?: string;
  inputAvailable?: boolean;
  isBusy?: boolean;
  message?: string;
  output?: string;
  outputAvailable?: boolean;
  sessionId?: string;
  status?: string;
};

type HealthResponse = {
  status?: string;
  voice?: {
    status?: string;
    url?: string;
    provider?: string;
    lastError?: string;
  };
  sessions?: Array<{
    id: string;
  }>;
};

export function RadioShell() {
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState(DEFAULT_SESSION_IDS[0]);
  const [voiceApiBase, setVoiceApiBase] = useState("");
  const [status, setStatus] = useState<RadioStatus>("idle");
  const [isPressingToRecord, setIsPressingToRecord] = useState(false);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [inspectorSessionId, setInspectorSessionId] = useState<string | null>(null);
  const [sessionStream, setSessionStream] = useState<SessionStreamResponse | null>(null);
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [isSendingTerminalInput, setIsSendingTerminalInput] = useState(false);

  const streamRef = useRef<MediaStream | null>(null);
  const streamRequestRef = useRef<Promise<MediaStream> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const activePointerIdRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartedRef = useRef(false);
  const pressTargetRef = useRef<string | null>(null);
  const lastSessionTapRef = useRef<{
    sessionId: string;
    timestamp: number;
  } | null>(null);
  const activeSessionIdRef = useRef(currentSessionId);
  const sessionIdsRef = useRef(sessionIds);
  const terminalInputRef = useRef<HTMLInputElement | null>(null);
  const confirmedSessionIdsRef = useRef<string[]>([]);
  const pendingSessionTimeoutsRef = useRef<Record<string, number>>({});

  const isBusy = status === "processing";
  const isListening = status === "listening";
  const sessionSlots = useMemo(() => buildSessionSlots(sessionIds), [sessionIds]);
  const inspectorStatusLabel = getInspectorStatusLabel(sessionStream);

  useEffect(() => {
    const storedSessionId = window.localStorage.getItem(SESSION_STORAGE_KEY);

    if (storedSessionId) {
      setCurrentSessionId(storedSessionId);
      activeSessionIdRef.current = storedSessionId;
      return;
    }

    const legacyStoredIndex = Number(window.localStorage.getItem("siylo-radio-session-index"));
    if (!Number.isNaN(legacyStoredIndex) && DEFAULT_SESSION_IDS[legacyStoredIndex]) {
      const fallbackSessionId = DEFAULT_SESSION_IDS[legacyStoredIndex];
      setCurrentSessionId(fallbackSessionId);
      activeSessionIdRef.current = fallbackSessionId;
    }
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = currentSessionId;
    window.localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
  }, [currentSessionId]);

  useEffect(() => {
    sessionIdsRef.current = sessionIds;
  }, [sessionIds]);

  useEffect(() => {
    if (sessionIds.length > 0 && !sessionIds.includes(currentSessionId)) {
      const fallbackSessionId = sessionIds[0];
      setCurrentSessionId(fallbackSessionId);
    }
  }, [currentSessionId, sessionIds]);

  useEffect(() => {
    if (sessionIds.length > 0 && inspectorSessionId && !sessionIds.includes(inspectorSessionId)) {
      closeInspector();
    }
  }, [inspectorSessionId, sessionIds]);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (!window.isSecureContext && window.location.hostname !== "localhost") {
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration failure should not block the radio flow.
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshHealth() {
      const health = await probeVoiceBackend();
      if (cancelled) {
        return;
      }

      if (!health) {
        setVoiceApiBase("");
        return;
      }

      const confirmedSessionIds = mergeSessionIds(health.payload.sessions?.map((session) => session.id) || []);
      confirmedSessionIdsRef.current = confirmedSessionIds;
      clearConfirmedPendingSessionTimeouts(confirmedSessionIds, pendingSessionTimeoutsRef.current);
      const visibleSessionIds = sessionIdsRef.current;
      for (const sessionId of visibleSessionIds) {
        if (!confirmedSessionIds.includes(sessionId)) {
          ensureSessionGraceTimeout(sessionId, pendingSessionTimeoutsRef, confirmedSessionIdsRef, setSessionIds);
        }
      }
      setVoiceApiBase(health.baseUrl);
      setSessionIds(mergeSessionIds([...confirmedSessionIds, ...visibleSessionIds]));
    }

    void refreshHealth();
    const intervalId = window.setInterval(() => {
      void refreshHealth();
    }, 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!inspectorSessionId || !voiceApiBase) {
      return;
    }

    const sessionId = inspectorSessionId as string;
    let cancelled = false;

    async function refreshSessionStream() {
      try {
        const response = await fetch(`${voiceApiBase}/sessions/${encodeURIComponent(sessionId)}/output`, {
          cache: "no-store"
        });
        const payload = await parseJsonResponse<SessionStreamResponse>(response);
        if (cancelled) {
          return;
        }

        setSessionStream(payload || null);
      } catch {
        if (cancelled) {
          return;
        }

        setSessionStream({
          error: "Unable to load live stdout.",
          output: "",
          outputAvailable: false,
          sessionId,
          status: "error"
        });
      }
    }

    void refreshSessionStream();
    const intervalId = window.setInterval(() => {
      void refreshSessionStream();
    }, SESSION_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [inspectorSessionId, voiceApiBase]);

  useEffect(() => {
    if (!inspectorSessionId) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeInspector();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [inspectorSessionId]);

  useEffect(() => {
    if (isKeyboardOpen) {
      terminalInputRef.current?.focus();
    }
  }, [isKeyboardOpen]);

  useEffect(() => {
    return () => {
      clearHoldTimer(holdTimerRef);
      clearPendingSessionTimeouts(pendingSessionTimeoutsRef.current);

      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }

      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, []);

  async function handleHoldStart(pointerId: number) {
    if (isBusy || isListening || inspectorSessionId) {
      return;
    }

    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      return;
    }

    activePointerIdRef.current = pointerId;
    setIsLauncherOpen(false);
    lastSessionTapRef.current = null;

    try {
      const stream = await getOrCreateStream(streamRef, streamRequestRef);

      if (activePointerIdRef.current !== pointerId) {
        return;
      }

      const mimeType = getSupportedMimeType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

      chunksRef.current = [];
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onerror = () => {
        setStatus("error");
      };
      recorder.onstop = async () => {
        recorderRef.current = null;
        holdStartedRef.current = false;
        const blobType = recorder.mimeType || mimeType || "audio/webm";
        const audioBlob = new Blob(chunksRef.current, { type: blobType });
        chunksRef.current = [];

        if (audioBlob.size === 0) {
          setStatus("idle");
          return;
        }

        await uploadRecording(audioBlob, activeSessionIdRef.current);
      };

      recorder.start();
      holdStartedRef.current = true;
      setStatus("listening");
    } catch {
      holdStartedRef.current = false;
      setIsPressingToRecord(false);
      setStatus("error");
      activePointerIdRef.current = null;
    }
  }

  function handlePressStart(pointerId: number, target: HTMLElement) {
    if (isBusy || isListening || inspectorSessionId) {
      return;
    }

    if (target.closest(`.${styles.launcherPanel}`) || target.closest(`.${styles.inspectorPanel}`)) {
      return;
    }

    if (activePointerIdRef.current !== null) {
      return;
    }

    activePointerIdRef.current = pointerId;
    setIsPressingToRecord(true);
    pressTargetRef.current =
      target.closest<HTMLElement>(`[data-session-id]`)?.dataset.sessionId ||
      (target.closest<HTMLElement>("[data-launcher-trigger='true']") ? "__launcher__" : null);
    holdStartedRef.current = false;
    clearHoldTimer(holdTimerRef);
    void getOrCreateStream(streamRef, streamRequestRef).catch(() => {
      // Surface the real failure when the long-press recording path runs.
    });
    holdTimerRef.current = window.setTimeout(() => {
      if (activePointerIdRef.current !== pointerId) {
        return;
      }

      void handleHoldStart(pointerId);
    }, HOLD_TO_RECORD_DELAY_MS);
  }

  function handleHoldEnd(pointerId: number) {
    if (activePointerIdRef.current !== pointerId) {
      return;
    }

    clearHoldTimer(holdTimerRef);
    activePointerIdRef.current = null;
    setIsPressingToRecord(false);

    if (!holdStartedRef.current) {
      const pressedTarget = pressTargetRef.current;
      pressTargetRef.current = null;

      if (pressedTarget === "__launcher__") {
        lastSessionTapRef.current = null;
        setIsLauncherOpen(true);
        setStatus("idle");
        return;
      }

      if (pressedTarget && sessionIdsRef.current.includes(pressedTarget)) {
        const now = Date.now();
        const didDoubleTap =
          lastSessionTapRef.current?.sessionId === pressedTarget &&
          now - lastSessionTapRef.current.timestamp <= DOUBLE_TAP_WINDOW_MS;

        setCurrentSessionId(pressedTarget);
        setStatus("idle");

        if (didDoubleTap) {
          lastSessionTapRef.current = null;
          openInspector(pressedTarget);
          return;
        }

        lastSessionTapRef.current = {
          sessionId: pressedTarget,
          timestamp: now
        };
      }

      return;
    }

    pressTargetRef.current = null;
    lastSessionTapRef.current = null;

    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      setStatus("processing");
      return;
    }

    if (status === "listening") {
      holdStartedRef.current = false;
      setStatus("idle");
    }
  }

  function openInspector(sessionId: string) {
    setCurrentSessionId(sessionId);
    setInspectorSessionId(sessionId);
    setSessionStream(null);
    setIsKeyboardOpen(false);
    setTerminalInput("");
    setIsLauncherOpen(false);
  }

  function closeInspector() {
    setInspectorSessionId(null);
    setSessionStream(null);
    setIsKeyboardOpen(false);
    setTerminalInput("");
    setIsSendingTerminalInput(false);
  }

  async function uploadRecording(audioBlob: Blob, sessionId: string) {
    setStatus("processing");

    try {
      let resolvedVoiceApiBase = voiceApiBase;
      if (!resolvedVoiceApiBase) {
        const health = await probeVoiceBackend();
        resolvedVoiceApiBase = health?.baseUrl || "";

        if (resolvedVoiceApiBase) {
          setVoiceApiBase(resolvedVoiceApiBase);
        }
      }

      if (!resolvedVoiceApiBase) {
        throw new Error("Voice backend unavailable.");
      }

      const formData = new FormData();
      formData.append("audio", audioBlob, `radio-input.${getFileExtension(audioBlob.type)}`);
      formData.append("sessionId", sessionId);

      const response = await fetch(`${resolvedVoiceApiBase}/voice`, {
        method: "POST",
        body: formData
      });

      const payload = await parseVoiceResponse(response);

      if (!response.ok) {
        throw new Error(payload?.error || `Voice request failed with ${response.status}.`);
      }

      applyVoicePayload(payload);
      setStatus("executed");
    } catch {
      setStatus("error");
    }
  }

  async function handleLauncherOpen(target: (typeof LAUNCHER_TARGETS)[number]) {
    setIsLauncherOpen(false);
    setStatus("processing");

    if (!voiceApiBase) {
      setStatus("error");
      return;
    }

    try {
      const response = await fetch(`${voiceApiBase}/voice`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          transcript: `open ${target}`
        })
      });

      const payload = await parseVoiceResponse(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Open request failed with ${response.status}.`);
      }

      applyVoicePayload(payload);
      setStatus("executed");
    } catch {
      setStatus("error");
    }
  }

  async function handleTerminalSubmit() {
    if (!inspectorSessionId || !voiceApiBase || !terminalInput.trim()) {
      return;
    }

    const sessionId = inspectorSessionId as string;
    setIsSendingTerminalInput(true);

    try {
      const response = await fetch(`${voiceApiBase}/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: terminalInput.trim()
        })
      });
      const payload = await parseJsonResponse<SessionStreamResponse>(response);

      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal input failed with ${response.status}.`);
      }

      setSessionStream(payload || null);
      setTerminalInput("");
    } catch {
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        error: "Unable to send terminal input.",
        status: "error"
      }));
    } finally {
      setIsSendingTerminalInput(false);
    }
  }

  async function handleTerminalKeyInput(keyName: string) {
    if (!inspectorSessionId || !voiceApiBase) {
      return;
    }

    const sessionId = inspectorSessionId as string;
    setIsSendingTerminalInput(true);

    try {
      const response = await fetch(`${voiceApiBase}/sessions/${encodeURIComponent(sessionId)}/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          key: keyName
        })
      });
      const payload = await parseJsonResponse<SessionStreamResponse>(response);

      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal key send failed with ${response.status}.`);
      }

      setSessionStream(payload || null);
    } catch {
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        error: "Unable to send terminal key input.",
        status: "error"
      }));
    } finally {
      setIsSendingTerminalInput(false);
    }
  }

  function applyVoicePayload(payload: VoiceResponse | null) {
    if (!payload?.sessionId) {
      return;
    }

    const sessionId = normalizeSessionId(payload.sessionId);
    if (!sessionId) {
      return;
    }

    registerPendingSession(
      sessionId,
      pendingSessionTimeoutsRef,
      confirmedSessionIdsRef,
      setSessionIds
    );
    setCurrentSessionId(sessionId);
  }

  return (
    <main
      className={`${styles.page} ${isListening ? styles.listening : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.pointerType === "mouse") {
          return;
        }

        if (
          (event.target as HTMLElement).closest(`.${styles.launcherShell}`) ||
          (event.target as HTMLElement).closest(`.${styles.inspectorShell}`)
        ) {
          return;
        }

        event.preventDefault();
        trySetPointerCapture(event.currentTarget, event.pointerId);
        handlePressStart(event.pointerId, event.target as HTMLElement);
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        tryReleasePointerCapture(event.currentTarget, event.pointerId);

        handleHoldEnd(event.pointerId);
      }}
      onPointerCancel={(event) => {
        tryReleasePointerCapture(event.currentTarget, event.pointerId);

        handleHoldEnd(event.pointerId);
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className={styles.sessionContainer}>
        {sessionSlots.map((slot) =>
          slot.kind === "session" ? (
            <div
              key={slot.id}
              data-session-id={slot.id}
              className={`${styles.sessionButton} ${currentSessionId === slot.id ? styles.active : ""}`}
            >
              <span className={styles.sessionLabel}>{formatSessionLabel(slot.id)}</span>
            </div>
          ) : (
            <div
              key={slot.id}
              data-launcher-trigger="true"
              className={`${styles.sessionButton} ${styles.placeholder}`}
              aria-label="Open a new session"
            >
              <span className={styles.plus}>+</span>
            </div>
          )
        )}
      </div>

      {isLauncherOpen ? (
        <div className={styles.launcherShell}>
          <div className={styles.launcherBackdrop} onClick={() => setIsLauncherOpen(false)} aria-hidden="true" />
          <section className={styles.launcherPanel}>
            <p className={styles.launcherTitle}>Open</p>
            <div className={styles.launcherGrid}>
              {LAUNCHER_TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  className={styles.launcherButton}
                  onClick={() => void handleLauncherOpen(target)}
                >
                  {formatSessionLabel(target)}
                </button>
              ))}
            </div>
            <button type="button" className={styles.launcherDismiss} onClick={() => setIsLauncherOpen(false)}>
              Cancel
            </button>
          </section>
        </div>
      ) : null}

      {inspectorSessionId ? (
        <div className={styles.inspectorShell}>
          <div className={styles.inspectorBackdrop} onClick={closeInspector} aria-hidden="true" />
          <section className={styles.inspectorPanel}>
            <header className={styles.inspectorHeader}>
              <div>
                <p className={styles.inspectorEyebrow}>Live Stdout</p>
                <h2 className={styles.inspectorTitle}>{formatSessionLabel(inspectorSessionId)}</h2>
              </div>
              <div className={styles.inspectorControls}>
                <span className={styles.inspectorStatus}>{inspectorStatusLabel}</span>
                <button
                  type="button"
                  className={styles.iconButton}
                  onClick={() => setIsKeyboardOpen((currentValue) => !currentValue)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <rect x="2.75" y="6.25" width="18.5" height="11.5" rx="2.25" />
                    <path d="M6.5 10.25h.01" />
                    <path d="M9.5 10.25h.01" />
                    <path d="M12.5 10.25h.01" />
                    <path d="M15.5 10.25h.01" />
                    <path d="M6.5 13.25h.01" />
                    <path d="M9.5 13.25h.01" />
                    <path d="M12.5 13.25h.01" />
                    <path d="M15.5 13.25h.01" />
                    <path d="M7 16.25h10" />
                  </svg>
                </button>
                <button type="button" className={styles.closeButton} onClick={closeInspector}>
                  Close
                </button>
              </div>
            </header>

            <pre className={styles.outputPanel}>
              {sessionStream?.outputAvailable === false
                ? sessionStream.message || sessionStream.error || "Live stdout is not available for this session."
                : sessionStream?.output || "Waiting for terminal output..."}
            </pre>

            {sessionStream?.error ? <p className={styles.inspectorMessage}>{sessionStream.error}</p> : null}

            {isKeyboardOpen ? (
              <form
                className={styles.keyboardDock}
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleTerminalSubmit();
                }}
              >
                <input
                  ref={terminalInputRef}
                  className={styles.keyboardInput}
                  type="text"
                  value={terminalInput}
                  disabled={isSendingTerminalInput || sessionStream?.inputAvailable === false}
                  onChange={(event) => setTerminalInput(event.target.value)}
                  placeholder={
                    sessionStream?.inputAvailable === false
                      ? "Keyboard input is not available for this session"
                      : "Type a command and press Send"
                  }
                />
                <div className={styles.keyboardActions}>
                  <button
                    type="button"
                    className={styles.keyboardButton}
                    disabled={isSendingTerminalInput || sessionStream?.inputAvailable === false}
                    onClick={() => void handleTerminalKeyInput("enter")}
                  >
                    Enter
                  </button>
                  <button
                    type="button"
                    className={`${styles.keyboardButton} ${styles.keyboardButtonMuted}`}
                    disabled={isSendingTerminalInput || sessionStream?.inputAvailable === false}
                    onClick={() => void handleTerminalKeyInput("ctrl+c")}
                  >
                    Ctrl+C
                  </button>
                  <button
                    type="submit"
                    className={styles.keyboardButton}
                    disabled={
                      isSendingTerminalInput ||
                      sessionStream?.inputAvailable === false ||
                      !terminalInput.trim()
                    }
                  >
                    {isSendingTerminalInput ? "Sending..." : "Send"}
                  </button>
                </div>
              </form>
            ) : null}
          </section>
        </div>
      ) : null}

      <div
        className={`${styles.micIconContainer} ${isListening || isPressingToRecord ? styles.micIconContainerActive : ""}`}
      >
        <svg
          className={`${styles.micIcon} ${isListening || isPressingToRecord ? styles.micIconActive : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" x2="12" y1="19" y2="22" />
        </svg>
      </div>
    </main>
  );
}

function clearHoldTimer(timerRef: MutableRefObject<number | null>) {
  if (timerRef.current === null) {
    return;
  }

  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function clearPendingSessionTimeouts(timeouts: Record<string, number>) {
  for (const timeoutId of Object.values(timeouts)) {
    window.clearTimeout(timeoutId);
  }
}

function clearConfirmedPendingSessionTimeouts(
  confirmedSessionIds: string[],
  pendingSessionTimeouts: Record<string, number>
) {
  for (const sessionId of confirmedSessionIds) {
    const timeoutId = pendingSessionTimeouts[sessionId];
    if (!timeoutId) {
      continue;
    }

    window.clearTimeout(timeoutId);
    delete pendingSessionTimeouts[sessionId];
  }
}

function registerPendingSession(
  sessionId: string,
  pendingSessionTimeoutsRef: MutableRefObject<Record<string, number>>,
  confirmedSessionIdsRef: MutableRefObject<string[]>,
  setSessionIds: Dispatch<SetStateAction<string[]>>
) {
  const existingTimeoutId = pendingSessionTimeoutsRef.current[sessionId];
  if (existingTimeoutId) {
    window.clearTimeout(existingTimeoutId);
    delete pendingSessionTimeoutsRef.current[sessionId];
  }

  ensureSessionGraceTimeout(sessionId, pendingSessionTimeoutsRef, confirmedSessionIdsRef, setSessionIds);
  setSessionIds((currentIds) => mergeSessionIds([sessionId, ...currentIds]));
}

function ensureSessionGraceTimeout(
  sessionId: string,
  pendingSessionTimeoutsRef: MutableRefObject<Record<string, number>>,
  confirmedSessionIdsRef: MutableRefObject<string[]>,
  setSessionIds: Dispatch<SetStateAction<string[]>>
) {
  if (pendingSessionTimeoutsRef.current[sessionId]) {
    return;
  }

  pendingSessionTimeoutsRef.current[sessionId] = window.setTimeout(() => {
    delete pendingSessionTimeoutsRef.current[sessionId];

    if (confirmedSessionIdsRef.current.includes(sessionId)) {
      return;
    }

    setSessionIds((currentIds) => currentIds.filter((currentSessionId) => currentSessionId !== sessionId));
  }, PENDING_SESSION_GRACE_MS);
}

async function getOrCreateStream(
  streamRef: RefObject<MediaStream | null>,
  streamRequestRef: MutableRefObject<Promise<MediaStream> | null>
) {
  const existing = streamRef.current;

  if (existing && existing.active) {
    return existing;
  }

  if (streamRequestRef.current) {
    return streamRequestRef.current;
  }

  streamRequestRef.current = navigator.mediaDevices
    .getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    })
    .then((stream) => {
      streamRef.current = stream;
      return stream;
    })
    .finally(() => {
      streamRequestRef.current = null;
    });

  return streamRequestRef.current;
}

function trySetPointerCapture(target: HTMLElement, pointerId: number) {
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // Some mobile browsers can reject pointer capture during gesture transitions.
  }
}

function tryReleasePointerCapture(target: HTMLElement, pointerId: number) {
  try {
    if (target.hasPointerCapture(pointerId)) {
      target.releasePointerCapture(pointerId);
    }
  } catch {
    // Ignore missing capture state so release does not break hold handling.
  }
}

function getSupportedMimeType() {
  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];

  return preferredTypes.find((type) => MediaRecorder.isTypeSupported(type));
}

async function parseVoiceResponse(response: Response) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    return (await response.json()) as VoiceResponse;
  }

  const text = await response.text();
  return text ? ({ status: text } satisfies VoiceResponse) : null;
}

async function parseJsonResponse<T>(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return (await response.json()) as T;
}

function getFileExtension(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  return "webm";
}

async function probeVoiceBackend() {
  const candidateBaseUrls = resolveVoiceApiCandidates();

  for (const candidateBaseUrl of candidateBaseUrls) {
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 1800);

    try {
      const response = await fetch(`${candidateBaseUrl}/health`, {
        cache: "no-store",
        signal: controller.signal
      });

      if (!response.ok) {
        continue;
      }

      const payload = (await response.json()) as HealthResponse;
      return {
        baseUrl: candidateBaseUrl,
        payload
      };
    } catch {
      continue;
    } finally {
      window.clearTimeout(timeoutId);
    }
  }

  return null;
}

function resolveVoiceApiCandidates() {
  const params = new URLSearchParams(window.location.search);
  const configuredVoiceUrl = sanitizeBaseUrl(params.get("voiceUrl"));
  const configuredVoicePort = Number(params.get("voicePort"));
  const hostname = window.location.hostname;
  const candidates = [
    RADIO_API_BASE,
    configuredVoiceUrl,
    window.location.origin,
    Number.isInteger(configuredVoicePort) && configuredVoicePort > 0
      ? `http://127.0.0.1:${configuredVoicePort}`
      : "",
    hostname && hostname !== "localhost" && hostname !== "127.0.0.1" ? `http://${hostname}:3210` : "",
    "http://127.0.0.1:3210"
  ];

  return Array.from(
    new Set(
      candidates
        .map((value) => sanitizeBaseUrl(value))
        .filter((value): value is string => Boolean(value))
    )
  );
}

function sanitizeBaseUrl(value: string | null | undefined) {
  const normalizedValue = String(value || "").trim().replace(/\/$/, "");

  if (!normalizedValue) {
    return "";
  }

  try {
    return new URL(normalizedValue).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function mergeSessionIds(sessionIds: string[]) {
  const merged = sessionIds
    .map((sessionId) => String(sessionId || "").trim().toLowerCase())
    .filter(Boolean);

  return Array.from(new Set(merged));
}

function normalizeSessionId(sessionId: string | null | undefined) {
  return mergeSessionIds([sessionId || ""])[0] || "";
}

function buildSessionSlots(sessionIds: string[]) {
  const orderedSessions = sortSessionIds(sessionIds).slice(0, 4);
  const slots: Array<
    | {
        kind: "session";
        id: string;
      }
    | {
        kind: "placeholder";
        id: string;
      }
  > = orderedSessions.map((sessionId) => ({ kind: "session", id: sessionId }));

  if (slots.length < 4) {
    slots.push({ kind: "placeholder", id: "launcher-placeholder" });
  }

  return slots;
}

function sortSessionIds(sessionIds: string[]) {
  return [...sessionIds].sort((left, right) => {
    const leftIndex = DEFAULT_SESSION_IDS.indexOf(left);
    const rightIndex = DEFAULT_SESSION_IDS.indexOf(right);

    if (leftIndex >= 0 && rightIndex >= 0) {
      return leftIndex - rightIndex;
    }

    if (leftIndex >= 0) {
      return -1;
    }

    if (rightIndex >= 0) {
      return 1;
    }

    return left.localeCompare(right);
  });
}

function formatSessionLabel(sessionId: string) {
  const normalized = String(sessionId || "").trim().toLowerCase();

  if (!normalized) {
    return "Unknown";
  }

  const labelMap: Record<string, string> = {
    browser: "Browser",
    cmd: "CMD",
    codex: "Codex",
    cursor: "Cursor",
    kiro: "Kiro",
    powershell: "PowerShell",
    vscode: "VS Code"
  };

  if (labelMap[normalized]) {
    return labelMap[normalized];
  }

  if (/^(cmd|powershell)-\d+$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getInspectorStatusLabel(stream: SessionStreamResponse | null) {
  if (!stream) {
    return "Connecting";
  }

  if (stream.outputAvailable === false) {
    return "No stream";
  }

  if (stream.isBusy) {
    return "Running";
  }

  return "Ready";
}
