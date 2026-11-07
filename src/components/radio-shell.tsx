"use client";

import type { Dispatch, MutableRefObject, PointerEvent, RefObject, SetStateAction, WheelEvent } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import styles from "./radio-shell.module.css";
import { GitPanel } from "./git-panel";

const DEFAULT_SESSION_IDS = ["cmd-1", "cmd-2", "cursor", "codex"];
const LAUNCHER_TARGETS = ["cmd", "powershell", "cursor", "codex"] as const;
const TERMINAL_LAUNCHER_TARGETS = new Set(["cmd", "powershell", "codex"]);
const SESSION_STORAGE_KEY = "siylo-radio-session-id";
const SPEECH_VOLUME_STORAGE_KEY = "siylo-radio-speech-volume";
const SPEAK_RESULTS_STORAGE_KEY = "siylo-radio-speak-results";
const FONT_SIZE_STORAGE_KEY = "siylo-radio-terminal-font";
const FIT_WIDTH_STORAGE_KEY = "siylo-radio-fit-width";
const MIC_ENABLED_STORAGE_KEY = "siylo-radio-mic-enabled";
const RADIO_API_BASE = process.env.NEXT_PUBLIC_RADIO_API_BASE?.replace(/\/$/, "") ?? "";
const HOLD_TO_RECORD_DELAY_MS = 1000;
const SESSION_POLL_INTERVAL_MS = 650;
const STATUS_POLL_INTERVAL_MS = 1500;
const TOAST_DURATION_MS = 7000;
const MIN_TERMINAL_FONT = 10;
const MAX_TERMINAL_FONT = 20;
const DEFAULT_TERMINAL_FONT = 13;
const TERMINAL_KEYS: Array<{ key: string; label: string; aria: string }> = [
  { key: "ctrl+c", label: "Ctrl+C", aria: "Send Ctrl+C (stop)" },
  { key: "esc", label: "Esc", aria: "Send Escape" },
  { key: "tab", label: "Tab", aria: "Send Tab" },
  { key: "up", label: "↑", aria: "Send arrow up" },
  { key: "down", label: "↓", aria: "Send arrow down" },
  { key: "left", label: "←", aria: "Send arrow left" },
  { key: "right", label: "→", aria: "Send arrow right" },
  { key: "y", label: "y", aria: "Send the letter y" },
  { key: "n", label: "n", aria: "Send the letter n" }
];
const PENDING_SESSION_GRACE_MS = 5000;
const MIN_AUDIBLE_PEAK = 0.015;
const MIN_AUDIBLE_RMS = 0.003;
const NATIVE_VOLUME_POINTER_ID = 989001;
const TRACKPAD_TOUCH_DEADZONE_PX = 6;
const TRACKPAD_TOUCH_SENSITIVITY = 0.62;

type RadioStatus = "idle" | "listening" | "processing" | "executed" | "error";
type RadioView = "sessions" | "viewer";

type VoiceResponse = {
  output?: string;
  route?: string;
  sessionId?: string;
  transcript?: string;
  status?: string;
  error?: string;
};

type SessionStreamResponse = {
  activity?: string;
  error?: string;
  inputAvailable?: boolean;
  isBusy?: boolean;
  message?: string;
  missing?: boolean;
  output?: string;
  outputAvailable?: boolean;
  runStartedAt?: number;
  sessionId?: string;
  status?: string;
  unchanged?: boolean;
  version?: number;
  waitingForInput?: boolean;
};

type SessionStatus = {
  id: string;
  shell?: string;
  activity?: "idle" | "running" | "app" | string;
  isBusy?: boolean;
  lastCommand?: string;
  lastFinishedAt?: number;
  lastEventKind?: string;
  lastLine?: string;
  runStartedAt?: number;
  version?: number;
  waitingForInput?: boolean;
};

type SessionEvent = {
  sessionId: string;
  kind: "finished" | "input" | "stopped" | "exited" | string;
  durationMs?: number;
  command?: string;
  summary?: string;
  at?: number;
  seq: number;
};

type StatusResponse = {
  status?: string;
  now?: number;
  sessions?: SessionStatus[];
  events?: SessionEvent[];
  seq?: number;
};

type ToastEntry = {
  id: number;
  sessionId: string;
  kind: string;
  title: string;
  body: string;
};

type ConnectionState = "connecting" | "online" | "offline";
type PushState = "unknown" | "unsupported" | "needs-install" | "denied" | "off" | "on" | "working";

type DesktopFrameState = {
  screenWidth: number;
  screenHeight: number;
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
  const [activeView, setActiveView] = useState<RadioView>("sessions");
  const [isPressingToRecord, setIsPressingToRecord] = useState(false);
  const [isLauncherOpen, setIsLauncherOpen] = useState(false);
  const [inspectorSessionId, setInspectorSessionId] = useState<string | null>(null);
  const [sessionStream, setSessionStream] = useState<SessionStreamResponse | null>(null);
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, SessionStatus>>({});
  const [unreadSessions, setUnreadSessions] = useState<Record<string, string>>({});
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [serverClockOffset, setServerClockOffset] = useState(0);
  const [speakResults, setSpeakResults] = useState(true);
  const [terminalFontSize, setTerminalFontSize] = useState(DEFAULT_TERMINAL_FONT);
  const [fitTerminalWidth, setFitTerminalWidth] = useState(true);
  // Mic is opt-in: on iOS an open capture stream switches the whole audio
  // session to record mode and pauses other apps (Spotify, etc.).
  const [micEnabled, setMicEnabled] = useState(false);
  const [micMessage, setMicMessage] = useState("");
  const micEnabledRef = useRef(false);
  const [isInspectorMenuOpen, setIsInspectorMenuOpen] = useState(false);
  const [isGitPanelOpen, setIsGitPanelOpen] = useState(false);
  const [isConfirmingKill, setIsConfirmingKill] = useState(false);
  const [isOutputPinnedToBottom, setIsOutputPinnedToBottom] = useState(true);
  const [pushState, setPushState] = useState<PushState>("unknown");
  const [pushMessage, setPushMessage] = useState("");
  const [terminalInput, setTerminalInput] = useState("");
  const [isSendingTerminalInput, setIsSendingTerminalInput] = useState(false);
  const [isSpeakingOutput, setIsSpeakingOutput] = useState(false);
  const [speechVolume, setSpeechVolume] = useState(1);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [desktopFrame, setDesktopFrame] = useState<DesktopFrameState | null>(null);
  const [viewerCursor, setViewerCursor] = useState({ x: 0.5, y: 0.5 });
  const [isViewerControlEnabled, setIsViewerControlEnabled] = useState(true);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerSize, setViewerSize] = useState({ width: 1, height: 1 });
  const [viewerStreamStatus, setViewerStreamStatus] = useState<"loading" | "streaming" | "fallback">("loading");
  const [viewerFallbackImageUrl, setViewerFallbackImageUrl] = useState("");

  const streamRef = useRef<MediaStream | null>(null);
  const streamRequestRef = useRef<Promise<MediaStream> | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const inspectorTalkButtonRef = useRef<HTMLButtonElement | null>(null);
  const mainHoldAreaRef = useRef<HTMLElement | null>(null);
  const viewerWindowRef = useRef<HTMLDivElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const activePointerIdRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartedRef = useRef(false);
  const nativeHoldRequestedRef = useRef(false);
  const pressTargetRef = useRef<string | null>(null);
  const lastSessionTapRef = useRef<{
    sessionId: string;
    timestamp: number;
  } | null>(null);
  const statusRef = useRef(status);
  const inspectorSessionIdRef = useRef(inspectorSessionId);
  const voiceApiBaseRef = useRef(voiceApiBase);
  const activeSessionIdRef = useRef(currentSessionId);
  const sessionIdsRef = useRef(sessionIds);
  const terminalInputRef = useRef<HTMLInputElement | null>(null);
  const outputPanelRef = useRef<HTMLPreElement | null>(null);
  const charMeasureRef = useRef<HTMLSpanElement | null>(null);
  const pinnedToBottomRef = useRef(true);
  const lastEventSeqRef = useRef<number | null>(null);
  const toastIdRef = useRef(0);
  const sessionStreamVersionRef = useRef<number | null>(null);
  const speakResultsRef = useRef(true);
  const hasBeenOnlineRef = useRef(false);
  const lastResizeRef = useRef<string>("");
  const suppressGhostClickUntilRef = useRef(0);
  const confirmedSessionIdsRef = useRef<string[]>([]);
  const pendingSessionTimeoutsRef = useRef<Record<string, number>>({});
  const desktopPointerSendRef = useRef(0);
  const viewerCursorRef = useRef(viewerCursor);
  const viewerFallbackImageUrlRef = useRef("");
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
  const speechAudioContextRef = useRef<AudioContext | null>(null);
  const speechGainNodeRef = useRef<GainNode | null>(null);
  const speechVolumeRef = useRef(1);
  const wasInspectorBusyRef = useRef(false);
  const spokenOutputSignatureRef = useRef("");
  const pendingInspectorSpeechSessionRef = useRef<string | null>(null);
  const speechRequestSeqRef = useRef(0);
  const viewerPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const viewerPinchRef = useRef<{ distance: number; zoom: number } | null>(null);
  const viewerTouchDragRef = useRef<{
    lastX: number;
    lastY: number;
    moved: boolean;
    pointerId: number;
    startX: number;
    startY: number;
  } | null>(null);

  const [liveTranscript, setLiveTranscript] = useState("");
  const liveTranscriptRef = useRef("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const isBusy = status === "processing";
  const isListening = status === "listening";
  const sessionSlots = useMemo(() => buildSessionSlots(sessionIds), [sessionIds]);
  const inspectorStatus = getInspectorStatus(sessionStream, isSendingTerminalInput);
  const inspectorElapsed =
    sessionStream?.isBusy && sessionStream.runStartedAt
      ? formatElapsed(clockNow + serverClockOffset - sessionStream.runStartedAt)
      : "";
  const terminalInputAvailable = Boolean(sessionStream?.inputAvailable) && !sessionStream?.missing;
  const viewerZoomPercent = Math.round(viewerZoom * 100);
  const desktopStreamUrl = voiceApiBase ? `${voiceApiBase}/desktop/stream?fps=5` : "";
  const desktopViewerImageUrl = viewerStreamStatus === "fallback" ? viewerFallbackImageUrl : desktopStreamUrl;
  const viewerLayout = getViewerLayout(viewerZoom, viewerCursor, desktopFrame, viewerSize);

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
    const storedSpeechVolumeRaw = window.localStorage.getItem(SPEECH_VOLUME_STORAGE_KEY);
    const storedSpeechVolume = storedSpeechVolumeRaw === null ? NaN : Number(storedSpeechVolumeRaw);
    if (Number.isFinite(storedSpeechVolume)) {
      const nextVolume = clampRatio(storedSpeechVolume);
      speechVolumeRef.current = nextVolume;
      setSpeechVolume(nextVolume);
    }
  }, []);

  useEffect(() => {
    speechVolumeRef.current = speechVolume;
    window.localStorage.setItem(SPEECH_VOLUME_STORAGE_KEY, String(speechVolume));
    if (speechGainNodeRef.current) {
      speechGainNodeRef.current.gain.value = Math.max(0, speechVolume);
    } else if (speechAudioRef.current) {
      speechAudioRef.current.volume = clampRatio(Math.min(1, speechVolume));
    }
  }, [speechVolume]);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    inspectorSessionIdRef.current = inspectorSessionId;
  }, [inspectorSessionId]);

  useEffect(() => {
    voiceApiBaseRef.current = voiceApiBase;
  }, [voiceApiBase]);

  useEffect(() => {
    activeSessionIdRef.current = currentSessionId;
    window.localStorage.setItem(SESSION_STORAGE_KEY, currentSessionId);
  }, [currentSessionId]);

  useEffect(() => {
    viewerCursorRef.current = viewerCursor;
  }, [viewerCursor]);

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

    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then((registration) => registration.update().catch(() => undefined))
      .catch(() => {
        // Registration failure should not block the radio flow.
      });
  }, []);

  useEffect(() => {
    const viewportMeta = document.querySelector<HTMLMetaElement>("meta[name='viewport']");
    const previousViewportContent = viewportMeta?.getAttribute("content") || "";
    const previousBodyOverflow = document.body.style.overflow;
    const previousBodyTouchAction = document.body.style.touchAction;
    const previousDocumentOverflow = document.documentElement.style.overflow;
    const previousDocumentTouchAction = document.documentElement.style.touchAction;
    const lockedViewportContent =
      "width=device-width, initial-scale=1, minimum-scale=1, maximum-scale=1, viewport-fit=cover, user-scalable=no";

    if (viewportMeta) {
      viewportMeta.setAttribute("content", lockedViewportContent);
    }
    document.body.style.overflow = "hidden";
    document.body.style.touchAction = "none";
    document.documentElement.style.overflow = "hidden";
    document.documentElement.style.touchAction = "none";

    const preventGestureZoom = (event: Event) => {
      event.preventDefault();
    };
    const preventTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) {
        event.preventDefault();
      }
    };

    document.addEventListener("gesturestart", preventGestureZoom, { passive: false });
    document.addEventListener("gesturechange", preventGestureZoom, { passive: false });
    document.addEventListener("gestureend", preventGestureZoom, { passive: false });
    document.addEventListener("touchmove", preventTouchZoom, { passive: false });
    document.addEventListener("dblclick", preventGestureZoom, { passive: false });

    return () => {
      if (viewportMeta) {
        viewportMeta.setAttribute("content", previousViewportContent);
      }
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.touchAction = previousBodyTouchAction;
      document.documentElement.style.overflow = previousDocumentOverflow;
      document.documentElement.style.touchAction = previousDocumentTouchAction;

      document.removeEventListener("gesturestart", preventGestureZoom);
      document.removeEventListener("gesturechange", preventGestureZoom);
      document.removeEventListener("gestureend", preventGestureZoom);
      document.removeEventListener("touchmove", preventTouchZoom);
      document.removeEventListener("dblclick", preventGestureZoom);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | null = null;
    let failureCount = 0;

    function applyConfirmedSessions(sessionList: string[]) {
      const confirmedSessionIds = mergeSessionIds(sessionList);
      confirmedSessionIdsRef.current = confirmedSessionIds;
      clearConfirmedPendingSessionTimeouts(confirmedSessionIds, pendingSessionTimeoutsRef.current);
      const visibleSessionIds = sessionIdsRef.current;
      for (const sessionId of visibleSessionIds) {
        if (!confirmedSessionIds.includes(sessionId)) {
          ensureSessionGraceTimeout(sessionId, pendingSessionTimeoutsRef, confirmedSessionIdsRef, setSessionIds);
        }
      }
      setSessionIds(mergeSessionIds([...confirmedSessionIds, ...visibleSessionIds]));
    }

    function markOnline() {
      failureCount = 0;
      hasBeenOnlineRef.current = true;
      setConnectionState("online");
    }

    function markFailure() {
      failureCount += 1;
      if (failureCount >= 2 || !hasBeenOnlineRef.current) {
        setConnectionState(hasBeenOnlineRef.current ? "offline" : "connecting");
      }
    }

    async function pollStatus() {
      let apiBase = voiceApiBaseRef.current;

      if (!apiBase) {
        const health = await probeVoiceBackend();
        if (cancelled) {
          return;
        }

        if (!health) {
          markFailure();
          return;
        }

        apiBase = health.baseUrl;
        voiceApiBaseRef.current = apiBase;
        setVoiceApiBase(apiBase);
      }

      try {
        const params = new URLSearchParams({
          since: String(lastEventSeqRef.current ?? 0),
          visible: document.visibilityState === "visible" ? "1" : "0",
          viewing: document.visibilityState === "visible" ? inspectorSessionIdRef.current || "" : ""
        });
        const response = await fetchWithTimeout(`${apiBase}/sessions/status?${params.toString()}`, 6000);
        if (!response.ok) {
          throw new Error(`Status failed with ${response.status}`);
        }

        const payload = await parseJsonResponse<StatusResponse>(response);
        if (cancelled || !payload) {
          return;
        }

        markOnline();
        if (typeof payload.now === "number") {
          setServerClockOffset(payload.now - Date.now());
        }

        const statuses = payload.sessions || [];
        const nextStatuses: Record<string, SessionStatus> = {};
        for (const entry of statuses) {
          nextStatuses[String(entry.id).toLowerCase()] = entry;
        }
        setSessionStatuses(nextStatuses);
        applyConfirmedSessions(statuses.map((entry) => entry.id));

        const isFirstPoll = lastEventSeqRef.current === null;
        lastEventSeqRef.current = Number(payload.seq || 0);
        if (!isFirstPoll) {
          for (const event of payload.events || []) {
            handleSessionEvent(event);
          }
        }
      } catch {
        if (cancelled) {
          return;
        }

        markFailure();
        if (failureCount >= 3) {
          // Force re-discovery: the tunnel URL or local port may have changed.
          voiceApiBaseRef.current = "";
          setVoiceApiBase("");
        }
      }
    }

    function scheduleNext() {
      if (cancelled) {
        return;
      }

      const delay = document.visibilityState === "visible" ? STATUS_POLL_INTERVAL_MS : 15000;
      timeoutId = window.setTimeout(async () => {
        await pollStatus();
        scheduleNext();
      }, failureCount > 0 ? Math.min(delay * (failureCount + 1), 8000) : delay);
    }

    function handleVisibilityChange() {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      void pollStatus().then(scheduleNext);
    }

    void pollStatus().then(scheduleNext);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleVisibilityChange);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const hasRunningSession = Object.values(sessionStatuses).some((entry) => entry.activity === "running");
    if (!hasRunningSession && !sessionStream?.isBusy) {
      return;
    }

    setClockNow(Date.now());
    const intervalId = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [sessionStatuses, sessionStream?.isBusy]);

  useEffect(() => {
    speakResultsRef.current = speakResults;
  }, [speakResults]);

  useEffect(() => {
    const storedSpeak = window.localStorage.getItem(SPEAK_RESULTS_STORAGE_KEY);
    if (storedSpeak !== null) {
      setSpeakResults(storedSpeak === "1");
    }

    const storedFont = Number(window.localStorage.getItem(FONT_SIZE_STORAGE_KEY));
    if (Number.isFinite(storedFont) && storedFont >= MIN_TERMINAL_FONT && storedFont <= MAX_TERMINAL_FONT) {
      setTerminalFontSize(storedFont);
    }

    const storedFit = window.localStorage.getItem(FIT_WIDTH_STORAGE_KEY);
    if (storedFit !== null) {
      setFitTerminalWidth(storedFit === "1");
    }

    if (window.localStorage.getItem(MIC_ENABLED_STORAGE_KEY) === "1") {
      micEnabledRef.current = true;
      setMicEnabled(true);
    }
  }, []);

  useEffect(() => {
    micEnabledRef.current = micEnabled;
    window.localStorage.setItem(MIC_ENABLED_STORAGE_KEY, micEnabled ? "1" : "0");
    if (!micEnabled) {
      releaseMicStream(streamRef, streamRequestRef);
    }
  }, [micEnabled]);

  useEffect(() => {
    window.localStorage.setItem(SPEAK_RESULTS_STORAGE_KEY, speakResults ? "1" : "0");
  }, [speakResults]);

  useEffect(() => {
    window.localStorage.setItem(FONT_SIZE_STORAGE_KEY, String(terminalFontSize));
  }, [terminalFontSize]);

  useEffect(() => {
    window.localStorage.setItem(FIT_WIDTH_STORAGE_KEY, fitTerminalWidth ? "1" : "0");
  }, [fitTerminalWidth]);

  // Keep the layout pinned to the *visual* viewport so the on-screen keyboard
  // never covers the command composer (iOS Safari does not resize fixed boxes).
  useEffect(() => {
    const visualViewport = window.visualViewport;
    const root = document.documentElement;

    function syncViewport() {
      const height = visualViewport ? visualViewport.height : window.innerHeight;
      const offsetTop = visualViewport ? visualViewport.offsetTop : 0;
      root.style.setProperty("--radio-vh", `${Math.round(height)}px`);
      root.style.setProperty("--radio-vtop", `${Math.round(offsetTop)}px`);
      const keyboardOpen = window.innerHeight - height > 120;
      root.dataset.radioKeyboard = keyboardOpen ? "open" : "closed";
    }

    syncViewport();
    visualViewport?.addEventListener("resize", syncViewport);
    visualViewport?.addEventListener("scroll", syncViewport);
    window.addEventListener("resize", syncViewport);

    return () => {
      visualViewport?.removeEventListener("resize", syncViewport);
      visualViewport?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("resize", syncViewport);
      root.style.removeProperty("--radio-vh");
      root.style.removeProperty("--radio-vtop");
      delete root.dataset.radioKeyboard;
    };
  }, []);

  // Deep link from a notification: /radio?session=cmd-1
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const requestedSessionId = normalizeSessionId(params.get("session"));
    if (requestedSessionId) {
      openInspector(requestedSessionId);
      params.delete("session");
      const nextSearch = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
    }

    if (!("serviceWorker" in navigator)) {
      return;
    }

    function handleServiceWorkerMessage(event: MessageEvent) {
      const data = event.data as { type?: string; sessionId?: string } | null;
      if (data?.type === "open-session" && data.sessionId) {
        setActiveView("sessions");
        openInspector(normalizeSessionId(data.sessionId));
      }
    }

    navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener("message", handleServiceWorkerMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void refreshPushState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceApiBase]);

  useEffect(() => {
    const unreadCount = Object.keys(unreadSessions).length;
    const badgeNavigator = navigator as Navigator & {
      setAppBadge?: (count?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (unreadCount > 0) {
      void badgeNavigator.setAppBadge?.(unreadCount).catch(() => {});
    } else {
      void badgeNavigator.clearAppBadge?.().catch(() => {});
    }
  }, [unreadSessions]);

  useEffect(() => {
    if (!inspectorSessionId || !voiceApiBase) {
      return;
    }

    const sessionId = inspectorSessionId as string;
    let cancelled = false;
    let timeoutId: number | null = null;
    let consecutiveFailures = 0;
    sessionStreamVersionRef.current = null;

    async function refreshSessionStream() {
      if (document.visibilityState !== "visible") {
        return;
      }

      try {
        const knownVersion = sessionStreamVersionRef.current;
        const query = knownVersion === null ? "" : `?v=${knownVersion}`;
        const response = await fetchWithTimeout(
          `${voiceApiBase}/sessions/${encodeURIComponent(sessionId)}/output${query}`,
          6000
        );
        const payload = await parseJsonResponse<SessionStreamResponse>(response);
        if (cancelled || inspectorSessionIdRef.current !== sessionId) {
          return;
        }

        consecutiveFailures = 0;
        applySessionStreamPayload(payload);
      } catch {
        if (cancelled) {
          return;
        }

        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          setSessionStream((currentValue) => ({
            ...(currentValue || {}),
            error: "Connection lost. Retrying…",
            sessionId
          }));
        }
      }
    }

    async function loop() {
      await refreshSessionStream();
      if (cancelled) {
        return;
      }

      timeoutId = window.setTimeout(loop, consecutiveFailures > 0 ? 2000 : SESSION_POLL_INTERVAL_MS);
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
        }
        void loop();
      }
    }

    void loop();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inspectorSessionId, voiceApiBase]);

  // Follow the bottom of the terminal like a real console, unless the user
  // scrolled up to read history.
  useLayoutEffect(() => {
    const panel = outputPanelRef.current;
    if (!panel || !pinnedToBottomRef.current) {
      return;
    }

    panel.scrollTop = panel.scrollHeight;
  }, [sessionStream?.output, inspectorSessionId, terminalFontSize]);

  // Fit the PTY width to the phone so output wraps like a native terminal.
  useEffect(() => {
    if (!inspectorSessionId || !voiceApiBase || !fitTerminalWidth || sessionStream?.outputAvailable !== true) {
      return;
    }

    const sessionId = inspectorSessionId;
    let timeoutId: number | null = null;

    function requestResize() {
      const panel = outputPanelRef.current;
      const measure = charMeasureRef.current;
      if (!panel || !measure) {
        return;
      }

      const charWidth = measure.getBoundingClientRect().width / 20;
      const lineHeight = measure.getBoundingClientRect().height || terminalFontSize * 1.45;
      const panelStyle = window.getComputedStyle(panel);
      const innerWidth = panel.clientWidth - parseFloat(panelStyle.paddingLeft) - parseFloat(panelStyle.paddingRight);
      if (!(charWidth > 0) || innerWidth <= 0) {
        return;
      }

      const cols = Math.max(30, Math.floor(innerWidth / charWidth) - 1);
      const keyboardOpen = document.documentElement.dataset.radioKeyboard === "open";
      const previousRows = Number(lastResizeRef.current.split("x")[1]) || 0;
      // Don't shrink the PTY just because the on-screen keyboard is open.
      const rows = keyboardOpen && previousRows > 0
        ? previousRows
        : Math.max(16, Math.floor(panel.clientHeight / lineHeight));
      const signature = `${sessionId}:${cols}x${rows}`;
      if (lastResizeRef.current === signature) {
        return;
      }

      lastResizeRef.current = signature;
      void fetch(`${voiceApiBase}/sessions/${encodeURIComponent(sessionId)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows })
      }).catch(() => {
        lastResizeRef.current = "";
      });
    }

    function scheduleResize() {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      timeoutId = window.setTimeout(requestResize, 250);
    }

    scheduleResize();
    window.addEventListener("orientationchange", scheduleResize);
    window.addEventListener("resize", scheduleResize);
    return () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
      window.removeEventListener("orientationchange", scheduleResize);
      window.removeEventListener("resize", scheduleResize);
    };
  }, [inspectorSessionId, voiceApiBase, fitTerminalWidth, terminalFontSize, sessionStream?.outputAvailable]);

  useEffect(() => {
    if (!voiceApiBase) {
      return;
    }

    let cancelled = false;

    async function refreshDesktopMetrics() {
      try {
        const response = await fetch(`${voiceApiBase}/desktop/metrics`, {
          cache: "no-store"
        });
        const payload = (await response.json()) as {
          screen?: {
            width?: number;
            height?: number;
          };
        };

        if (cancelled) {
          return;
        }

        setDesktopFrame({
          screenWidth: Number(payload.screen?.width) || 1920,
          screenHeight: Number(payload.screen?.height) || 1080
        });
      } catch {
        if (!cancelled) {
          setDesktopFrame({
            screenWidth: 1920,
            screenHeight: 1080
          });
        }
      }
    }

    void refreshDesktopMetrics();
    const intervalId = window.setInterval(() => {
      void refreshDesktopMetrics();
    }, 10000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [voiceApiBase]);

  useEffect(() => {
    if (activeView !== "viewer" || !voiceApiBase) {
      return;
    }

    if (window.matchMedia("(pointer: coarse)").matches) {
      setViewerStreamStatus("fallback");
      return;
    }

    setViewerStreamStatus("loading");
    const timeoutId = window.setTimeout(() => {
      setViewerStreamStatus((currentStatus) => currentStatus === "streaming" ? currentStatus : "fallback");
    }, 2400);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [activeView, voiceApiBase]);

  useEffect(() => {
    if (activeView !== "viewer" || !voiceApiBase || viewerStreamStatus !== "fallback") {
      return;
    }

    let cancelled = false;

    async function refreshFallbackFrame() {
      try {
        const response = await fetch(`${voiceApiBase}/desktop/screenshot?format=jpg&t=${Date.now()}`, {
          cache: "no-store"
        });
        if (!response.ok) {
          throw new Error(`Desktop fallback frame failed with ${response.status}.`);
        }

        const blob = await response.blob();
        const nextImageUrl = URL.createObjectURL(blob);

        if (cancelled) {
          URL.revokeObjectURL(nextImageUrl);
          return;
        }

        const previousImageUrl = viewerFallbackImageUrlRef.current;
        viewerFallbackImageUrlRef.current = nextImageUrl;
        setViewerFallbackImageUrl(nextImageUrl);

        if (previousImageUrl) {
          URL.revokeObjectURL(previousImageUrl);
        }
      } catch {
        // Keep retrying while the viewer is open.
      }
    }

    void refreshFallbackFrame();
    const intervalId = window.setInterval(() => {
      void refreshFallbackFrame();
    }, 180);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeView, voiceApiBase, viewerStreamStatus]);

  useEffect(() => {
    if (!inspectorSessionId || !voiceApiBase || !sessionStream?.outputAvailable) {
      wasInspectorBusyRef.current = Boolean(sessionStream?.isBusy);
      return;
    }

    const isNowBusy = Boolean(sessionStream.isBusy);
    const wasBusy = wasInspectorBusyRef.current;
    const isPendingSpeech = pendingInspectorSpeechSessionRef.current === inspectorSessionId;
    wasInspectorBusyRef.current = isNowBusy;

    if (isNowBusy || (!wasBusy && !isPendingSpeech) || !speakResultsRef.current) {
      return;
    }

    const speechText = buildTerminalSpeechText(sessionStream.output || "");
    const speechSignature = `${inspectorSessionId}:${speechText}`;
    if (!speechText || spokenOutputSignatureRef.current === speechSignature) {
      return;
    }

    spokenOutputSignatureRef.current = speechSignature;
    pendingInspectorSpeechSessionRef.current = null;
    const speechRequestId = ++speechRequestSeqRef.current;
    void speakTerminalOutput(
      voiceApiBase,
      speechText,
      speechAudioRef,
      speechVolumeRef,
      speechAudioContextRef,
      speechGainNodeRef,
      setIsSpeakingOutput,
      speechRequestSeqRef,
      speechRequestId
    );
  }, [inspectorSessionId, sessionStream, voiceApiBase]);

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
    function switchToNextSession() {
      if (
        recorderRef.current?.state === "recording" ||
        holdStartedRef.current ||
        nativeHoldRequestedRef.current
      ) {
        return;
      }

      const availableSessionIds = sortSessionIds(mergeSessionIds(sessionIdsRef.current));
      if (availableSessionIds.length <= 1) {
        return;
      }

      const currentInspectorSessionId = inspectorSessionIdRef.current;
      const activeSessionId = currentInspectorSessionId || activeSessionIdRef.current;
      const activeIndex = Math.max(availableSessionIds.indexOf(activeSessionId), 0);
      const nextSessionId = availableSessionIds[(activeIndex + 1) % availableSessionIds.length] || availableSessionIds[0];

      if (!nextSessionId) {
        return;
      }

      setCurrentSessionId(nextSessionId);
      activeSessionIdRef.current = nextSessionId;

      if (currentInspectorSessionId) {
        openInspector(nextSessionId);
      }
    }

    function stopNativeHold() {
      nativeHoldRequestedRef.current = false;

      if (recorderRef.current?.state === "recording") {
        activePointerIdRef.current = null;
        pressTargetRef.current = null;
        lastSessionTapRef.current = null;
        setIsPressingToRecord(false);
        recorderRef.current.stop();
        setStatus("processing");
        return;
      }

      if (activePointerIdRef.current === NATIVE_VOLUME_POINTER_ID || holdStartedRef.current) {
        handleHoldEnd(NATIVE_VOLUME_POINTER_ID);
      }
    }

    function startNativeHold() {
      if (
        statusRef.current === "processing" ||
        statusRef.current === "listening" ||
        recorderRef.current?.state === "recording" ||
        holdStartedRef.current ||
        nativeHoldRequestedRef.current
      ) {
        return;
      }

      nativeHoldRequestedRef.current = true;
      clearHoldTimer(holdTimerRef);
      activePointerIdRef.current = null;
      lastSessionTapRef.current = null;
      setIsPressingToRecord(true);
      const currentInspectorSessionId = inspectorSessionIdRef.current;
      pressTargetRef.current = currentInspectorSessionId || activeSessionIdRef.current;
      void handleHoldStart(NATIVE_VOLUME_POINTER_ID, { allowInspector: Boolean(currentInspectorSessionId) });
    }

    function handleNativeVolumeAction(action: "volume-up" | "volume-up-start" | "volume-up-stop" | "volume-down") {
      if (action === "volume-up-start") {
        startNativeHold();
        return;
      }

      if (action === "volume-up-stop") {
        stopNativeHold();
        return;
      }

      if (action === "volume-up") {
        if (nativeHoldRequestedRef.current || holdStartedRef.current || recorderRef.current?.state === "recording") {
          stopNativeHold();
        } else {
          startNativeHold();
        }
        return;
      }

      if (action === "volume-down") {
        switchToNextSession();
      }
    }

    function handleNativeVolumeEvent(event: Event) {
      const action = (event as CustomEvent<{ action?: string }>).detail?.action;
      if (
        action !== "volume-up" &&
        action !== "volume-up-start" &&
        action !== "volume-up-stop" &&
        action !== "volume-down"
      ) {
        return;
      }

      event.preventDefault();
      handleNativeVolumeAction(action);
    }

    window.__siyloNativeVolumeAction = handleNativeVolumeAction;
    window.addEventListener("siylo-native-volume-action", handleNativeVolumeEvent);

    return () => {
      window.removeEventListener("siylo-native-volume-action", handleNativeVolumeEvent);
      if (window.__siyloNativeVolumeAction) {
        delete window.__siyloNativeVolumeAction;
      }
    };
  }, []);

  useEffect(() => {
    const viewerWindow = viewerWindowRef.current;
    if (!viewerWindow || !("ResizeObserver" in window)) {
      return;
    }

    const updateViewerSize = () => {
      const bounds = viewerWindow.getBoundingClientRect();
      setViewerSize({
        width: Math.max(bounds.width, 1),
        height: Math.max(bounds.height, 1)
      });
    };
    const resizeObserver = new ResizeObserver(updateViewerSize);

    updateViewerSize();
    resizeObserver.observe(viewerWindow);

    return () => {
      resizeObserver.disconnect();
    };
  }, [activeView]);

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

      if (viewerFallbackImageUrlRef.current) {
        URL.revokeObjectURL(viewerFallbackImageUrlRef.current);
        viewerFallbackImageUrlRef.current = "";
      }
    };
  }, []);

  // iOS Safari only shows the mic permission dialog when getUserMedia is called
  // directly from a native touchstart handler. React synthetic events are attached
  // at the document root and don't satisfy iOS's user-gesture requirement.
  useEffect(() => {
    const button = inspectorTalkButtonRef.current;
    if (!button) return;

    function onTouchStart(event: TouchEvent) {
      event.preventDefault();
      if (!micEnabledRef.current) return;
      if (streamRef.current?.active || streamRequestRef.current) return;
      if (!navigator.mediaDevices?.getUserMedia) return;
      streamRequestRef.current = navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
        .then((stream) => {
          streamRef.current = stream;
          return stream;
        })
        .finally(() => {
          streamRequestRef.current = null;
        });
      // Permission errors surface through the hold-to-talk path; avoid an unhandled rejection here.
      streamRequestRef.current.catch(() => undefined);
    }

    button.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => button.removeEventListener("touchstart", onTouchStart);
  }, [inspectorSessionId]);

  // The main area no longer pre-opens the mic on every touch: doing so grabbed
  // the iOS audio session (pausing Spotify etc.) even for plain taps. The mic is
  // opened only once a hold actually turns into a recording, and released after.

  async function enableMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicMessage("This browser doesn't support microphone input.");
      return false;
    }
    setMicMessage("");
    try {
      // Called straight from a tap so iOS shows the permission prompt; the
      // stream is released right away so other audio can keep playing.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) {
        track.stop();
      }
      micEnabledRef.current = true;
      setMicEnabled(true);
      return true;
    } catch {
      setMicMessage(
        "Microphone access was blocked. On iPhone/iPad: Settings → Safari → Microphone → Allow, then try again."
      );
      micEnabledRef.current = false;
      setMicEnabled(false);
      return false;
    }
  }

  function startLiveTranscription() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SpeechRecognitionAPI = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) return;

    const recognition = new SpeechRecognitionAPI();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognition.onresult = (event: any) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        interim += event.results[i][0].transcript;
      }
      const trimmed = interim.trim();
      liveTranscriptRef.current = trimmed;
      setLiveTranscript(trimmed);
    };

    recognition.onerror = () => {
      // Silently ignore — MediaRecorder is the authoritative capture path
    };

    try {
      recognition.start();
      recognitionRef.current = recognition;
    } catch {
      // SpeechRecognition may be unavailable or already active
    }
  }

  function stopLiveTranscription(): string {
    const captured = liveTranscriptRef.current;
    liveTranscriptRef.current = "";
    if (recognitionRef.current) {
      try { recognitionRef.current.stop(); } catch { /* ignore */ }
      recognitionRef.current = null;
    }
    setLiveTranscript("");
    return captured;
  }

  async function handleHoldStart(pointerId: number, options: { allowInspector?: boolean } = {}) {
    const currentInspectorSessionId = inspectorSessionIdRef.current;
    if (
      statusRef.current === "processing" ||
      statusRef.current === "listening" ||
      (currentInspectorSessionId && !options.allowInspector)
    ) {
      return;
    }

    if (!micEnabledRef.current) {
      if (pointerId === NATIVE_VOLUME_POINTER_ID) {
        nativeHoldRequestedRef.current = false;
      }
      holdStartedRef.current = false;
      activePointerIdRef.current = null;
      setIsPressingToRecord(false);
      setStatus("idle");
      setMicMessage("Voice input is off. Turn on the microphone here to hold-to-talk.");
      setIsSettingsOpen(true);
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
        releaseMicStream(streamRef, streamRequestRef);
        return;
      }

      if (pointerId === NATIVE_VOLUME_POINTER_ID && !nativeHoldRequestedRef.current) {
        activePointerIdRef.current = null;
        setIsPressingToRecord(false);
        releaseMicStream(streamRef, streamRequestRef);
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
        if (pointerId === NATIVE_VOLUME_POINTER_ID) {
          nativeHoldRequestedRef.current = false;
        }
        releaseMicStream(streamRef, streamRequestRef);
        setStatus("error");
      };
      recorder.onstop = async () => {
        recorderRef.current = null;
        holdStartedRef.current = false;
        // Hand the iOS audio session back so other apps' audio can resume.
        releaseMicStream(streamRef, streamRequestRef);
        if (pointerId === NATIVE_VOLUME_POINTER_ID) {
          nativeHoldRequestedRef.current = false;
        }
        const capturedTranscript = stopLiveTranscription();
        const blobType = recorder.mimeType || mimeType || "audio/webm";
        const audioBlob = new Blob(chunksRef.current, { type: blobType });
        chunksRef.current = [];

        if (capturedTranscript) {
          await uploadRecording(audioBlob, activeSessionIdRef.current, capturedTranscript);
          return;
        }

        if (audioBlob.size === 0) {
          setStatus("idle");
          return;
        }

        const hasSignal = await hasAudibleSignal(audioBlob);
        if (!hasSignal) {
          setStatus("error");
          return;
        }

        await uploadRecording(audioBlob, activeSessionIdRef.current);
      };

      recorder.start();
      holdStartedRef.current = true;
      setStatus("listening");
      startLiveTranscription();
    } catch {
      holdStartedRef.current = false;
      releaseMicStream(streamRef, streamRequestRef);
      if (pointerId === NATIVE_VOLUME_POINTER_ID) {
        nativeHoldRequestedRef.current = false;
      }
      setIsPressingToRecord(false);
      setStatus("error");
      activePointerIdRef.current = null;
      const fallbackInspectorSessionId = inspectorSessionIdRef.current;
      if (options.allowInspector && fallbackInspectorSessionId) {
        setSessionStream((currentValue) => ({
          ...(currentValue || {}),
          error: "Microphone access failed. On iPhone/iPad: Settings → Safari → Microphone → Allow. On Android: tap the lock icon in your browser address bar and allow microphone.",
          sessionId: fallbackInspectorSessionId,
          status: "error"
        }));
      }
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

      if (pointerId === NATIVE_VOLUME_POINTER_ID) {
        nativeHoldRequestedRef.current = false;
        setStatus("idle");
        return;
      }

      if (pressedTarget === "__launcher__") {
        lastSessionTapRef.current = null;
        suppressGhostClickUntilRef.current = Date.now() + 450;
        setIsLauncherOpen(true);
        setStatus("idle");
        return;
      }

      if (pressedTarget && sessionIdsRef.current.includes(pressedTarget)) {
        setCurrentSessionId(pressedTarget);
        setStatus("idle");
        lastSessionTapRef.current = null;
        suppressGhostClickUntilRef.current = Date.now() + 450;
        openInspector(pressedTarget, true);
      }

      return;
    }

    pressTargetRef.current = null;
    lastSessionTapRef.current = null;
    if (pointerId === NATIVE_VOLUME_POINTER_ID) {
      nativeHoldRequestedRef.current = false;
    }

    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      setStatus("processing");
      return;
    }

    if (statusRef.current === "listening") {
      holdStartedRef.current = false;
      setStatus("idle");
    }
  }

  function openInspector(sessionId: string, announceLabel = false) {
    if (!sessionId) {
      return;
    }

    const isSameSession = inspectorSessionIdRef.current === sessionId;
    activeSessionIdRef.current = sessionId;
    inspectorSessionIdRef.current = sessionId;
    setCurrentSessionId(sessionId);
    setInspectorSessionId(sessionId);
    if (!isSameSession) {
      setSessionStream(null);
      sessionStreamVersionRef.current = null;
      setTerminalInput("");
    }
    setIsLauncherOpen(false);
    setIsInspectorMenuOpen(false);
    setIsConfirmingKill(false);
    pinnedToBottomRef.current = true;
    setIsOutputPinnedToBottom(true);
    wasInspectorBusyRef.current = false;
    spokenOutputSignatureRef.current = "";
    pendingInspectorSpeechSessionRef.current = null;
    lastResizeRef.current = "";
    setUnreadSessions((current) => {
      if (!current[sessionId]) {
        return current;
      }
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    setToasts((current) => current.filter((toast) => toast.sessionId !== sessionId));

    const apiBase = voiceApiBaseRef.current;
    if (announceLabel && apiBase && speakResultsRef.current) {
      stopTerminalSpeechPlayback(speechAudioRef, speechGainNodeRef, setIsSpeakingOutput);
      const labelText = formatSessionLabelForSpeech(sessionId);
      const speechRequestId = ++speechRequestSeqRef.current;
      void speakTerminalOutput(
        apiBase,
        labelText,
        speechAudioRef,
        speechVolumeRef,
        speechAudioContextRef,
        speechGainNodeRef,
        setIsSpeakingOutput,
        speechRequestSeqRef,
        speechRequestId
      ).catch(() => {});
    }
  }

  function closeInspector() {
    inspectorSessionIdRef.current = null;
    setInspectorSessionId(null);
    setSessionStream(null);
    sessionStreamVersionRef.current = null;
    setTerminalInput("");
    setIsSendingTerminalInput(false);
    setIsInspectorMenuOpen(false);
    setIsGitPanelOpen(false);
    setIsConfirmingKill(false);
    pendingInspectorSpeechSessionRef.current = null;
    speechRequestSeqRef.current += 1;
    stopTerminalSpeechPlayback(speechAudioRef, speechGainNodeRef, setIsSpeakingOutput);
    terminalInputRef.current?.blur();
  }

  function applySessionStreamPayload(payload: SessionStreamResponse | null) {
    if (!payload) {
      return;
    }

    if (typeof payload.version === "number") {
      sessionStreamVersionRef.current = payload.version;
    }

    if (payload.unchanged) {
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        ...payload,
        error: undefined,
        output: currentValue?.output ?? ""
      }));
      return;
    }

    setSessionStream(payload);
  }

  function handleSessionEvent(event: SessionEvent) {
    const sessionId = normalizeSessionId(event.sessionId);
    if (!sessionId || event.kind === "stopped") {
      return;
    }

    const isViewing =
      document.visibilityState === "visible" && inspectorSessionIdRef.current === sessionId;
    if (isViewing) {
      return;
    }

    if (event.kind === "finished" && Number(event.durationMs || 0) < 1500) {
      return;
    }

    setUnreadSessions((current) => ({ ...current, [sessionId]: event.kind }));
    const label = formatSessionLabel(sessionId);
    const duration = formatDuration(event.durationMs || 0);
    const title =
      event.kind === "input"
        ? `${label} needs input`
        : event.kind === "exited"
          ? `${label} closed`
          : `${label} finished${duration ? ` · ${duration}` : ""}`;
    const body = String(event.summary || event.command || "").trim();
    pushToast({ sessionId, kind: event.kind, title, body });
  }

  function pushToast(entry: Omit<ToastEntry, "id">) {
    const id = ++toastIdRef.current;
    setToasts((current) =>
      [...current.filter((toast) => toast.sessionId !== entry.sessionId), { ...entry, id }].slice(-3)
    );
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, TOAST_DURATION_MS);

    try {
      navigator.vibrate?.(entry.kind === "input" ? [60, 60, 60, 60, 60] : [90, 50, 90]);
    } catch {
      // Vibration is optional.
    }
    playChime(speechAudioContextRef, entry.kind === "input");
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function handleOutputScroll() {
    const panel = outputPanelRef.current;
    if (!panel) {
      return;
    }

    const distanceFromBottom = panel.scrollHeight - panel.scrollTop - panel.clientHeight;
    const pinned = distanceFromBottom < 48;
    if (pinned !== pinnedToBottomRef.current) {
      pinnedToBottomRef.current = pinned;
      setIsOutputPinnedToBottom(pinned);
    }
  }

  function jumpToLatestOutput() {
    const panel = outputPanelRef.current;
    pinnedToBottomRef.current = true;
    setIsOutputPinnedToBottom(true);
    if (panel) {
      panel.scrollTo({ top: panel.scrollHeight, behavior: "smooth" });
    }
  }

  async function killInspectorSession() {
    const sessionId = inspectorSessionIdRef.current;
    const apiBase = voiceApiBaseRef.current;
    if (!sessionId || !apiBase) {
      return;
    }

    if (!isConfirmingKill) {
      setIsConfirmingKill(true);
      return;
    }

    setIsConfirmingKill(false);
    setIsInspectorMenuOpen(false);
    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/kill`, { method: "POST" });
      const payload = await parseJsonResponse<{ error?: string }>(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Close failed with ${response.status}.`);
      }

      confirmedSessionIdsRef.current = confirmedSessionIdsRef.current.filter((id) => id !== sessionId);
      setSessionIds((current) => current.filter((id) => id !== sessionId));
      closeInspector();
    } catch (error) {
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        error: error instanceof Error ? error.message : "Unable to close the session."
      }));
    }
  }

  async function getPushRegistration() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return null;
    }

    try {
      return await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
  }

  async function refreshPushState() {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) {
      setPushState("unsupported");
      return;
    }

    if (!("PushManager" in window) || !("Notification" in window)) {
      setPushState(isIosDevice() && !isStandaloneDisplay() ? "needs-install" : "unsupported");
      return;
    }

    if (Notification.permission === "denied") {
      setPushState("denied");
      return;
    }

    const registration = await getPushRegistration();
    const subscription = registration ? await registration.pushManager.getSubscription().catch(() => null) : null;
    if (!subscription) {
      setPushState("off");
      return;
    }

    const apiBase = voiceApiBaseRef.current;
    if (apiBase) {
      try {
        const response = await fetch(`${apiBase}/push/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        const payload = await parseJsonResponse<{ subscribed?: boolean }>(response);
        if (payload && payload.subscribed === false) {
          // The PC forgot this phone (e.g. reinstall) - re-register quietly.
          await registerPushSubscription(subscription, apiBase);
        }
      } catch {
        // Keep the local state; the PC may be briefly unreachable.
      }
    }

    setPushState("on");
  }

  async function registerPushSubscription(subscription: PushSubscription, apiBase: string) {
    const response = await fetch(`${apiBase}/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON() })
    });
    if (!response.ok) {
      const payload = await parseJsonResponse<{ error?: string }>(response);
      throw new Error(payload?.error || `Subscribe failed with ${response.status}.`);
    }
  }

  async function enablePushNotifications() {
    const apiBase = voiceApiBaseRef.current;
    setPushMessage("");
    if (!apiBase) {
      setPushMessage("Not connected to your PC yet.");
      return;
    }

    setPushState("working");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushState(permission === "denied" ? "denied" : "off");
        return;
      }

      const registration = await getPushRegistration();
      if (!registration) {
        throw new Error("Service worker is not ready. Reload the app and try again.");
      }

      const keyResponse = await fetch(`${apiBase}/push/key`, { cache: "no-store" });
      const keyPayload = await parseJsonResponse<{ publicKey?: string }>(keyResponse);
      if (!keyPayload?.publicKey) {
        throw new Error("The PC did not return a push key. Update Siylo on the PC.");
      }

      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await existing.unsubscribe().catch(() => false);
      }
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyPayload.publicKey)
      });
      await registerPushSubscription(subscription, apiBase);
      setPushState("on");
      setPushMessage("Notifications are on.");
    } catch (error) {
      setPushState("off");
      setPushMessage(error instanceof Error ? error.message : "Could not enable notifications.");
    }
  }

  async function disablePushNotifications() {
    const apiBase = voiceApiBaseRef.current;
    setPushState("working");
    try {
      const registration = await getPushRegistration();
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (subscription) {
        if (apiBase) {
          await fetch(`${apiBase}/push/unsubscribe`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: subscription.endpoint })
          }).catch(() => {});
        }
        await subscription.unsubscribe().catch(() => false);
      }
      setPushMessage("Notifications are off.");
    } finally {
      setPushState("off");
    }
  }

  async function sendTestNotification() {
    const apiBase = voiceApiBaseRef.current;
    if (!apiBase) {
      return;
    }

    setPushMessage("Sending…");
    try {
      const response = await fetch(`${apiBase}/push/test`, { method: "POST" });
      const payload = await parseJsonResponse<{ sent?: number; failed?: number }>(response);
      setPushMessage(
        payload?.sent
          ? "Test sent. Lock your phone or switch apps to see it."
          : "No device received it. Try turning notifications off and on."
      );
    } catch {
      setPushMessage("Could not reach the PC.");
    }
  }

  async function uploadRecording(audioBlob: Blob, sessionId: string, transcript?: string) {
    setStatus("processing");
    const currentInspectorSessionId = inspectorSessionIdRef.current;
    if (currentInspectorSessionId === sessionId) {
      pendingInspectorSpeechSessionRef.current = sessionId;
    }

    try {
      let resolvedVoiceApiBase = voiceApiBaseRef.current;
      if (!resolvedVoiceApiBase) {
        const health = await probeVoiceBackend();
        resolvedVoiceApiBase = health?.baseUrl || "";

        if (resolvedVoiceApiBase) {
          voiceApiBaseRef.current = resolvedVoiceApiBase;
          setVoiceApiBase(resolvedVoiceApiBase);
        }
      }

      if (!resolvedVoiceApiBase) {
        throw new Error("Voice backend unavailable.");
      }

      let response: Response;
      if (transcript) {
        response = await fetch(`${resolvedVoiceApiBase}/voice`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId, transcript })
        });
      } else {
        const formData = new FormData();
        formData.append("audio", audioBlob, `radio-input.${getFileExtension(audioBlob.type)}`);
        formData.append("sessionId", sessionId);
        response = await fetch(`${resolvedVoiceApiBase}/voice`, {
          method: "POST",
          body: formData
        });
      }

      const payload = await parseVoiceResponse(response);

      if (!response.ok) {
        throw new Error(payload?.error || `Voice request failed with ${response.status}.`);
      }

      applyVoicePayload(payload);
      if (inspectorSessionIdRef.current === sessionId) {
        await refreshInspectorSessionOutput(resolvedVoiceApiBase, sessionId);
      }
      setStatus("executed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice request failed.";
      if (inspectorSessionIdRef.current === sessionId) {
        setSessionStream((currentValue) => ({
          ...(currentValue || {}),
          error: message,
          sessionId,
          status: "error"
        }));
      }
      setStatus("error");
    }
  }

  async function refreshInspectorSessionOutput(apiBase: string, sessionId: string) {
    try {
      const response = await fetch(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/output`, {
        cache: "no-store"
      });
      const payload = await parseJsonResponse<SessionStreamResponse>(response);

      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal refresh failed with ${response.status}.`);
      }

      setSessionStream(payload || null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to refresh terminal output.";
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        error: message,
        sessionId,
        status: "error"
      }));
    }
  }

  async function handleLauncherOpen(target: (typeof LAUNCHER_TARGETS)[number]) {
    setIsLauncherOpen(false);
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

      const response = await fetch(`${resolvedVoiceApiBase}/voice`, {
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

      console.info(`[radio] open ${target} ->`, payload);
      applyVoicePayload(payload);
      setStatus("executed");
      const openedSessionId = normalizeSessionId(payload?.sessionId);
      if (openedSessionId && TERMINAL_LAUNCHER_TARGETS.has(target)) {
        openInspector(openedSessionId);
      }
    } catch (error) {
      console.error(`[radio] open ${target} failed:`, error);
      setStatus("error");
      pushToast({
        sessionId: `launcher-${target}`,
        kind: "error",
        title: `Couldn't open ${formatSessionLabel(target)}`,
        body: error instanceof Error ? error.message : "The PC did not respond."
      });
    }
  }

  // One entry point for everything typed into a terminal:
  //  - text + Send  -> types the text and presses Enter
  //  - empty + Send -> presses Enter on its own (confirm prompts, continue TUIs)
  //  - key strip    -> sends a single special key
  async function sendTerminalInput(input: { text?: string; key?: string }) {
    const sessionId = inspectorSessionIdRef.current;
    const apiBase = voiceApiBaseRef.current;
    if (!sessionId || !apiBase || isSendingTerminalInput) {
      return;
    }

    const typedText = input.text ?? "";
    setIsSendingTerminalInput(true);
    pendingInspectorSpeechSessionRef.current = sessionId;
    pinnedToBottomRef.current = true;
    setIsOutputPinnedToBottom(true);

    if (input.text !== undefined) {
      setTerminalInput("");
    }

    try {
      const response = await fetchWithTimeout(`${apiBase}/sessions/${encodeURIComponent(sessionId)}/input`, 10000, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(input.key ? { key: input.key } : { text: typedText, enter: true })
      });
      const payload = await parseJsonResponse<SessionStreamResponse>(response);

      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal input failed with ${response.status}.`);
      }

      if (inspectorSessionIdRef.current === sessionId) {
        applySessionStreamPayload(payload);
      }
    } catch (error) {
      if (input.text !== undefined && typedText) {
        // Give the text back so nothing typed on a phone keyboard is lost.
        setTerminalInput((current) => current || typedText);
      }
      setSessionStream((currentValue) => ({
        ...(currentValue || {}),
        error: error instanceof Error && error.message ? error.message : "Unable to send to the terminal."
      }));
    } finally {
      setIsSendingTerminalInput(false);
    }
  }

  function handleInspectorVoiceButtonStart(pointerId: number) {
    if (!inspectorSessionId || isBusy || isListening) {
      return;
    }

    if (!micEnabledRef.current) {
      // The mic button doubles as the permission request; recording starts on the next press.
      void enableMic();
      return;
    }

    activePointerIdRef.current = pointerId;
    setCurrentSessionId(inspectorSessionId);
    activeSessionIdRef.current = inspectorSessionId;
    setIsPressingToRecord(true);
    pressTargetRef.current = inspectorSessionId;
    holdStartedRef.current = false;
    clearHoldTimer(holdTimerRef);
    void getOrCreateStream(streamRef, streamRequestRef).catch(() => {});
    void handleHoldStart(pointerId, { allowInspector: true });
  }

  function handleInspectorVoiceButtonEnd(target: HTMLElement, pointerId: number) {
    tryReleasePointerCapture(target, pointerId);
    handleHoldEnd(pointerId);
  }

  async function handleViewerPointer(event: PointerEvent<HTMLDivElement>, click = false) {
    if (!voiceApiBase || !desktopFrame || !isViewerControlEnabled) {
      return;
    }

    const coordinate = resolveViewerCoordinate(event, viewerLayout);
    if (!coordinate) {
      return;
    }

    const ratioX = coordinate.ratioX;
    const ratioY = coordinate.ratioY;
    await sendViewerPointer(ratioX, ratioY, click);
  }

  async function sendViewerPointer(ratioX: number, ratioY: number, click = false) {
    if (!voiceApiBase || !desktopFrame || !isViewerControlEnabled) {
      return;
    }

    const nextCursor = { x: ratioX, y: ratioY };
    viewerCursorRef.current = nextCursor;
    setViewerCursor(nextCursor);
    const now = Date.now();
    if (!click && now - desktopPointerSendRef.current < 120) {
      return;
    }

    desktopPointerSendRef.current = now;
    const screenWidth = desktopFrame.screenWidth || 1920;
    const screenHeight = desktopFrame.screenHeight || 1080;

    try {
      await fetch(`${voiceApiBase}/desktop/input`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          x: Math.round(ratioX * screenWidth),
          y: Math.round(ratioY * screenHeight),
          click
        })
      });
    } catch {
      // Keep the viewer usable even if one pointer packet fails.
    }
  }

  function handleViewerPointerDown(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    viewerPointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY
    });
    trySetPointerCapture(event.currentTarget, event.pointerId);

    if (event.pointerType === "touch" && viewerPointersRef.current.size === 1) {
      viewerTouchDragRef.current = {
        lastX: event.clientX,
        lastY: event.clientY,
        moved: false,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY
      };
    }

    if (viewerPointersRef.current.size === 2) {
      const distance = getPointerDistance(viewerPointersRef.current);
      viewerPinchRef.current = {
        distance,
        zoom: viewerZoom
      };
    }
  }

  function handleViewerPointerMove(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (viewerPointersRef.current.has(event.pointerId)) {
      viewerPointersRef.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY
      });
    }

    if (viewerPointersRef.current.size >= 2 && viewerPinchRef.current) {
      const nextDistance = getPointerDistance(viewerPointersRef.current);
      if (nextDistance > 0 && viewerPinchRef.current.distance > 0) {
        const nextZoom = viewerPinchRef.current.zoom * (nextDistance / viewerPinchRef.current.distance);
        setViewerZoom(clampZoom(nextZoom));
      }
      return;
    }

    if (event.pointerType === "touch" && viewerTouchDragRef.current?.pointerId === event.pointerId) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const drag = viewerTouchDragRef.current;
      const totalDeltaX = event.clientX - drag.startX;
      const totalDeltaY = event.clientY - drag.startY;
      const movedDistance = Math.hypot(totalDeltaX, totalDeltaY);

      if (movedDistance <= TRACKPAD_TOUCH_DEADZONE_PX) {
        return;
      }

      const deltaX = event.clientX - drag.lastX;
      const deltaY = event.clientY - drag.lastY;
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;

      if (movedDistance > TRACKPAD_TOUCH_DEADZONE_PX) {
        drag.moved = true;
      }

      const zoomPrecision = 1 / Math.sqrt(Math.max(viewerZoom, 1));
      const currentCursor = viewerCursorRef.current;
      const nextCursor = {
        x: clampRatio(currentCursor.x + (deltaX / Math.max(bounds.width, 1)) * TRACKPAD_TOUCH_SENSITIVITY * zoomPrecision),
        y: clampRatio(currentCursor.y + (deltaY / Math.max(bounds.height, 1)) * TRACKPAD_TOUCH_SENSITIVITY * zoomPrecision)
      };
      void sendViewerPointer(nextCursor.x, nextCursor.y, false);
      return;
    }

    void handleViewerPointer(event);
  }

  function handleViewerPointerUp(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const wasPinching = viewerPointersRef.current.size >= 2;
    const touchDrag = viewerTouchDragRef.current?.pointerId === event.pointerId
      ? viewerTouchDragRef.current
      : null;
    viewerPointersRef.current.delete(event.pointerId);
    if (viewerPointersRef.current.size < 2) {
      viewerPinchRef.current = null;
    }
    if (touchDrag) {
      viewerTouchDragRef.current = null;
    }
    tryReleasePointerCapture(event.currentTarget, event.pointerId);

    if (touchDrag) {
      if (!touchDrag.moved && !wasPinching) {
        void sendViewerPointer(viewerCursor.x, viewerCursor.y, true);
      }
      return;
    }

    if (!wasPinching) {
      void handleViewerPointer(event, true);
    }
  }

  function handleViewerPointerCancel(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    viewerPointersRef.current.delete(event.pointerId);
    if (viewerPointersRef.current.size < 2) {
      viewerPinchRef.current = null;
    }
    if (viewerTouchDragRef.current?.pointerId === event.pointerId) {
      viewerTouchDragRef.current = null;
    }
    tryReleasePointerCapture(event.currentTarget, event.pointerId);
  }

  function handleViewerWheel(event: WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const zoomDelta = event.deltaY < 0 ? 0.12 : -0.12;
    setViewerZoom((currentZoom) => clampZoom(currentZoom + zoomDelta));
  }

  function handleViewerZoomButton(delta: number) {
    setViewerZoom((currentZoom) => clampZoom(currentZoom + delta));
  }

  function handleViewerImageLoad(event: React.SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;

    if (naturalWidth > 0 && naturalHeight > 0) {
      setDesktopFrame((currentFrame) => {
        if (
          currentFrame?.screenWidth === naturalWidth &&
          currentFrame.screenHeight === naturalHeight
        ) {
          return currentFrame;
        }

        return {
          screenWidth: naturalWidth,
          screenHeight: naturalHeight
        };
      });
    }

    setViewerStreamStatus((currentStatus) => currentStatus === "fallback" ? currentStatus : "streaming");
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
      ref={mainHoldAreaRef}
      className={`${styles.page} ${isListening ? styles.listening : ""}`}
      onPointerDown={(event) => {
        if (activeView !== "sessions") {
          return;
        }

        if (event.button !== 0 && event.pointerType === "mouse") {
          return;
        }

        if (
          (event.target as HTMLElement).closest("[data-no-hold='true']") ||
          (event.target as HTMLElement).closest(`.${styles.viewerDock}`)
        ) {
          return;
        }

        event.preventDefault();
        trySetPointerCapture(event.currentTarget, event.pointerId);
        handlePressStart(event.pointerId, event.target as HTMLElement);
      }}
      onPointerUp={(event) => {
        if (activeView !== "sessions") {
          return;
        }

        event.preventDefault();
        tryReleasePointerCapture(event.currentTarget, event.pointerId);

        handleHoldEnd(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (activeView !== "sessions") {
          return;
        }

        tryReleasePointerCapture(event.currentTarget, event.pointerId);

        handleHoldEnd(event.pointerId);
      }}
      onClickCapture={(event) => {
        // A tap opens overlays on pointerup; the browser's follow-up click
        // would otherwise land on whatever just appeared under the finger.
        if (Date.now() < suppressGhostClickUntilRef.current) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <button
        type="button"
        data-no-hold="true"
        className={styles.settingsButton}
        aria-label="Open settings"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setIsSettingsOpen(true);
          void refreshPushState();
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.04a2.05 2.05 0 0 1-2.9 2.9l-.04-.04a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.02 1.56V21a2.05 2.05 0 0 1-4.1 0v-.06A1.7 1.7 0 0 0 8.92 19.4a1.7 1.7 0 0 0-1.88.34l-.04.04a2.05 2.05 0 0 1-2.9-2.9l.04-.04A1.7 1.7 0 0 0 4.48 15a1.7 1.7 0 0 0-1.56-1.02H2.86a2.05 2.05 0 0 1 0-4.1h.06a1.7 1.7 0 0 0 1.56-1.02 1.7 1.7 0 0 0-.34-1.88l-.04-.04a2.05 2.05 0 0 1 2.9-2.9l.04.04a1.7 1.7 0 0 0 1.88.34h.01A1.7 1.7 0 0 0 9.94 2.9V2.84a2.05 2.05 0 0 1 4.1 0v.06a1.7 1.7 0 0 0 1.02 1.56 1.7 1.7 0 0 0 1.88-.34l.04-.04a2.05 2.05 0 0 1 2.9 2.9l-.04.04a1.7 1.7 0 0 0-.34 1.88v.01a1.7 1.7 0 0 0 1.56 1.02h.06a2.05 2.05 0 0 1 0 4.1h-.06A1.7 1.7 0 0 0 19.4 15Z" />
        </svg>
        {pushState === "off" || pushState === "needs-install" ? <span className={styles.settingsDot} aria-hidden="true" /> : null}
      </button>

      {connectionState !== "online" ? (
        <div
          data-no-hold="true"
          className={`${styles.connectionBanner} ${connectionState === "offline" ? styles.connectionBannerOffline : ""}`}
          role="status"
        >
          <span className={styles.connectionSpinner} aria-hidden="true" />
          {connectionState === "offline" ? "Lost connection to your PC. Reconnecting…" : "Connecting to your PC…"}
        </div>
      ) : null}

      {activeView === "sessions" ? (
        <div className={`${styles.sessionContainer} ${sessionSlots.length > 4 ? styles.sessionContainerDense : ""}`}>
          {sessionSlots.map((slot) => {
            if (slot.kind !== "session") {
              return (
                <div
                  key={slot.id}
                  data-launcher-trigger="true"
                  className={`${styles.sessionButton} ${styles.placeholder}`}
                  aria-label="Open a new session"
                >
                  <span className={styles.plus}>+</span>
                  <span className={styles.placeholderLabel}>{sessionSlots.length === 1 ? "Open a terminal" : "New"}</span>
                </div>
              );
            }

            const tileStatus = sessionStatuses[slot.id];
            const tileState = getTileState(tileStatus, unreadSessions[slot.id]);
            const elapsed =
              tileStatus?.activity === "running" && tileStatus.runStartedAt
                ? formatElapsed(clockNow + serverClockOffset - tileStatus.runStartedAt)
                : "";

            return (
              <div
                key={slot.id}
                data-session-id={slot.id}
                className={`${styles.sessionButton} ${currentSessionId === slot.id ? styles.active : ""} ${styles[`tile_${tileState.tone}`] || ""}`}
              >
                <div className={styles.tileTop}>
                  <span className={styles.sessionLabel}>{formatSessionLabel(slot.id)}</span>
                  {unreadSessions[slot.id] ? <span className={styles.tileBadge} aria-label="New activity" /> : null}
                </div>
                <span className={styles.tileStatus}>
                  <span className={`${styles.statusDot} ${styles[`statusDot_${tileState.tone}`] || ""}`} aria-hidden="true" />
                  {tileState.label}
                  {elapsed ? <span className={styles.tileElapsed}>{elapsed}</span> : null}
                </span>
                {tileStatus?.lastLine && tileStatus.activity !== "app" ? (
                  <span className={styles.tilePreview}>{tileStatus.lastLine}</span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {activeView === "sessions" && !inspectorSessionId ? (
        <p className={styles.homeHint} aria-hidden="true">
          {isListening ? "Listening… release to send" : "Tap a terminal to open it · hold anywhere to talk"}
        </p>
      ) : null}

      {activeView === "viewer" ? (
        <section
          className={`${styles.viewerDock} ${styles.viewerPage}`}
          aria-label="Remote desktop viewer"
        >
          <div
            ref={viewerWindowRef}
            className={styles.viewerWindow}
            onPointerDown={handleViewerPointerDown}
            onPointerMove={handleViewerPointerMove}
            onPointerUp={handleViewerPointerUp}
            onPointerCancel={handleViewerPointerCancel}
            onWheel={handleViewerWheel}
          >
            {desktopFrame && desktopViewerImageUrl ? (
              <img
                className={styles.viewerImage}
                src={desktopViewerImageUrl}
                alt="Remote desktop"
                draggable={false}
                onError={() => setViewerStreamStatus("fallback")}
                onLoad={handleViewerImageLoad}
                style={{
                  height: `${viewerLayout.imageHeight}%`,
                  left: `${viewerLayout.imageLeft}%`,
                  top: `${viewerLayout.imageTop}%`,
                  width: `${viewerLayout.imageWidth}%`
                }}
              />
            ) : (
              <div className={styles.viewerEmpty}>Desktop viewer waiting for the local agent.</div>
            )}
            <span
              className={styles.viewerCursor}
              style={{
                left: `${viewerLayout.cursorLeft}%`,
                top: `${viewerLayout.cursorTop}%`
              }}
            />
          </div>
          <div className={styles.viewerBar}>
            <span>Move to pan. Cursor stays centered until the view hits an edge. Zoom {viewerZoomPercent}%.</span>
            <button
              type="button"
              className={styles.viewerToggle}
              onClick={() => handleViewerZoomButton(-0.2)}
            >
              Zoom -
            </button>
            <button
              type="button"
              className={styles.viewerToggle}
              onClick={() => handleViewerZoomButton(0.2)}
            >
              Zoom +
            </button>
            <button
              type="button"
              className={styles.viewerToggle}
              onClick={() => setViewerZoom(1)}
            >
              Reset
            </button>
            <button
              type="button"
              className={styles.viewerToggle}
              onClick={() => setIsViewerControlEnabled((currentValue) => !currentValue)}
            >
              {isViewerControlEnabled ? "Control on" : "View only"}
            </button>
          </div>
        </section>
      ) : null}


      {isLauncherOpen ? (
        <div className={styles.launcherShell} data-no-hold="true">
          <div className={styles.launcherBackdrop} onClick={() => setIsLauncherOpen(false)} aria-hidden="true" />
          <section className={styles.launcherPanel} role="dialog" aria-label="Open a new session">
            <p className={styles.launcherTitle}>Open</p>
            <div className={styles.launcherGrid}>
              {LAUNCHER_TARGETS.map((target) => (
                <button
                  key={target}
                  type="button"
                  className={styles.launcherButton}
                  disabled={isBusy}
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
        <div className={styles.inspectorShell} data-no-hold="true">
          <section className={styles.inspectorPanel} aria-label={`${formatSessionLabel(inspectorSessionId)} terminal`}>
            <header className={styles.inspectorHeader}>
              <button type="button" className={styles.backButton} onClick={closeInspector} aria-label="Back to terminals">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M15 5l-7 7 7 7" />
                </svg>
              </button>
              <div className={styles.inspectorTitleGroup}>
                <h2 className={styles.inspectorTitle}>{formatSessionLabel(inspectorSessionId)}</h2>
                <span className={`${styles.statusPill} ${styles[`statusPill_${inspectorStatus.tone}`] || ""}`}>
                  <span className={`${styles.statusDot} ${styles[`statusDot_${inspectorStatus.tone}`] || ""}`} aria-hidden="true" />
                  {inspectorStatus.label}
                  {inspectorElapsed ? <span className={styles.tileElapsed}>{inspectorElapsed}</span> : null}
                </span>
              </div>
              <button
                type="button"
                className={styles.iconButton}
                aria-label="Source control and files"
                disabled={!voiceApiBase}
                onClick={() => {
                  setIsInspectorMenuOpen(false);
                  setIsGitPanelOpen(true);
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="5" r="2.2" />
                  <circle cx="6" cy="19" r="2.2" />
                  <circle cx="18" cy="7" r="2.2" />
                  <path d="M6 7.2v9.6" />
                  <path d="M18 9.2c0 5-6 3.5-11.2 8" />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.iconButton} ${isInspectorMenuOpen ? styles.iconButtonActive : ""}`}
                aria-label="Terminal options"
                aria-expanded={isInspectorMenuOpen}
                onClick={() => {
                  setIsInspectorMenuOpen((currentValue) => !currentValue);
                  setIsConfirmingKill(false);
                }}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.9" />
                  <circle cx="12" cy="12" r="1.9" />
                  <circle cx="19" cy="12" r="1.9" />
                </svg>
              </button>
            </header>

            {isInspectorMenuOpen ? (
              <div className={styles.inspectorMenu}>
                <div className={styles.menuRow}>
                  <span>Text size</span>
                  <div className={styles.stepper}>
                    <button
                      type="button"
                      aria-label="Smaller text"
                      disabled={terminalFontSize <= MIN_TERMINAL_FONT}
                      onClick={() => setTerminalFontSize((size) => Math.max(MIN_TERMINAL_FONT, size - 1))}
                    >
                      A−
                    </button>
                    <strong>{terminalFontSize}</strong>
                    <button
                      type="button"
                      aria-label="Larger text"
                      disabled={terminalFontSize >= MAX_TERMINAL_FONT}
                      onClick={() => setTerminalFontSize((size) => Math.min(MAX_TERMINAL_FONT, size + 1))}
                    >
                      A+
                    </button>
                  </div>
                </div>
                <label className={styles.menuRow}>
                  <span>Fit terminal to phone width</span>
                  <input
                    type="checkbox"
                    className={styles.switch}
                    checked={fitTerminalWidth}
                    onChange={(event) => setFitTerminalWidth(event.currentTarget.checked)}
                  />
                </label>
                <label className={styles.menuRow}>
                  <span>Read results aloud</span>
                  <input
                    type="checkbox"
                    className={styles.switch}
                    checked={speakResults}
                    onChange={(event) => setSpeakResults(event.currentTarget.checked)}
                  />
                </label>
                <button
                  type="button"
                  className={`${styles.menuDanger} ${isConfirmingKill ? styles.menuDangerConfirm : ""}`}
                  onClick={() => void killInspectorSession()}
                >
                  {isConfirmingKill ? `Tap again to close ${formatSessionLabel(inspectorSessionId)}` : "Close this session"}
                </button>
              </div>
            ) : null}

            <div className={styles.outputWrap}>
              <pre
                ref={outputPanelRef}
                className={styles.outputPanel}
                style={{ fontSize: `${terminalFontSize}px` }}
                onScroll={handleOutputScroll}
              >
                {sessionStream?.missing
                  ? "This session has ended."
                  : sessionStream?.outputAvailable === false
                    ? sessionStream.message || "Live output is not available for this session."
                    : sessionStream?.output || (sessionStream ? "" : "Connecting to terminal…")}
              </pre>
              <span ref={charMeasureRef} className={styles.charMeasure} style={{ fontSize: `${terminalFontSize}px` }} aria-hidden="true">
                MMMMMMMMMMMMMMMMMMMM
              </span>
              {!isOutputPinnedToBottom ? (
                <button type="button" className={styles.jumpButton} onClick={jumpToLatestOutput}>
                  ↓ Latest
                </button>
              ) : null}
            </div>

            {sessionStream?.error ? <p className={styles.inspectorMessage} role="alert">{sessionStream.error}</p> : null}

            {isListening || isSpeakingOutput || status === "processing" ? (
              <div className={styles.voiceBar} aria-live="polite">
                <span className={`${styles.voiceBarDot} ${isListening ? styles.voiceBarDotLive : ""}`} aria-hidden="true" />
                <span className={styles.voiceBarText}>
                  {isListening
                    ? liveTranscript || "Listening… release to send"
                    : status === "processing"
                      ? "Sending voice command…"
                      : "Reading the result aloud"}
                </span>
                {isSpeakingOutput ? (
                  <button
                    type="button"
                    className={styles.voiceBarStop}
                    onClick={() => {
                      stopTerminalSpeechPlayback(speechAudioRef, speechGainNodeRef, setIsSpeakingOutput);
                      speechRequestSeqRef.current += 1;
                      pendingInspectorSpeechSessionRef.current = null;
                      const currentSpeechText = buildTerminalSpeechText(sessionStream?.output || "");
                      if (currentSpeechText) {
                        spokenOutputSignatureRef.current = `${inspectorSessionId}:${currentSpeechText}`;
                      }
                    }}
                  >
                    Stop
                  </button>
                ) : null}
              </div>
            ) : null}

            <div className={styles.composer}>
              {terminalInputAvailable ? (
                <div className={styles.keyStrip} role="toolbar" aria-label="Special keys">
                  {TERMINAL_KEYS.map((entry) => (
                    <button
                      key={entry.key}
                      type="button"
                      className={`${styles.keyButton} ${entry.key === "ctrl+c" ? styles.keyButtonDanger : ""}`}
                      aria-label={entry.aria}
                      disabled={isSendingTerminalInput}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => void sendTerminalInput({ key: entry.key })}
                    >
                      {entry.label}
                    </button>
                  ))}
                </div>
              ) : null}
              <form
                className={styles.composerRow}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!terminalInputAvailable) {
                    return;
                  }
                  void sendTerminalInput({ text: terminalInput });
                }}
              >
                <button
                  ref={inspectorTalkButtonRef}
                  type="button"
                  className={`${styles.talkButton} ${isListening || isPressingToRecord ? styles.talkButtonActive : ""} ${terminalInputAvailable ? "" : styles.talkButtonWide}`}
                  aria-label={micEnabled ? "Hold to talk to this terminal" : "Tap to allow the microphone"}
                  title={micEnabled ? undefined : "Tap to allow the microphone"}
                  onPointerDown={(event) => {
                    if (event.button !== 0 && event.pointerType === "mouse") {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    trySetPointerCapture(event.currentTarget, event.pointerId);
                    handleInspectorVoiceButtonStart(event.pointerId);
                  }}
                  onPointerUp={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    handleInspectorVoiceButtonEnd(event.currentTarget, event.pointerId);
                  }}
                  onPointerCancel={(event) => {
                    event.stopPropagation();
                    handleInspectorVoiceButtonEnd(event.currentTarget, event.pointerId);
                  }}
                  onContextMenu={(event) => event.preventDefault()}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" x2="12" y1="19" y2="22" />
                  </svg>
                  {terminalInputAvailable ? null : <span>{isListening ? "Release to send" : "Hold to talk"}</span>}
                </button>
                {terminalInputAvailable ? (
                  <>
                    <input
                      ref={terminalInputRef}
                      className={styles.composerInput}
                      type="text"
                      inputMode="text"
                      enterKeyHint="send"
                      autoCapitalize="off"
                      autoCorrect="off"
                      autoComplete="off"
                      spellCheck={false}
                      value={terminalInput}
                      onChange={(event) => setTerminalInput(event.target.value)}
                      placeholder={inspectorStatus.tone === "input" ? "Type your answer…" : "Type a command…"}
                      aria-label="Command"
                    />
                    <button
                      type="submit"
                      className={styles.sendButton}
                      disabled={isSendingTerminalInput}
                      onPointerDown={(event) => event.preventDefault()}
                      aria-label={terminalInput.trim() ? "Run command" : "Press Enter"}
                    >
                      {isSendingTerminalInput ? (
                        <span className={styles.sendSpinner} aria-hidden="true" />
                      ) : terminalInput.trim() ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M12 19V5" />
                          <path d="M5 12l7-7 7 7" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                          <path d="M20 5v7a3 3 0 0 1-3 3H5" />
                          <path d="M9 11l-4 4 4 4" />
                        </svg>
                      )}
                      <span className={styles.sendLabel}>{terminalInput.trim() ? "Run" : "Enter"}</span>
                    </button>
                  </>
                ) : null}
              </form>
            </div>
          </section>
        </div>
      ) : null}

      {inspectorSessionId && isGitPanelOpen && voiceApiBase ? (
        <GitPanel
          apiBase={voiceApiBase}
          sessionId={inspectorSessionId}
          sessionLabel={formatSessionLabel(inspectorSessionId)}
          onClose={() => setIsGitPanelOpen(false)}
        />
      ) : null}

      {isSettingsOpen ? (
        <div className={styles.settingsShell} data-no-hold="true">
          <div className={styles.settingsBackdrop} onClick={() => setIsSettingsOpen(false)} aria-hidden="true" />
          <section className={styles.settingsPanel} role="dialog" aria-label="Settings">
            <header className={styles.settingsHeader}>
              <div>
                <p className={styles.settingsEyebrow}>Settings</p>
                <h2 className={styles.settingsTitle}>Sylio Radio</h2>
              </div>
              <button type="button" className={styles.closeButton} onClick={() => setIsSettingsOpen(false)}>
                Done
              </button>
            </header>

            <div className={styles.settingsSection}>
              <p className={styles.settingsSectionTitle}>Notifications</p>
              <p className={styles.settingsHelp}>{describePushState(pushState)}</p>
              <div className={styles.settingsActions}>
                {pushState === "on" ? (
                  <>
                    <button type="button" className={styles.settingsPrimary} onClick={() => void sendTestNotification()}>
                      Send test
                    </button>
                    <button type="button" className={styles.settingsSecondary} onClick={() => void disablePushNotifications()}>
                      Turn off
                    </button>
                  </>
                ) : pushState === "off" || pushState === "working" ? (
                  <button
                    type="button"
                    className={styles.settingsPrimary}
                    disabled={pushState === "working"}
                    onClick={() => void enablePushNotifications()}
                  >
                    {pushState === "working" ? "Working…" : "Turn on notifications"}
                  </button>
                ) : null}
              </div>
              {pushMessage ? <p className={styles.settingsNote}>{pushMessage}</p> : null}
            </div>

            <div className={styles.settingsSection}>
              <p className={styles.settingsSectionTitle}>Microphone</p>
              <label className={styles.menuRow}>
                <span>Voice input (hold to talk)</span>
                <input
                  type="checkbox"
                  className={styles.switch}
                  checked={micEnabled}
                  onChange={(event) => {
                    if (event.currentTarget.checked) {
                      void enableMic();
                    } else {
                      setMicMessage("");
                      setMicEnabled(false);
                    }
                  }}
                />
              </label>
              <p className={styles.settingsHelp}>
                Optional. The mic only opens while you&apos;re holding to talk, so music from other apps keeps
                playing the rest of the time.
              </p>
              {micMessage ? <p className={styles.settingsNote}>{micMessage}</p> : null}
            </div>

            <div className={styles.settingsSection}>
              <label className={styles.menuRow}>
                <span>Read results aloud</span>
                <input
                  type="checkbox"
                  className={styles.switch}
                  checked={speakResults}
                  onChange={(event) => setSpeakResults(event.currentTarget.checked)}
                />
              </label>
              <label className={styles.settingsRange}>
                <span>Voice volume</span>
                <strong>{Math.round(speechVolume * 100)}%</strong>
                <input
                  type="range"
                  min="0"
                  max="10"
                  step="0.05"
                  value={speechVolume}
                  onChange={(event) => setSpeechVolume(Number(event.currentTarget.value))}
                />
              </label>
            </div>

            <div className={styles.settingsSection}>
              <div className={styles.menuRow}>
                <span>Terminal text size</span>
                <div className={styles.stepper}>
                  <button
                    type="button"
                    aria-label="Smaller text"
                    disabled={terminalFontSize <= MIN_TERMINAL_FONT}
                    onClick={() => setTerminalFontSize((size) => Math.max(MIN_TERMINAL_FONT, size - 1))}
                  >
                    A−
                  </button>
                  <strong>{terminalFontSize}</strong>
                  <button
                    type="button"
                    aria-label="Larger text"
                    disabled={terminalFontSize >= MAX_TERMINAL_FONT}
                    onClick={() => setTerminalFontSize((size) => Math.min(MAX_TERMINAL_FONT, size + 1))}
                  >
                    A+
                  </button>
                </div>
              </div>
              <label className={styles.menuRow}>
                <span>Fit terminal to phone width</span>
                <input
                  type="checkbox"
                  className={styles.switch}
                  checked={fitTerminalWidth}
                  onChange={(event) => setFitTerminalWidth(event.currentTarget.checked)}
                />
              </label>
            </div>
          </section>
        </div>
      ) : null}

      {toasts.length > 0 ? (
        <div className={styles.toastStack} data-no-hold="true" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`${styles.toast} ${styles[`toast_${toast.kind}`] || ""}`}>
              <button
                type="button"
                className={styles.toastBody}
                onClick={() => {
                  dismissToast(toast.id);
                  if (sessionIds.includes(toast.sessionId)) {
                    setActiveView("sessions");
                    openInspector(toast.sessionId);
                  }
                }}
              >
                <strong>{toast.title}</strong>
                {toast.body ? <span>{toast.body}</span> : null}
              </button>
              <button type="button" className={styles.toastClose} aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {isListening && liveTranscript && !inspectorSessionId ? (
        <div className={styles.liveTranscript} aria-live="polite">
          {liveTranscript}
        </div>
      ) : null}

      {activeView === "sessions" && !inspectorSessionId ? (
        <div
          className={`${styles.micIconContainer} ${isListening || isPressingToRecord ? styles.micIconContainerActive : ""} ${status === "processing" ? styles.micIconContainerBusy : ""}`}
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
      ) : null}

      <nav className={styles.bottomTabs} data-no-hold="true" aria-label="Radio navigation">
        <button
          type="button"
          className={`${styles.bottomTab} ${activeView === "sessions" ? styles.bottomTabActive : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setActiveView("sessions");
          }}
        >
          Terminals
          {Object.keys(unreadSessions).length > 0 ? (
            <span className={styles.tabBadge}>{Object.keys(unreadSessions).length}</span>
          ) : null}
        </button>
        <button
          type="button"
          className={`${styles.bottomTab} ${activeView === "viewer" ? styles.bottomTabActive : ""}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            setActiveView("viewer");
          }}
        >
          Screen
        </button>
      </nav>
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

function releaseMicStream(
  streamRef: MutableRefObject<MediaStream | null>,
  streamRequestRef: MutableRefObject<Promise<MediaStream> | null>
) {
  const stream = streamRef.current;
  streamRef.current = null;
  for (const track of stream?.getTracks() ?? []) {
    track.stop();
  }

  // A request still in flight would otherwise leave the mic open once it resolves.
  const pending = streamRequestRef.current;
  if (pending) {
    pending
      .then((pendingStream) => {
        if (streamRef.current === pendingStream) {
          streamRef.current = null;
        }
        for (const track of pendingStream.getTracks()) {
          track.stop();
        }
      })
      .catch(() => undefined);
  }
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

function clampRatio(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(value, 1));
}

function resolveViewerCoordinate(
  event: PointerEvent<HTMLDivElement>,
  layout: ReturnType<typeof getViewerLayout>
) {
  const bounds = event.currentTarget.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) {
    return null;
  }

  const localX = clampRatio((event.clientX - bounds.left) / bounds.width);
  const localY = clampRatio((event.clientY - bounds.top) / bounds.height);

  return {
    ratioX: clampRatio(((localX * 100) - layout.imageLeft) / layout.imageWidth),
    ratioY: clampRatio(((localY * 100) - layout.imageTop) / layout.imageHeight)
  };
}

function getViewerLayout(
  zoom: number,
  cursor: { x: number; y: number },
  desktopFrame: DesktopFrameState | null,
  viewerSize: { width: number; height: number }
) {
  const nextZoom = clampZoom(zoom);
  const desktopAspect = (desktopFrame?.screenWidth || 1920) / Math.max(desktopFrame?.screenHeight || 1080, 1);
  const viewerAspect = viewerSize.width / Math.max(viewerSize.height, 1);
  const baseWidth = desktopAspect >= viewerAspect ? 100 : (desktopAspect / viewerAspect) * 100;
  const baseHeight = desktopAspect >= viewerAspect ? (viewerAspect / desktopAspect) * 100 : 100;
  const imageWidth = baseWidth * nextZoom;
  const imageHeight = baseHeight * nextZoom;
  const imageLeft = resolveViewerAxisOffset(cursor.x, imageWidth);
  const imageTop = resolveViewerAxisOffset(cursor.y, imageHeight);

  return {
    cursorLeft: clampPercent(imageLeft + cursor.x * imageWidth, 0, 100),
    cursorTop: clampPercent(imageTop + cursor.y * imageHeight, 0, 100),
    imageHeight,
    imageLeft,
    imageTop,
    imageWidth
  };
}

function resolveViewerAxisOffset(cursorRatio: number, imageSize: number) {
  if (imageSize <= 100) {
    return 50 - imageSize / 2;
  }

  return clampPercent(50 - cursorRatio * imageSize, 100 - imageSize, 0);
}

function clampPercent(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.max(min, Math.min(value, max));
}

function clampZoom(value: number) {
  if (!Number.isFinite(value)) {
    return 1;
  }

  return Math.max(1, Math.min(value, 4));
}

function getPointerDistance(pointers: Map<number, { x: number; y: number }>) {
  const [firstPointer, secondPointer] = Array.from(pointers.values());
  if (!firstPointer || !secondPointer) {
    return 0;
  }

  return Math.hypot(firstPointer.x - secondPointer.x, firstPointer.y - secondPointer.y);
}

async function hasAudibleSignal(audioBlob: Blob) {
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextConstructor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
  if (!AudioContextConstructor) {
    return true;
  }

  try {
    const audioContext = new AudioContextConstructor();
    const audioBuffer = await audioContext.decodeAudioData(await audioBlob.arrayBuffer());
    await audioContext.close();
    let peak = 0;
    let sumSquares = 0;
    let sampleCount = 0;

    for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
      const channelData = audioBuffer.getChannelData(channelIndex);

      for (let sampleIndex = 0; sampleIndex < channelData.length; sampleIndex += 1) {
        const sample = Math.abs(channelData[sampleIndex] || 0);
        peak = Math.max(peak, sample);
        sumSquares += sample * sample;
        sampleCount += 1;
      }
    }

    const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
    return peak >= MIN_AUDIBLE_PEAK || rms >= MIN_AUDIBLE_RMS;
  } catch {
    return true;
  }
}

const CLAUDE_SPEECH_MAX_CHARS = 2000;

// Claude Code renders each message as a "● " bullet at column 0 with its
// continuation lines indented. Tool calls are bullets too ("● Update(file)")
// followed by "⎿" result lines and diffs. Speak only the prose bullets from the
// latest turn, so edits, diffs, and tool output are never read aloud.
function buildClaudeSpeechText(output: string): string | null {
  const lines = output.split(/\r?\n/).map((line) => line.replace(/\s+$/, ""));
  const isBulletLine = (line: string) => /^[●⏺]\s/.test(line);

  let lastBulletIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isBulletLine(lines[index] || "")) {
      lastBulletIndex = index;
      break;
    }
  }

  if (lastBulletIndex < 0) {
    return null;
  }

  // The turn starts after the most recent user prompt above the last bullet.
  let turnStart = 0;
  for (let index = lastBulletIndex; index >= 0; index -= 1) {
    if (/^[>❯›]\s/.test(lines[index] || "")) {
      turnStart = index + 1;
      break;
    }
  }

  const blocks: string[][] = [];
  let current: string[] | null = null;
  for (let index = turnStart; index < lines.length; index += 1) {
    const line = lines[index] || "";
    if (isBulletLine(line)) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (!current) {
      continue;
    }
    // Anything else at column 0 (status lines, input box rules, user prompts) ends the block.
    if (line && !/^\s/.test(line)) {
      current = null;
      continue;
    }
    current.push(line);
  }

  const proseBlocks: string[] = [];
  for (const block of blocks) {
    const head = (block[0] || "").replace(/^[●⏺]\s+/, "");
    const isToolCall =
      block.some((line) => line.includes("⎿")) ||
      /^[\w.:-]+(\s+-\s+[\w.:-]+)*\s*(\(MCP\))?\(/.test(head) ||
      /^(Read|Searched|Listed|Update(d)? Todos|Wrote|Ran)\b.*\b(files?|patterns?|lines?|todos?|commands?|directories?)\b/i.test(head);
    if (isToolCall) {
      continue;
    }

    const paragraphs: string[] = [];
    let paragraph: string[] = [];
    const flush = () => {
      if (paragraph.length) {
        paragraphs.push(paragraph.join(" "));
        paragraph = [];
      }
    };

    for (const [lineIndex, rawLine] of block.entries()) {
      const text = (lineIndex === 0 ? head : rawLine).trim();
      if (!text) {
        flush();
        continue;
      }
      if (isLikelyCodeOrTableLine(text)) {
        flush();
        continue;
      }
      paragraph.push(text.replace(/\*\*|__|`/g, ""));
    }
    flush();

    if (paragraphs.length) {
      proseBlocks.push(paragraphs.join("\n"));
    }
  }

  // Keep the end of the turn (the summary) when the whole turn is too long to read.
  const kept: string[] = [];
  let total = 0;
  for (let index = proseBlocks.length - 1; index >= 0; index -= 1) {
    const block = proseBlocks[index] || "";
    if (kept.length && total + block.length > CLAUDE_SPEECH_MAX_CHARS) {
      break;
    }
    kept.unshift(block);
    total += block.length;
  }

  return kept.join("\n\n").slice(0, CLAUDE_SPEECH_MAX_CHARS).trim();
}

function isLikelyCodeOrTableLine(text: string) {
  if (/[│┃┌┐└┘├┤┬┴┼─━]/.test(text)) {
    return true;
  }
  if (/^\d+\s*[+-]?\s/.test(text) && /[;{}()=]/.test(text)) {
    return true; // numbered diff / code listing line
  }
  const symbols = (text.match(/[{}()[\];=<>$|\\]/g) || []).length;
  return text.length > 0 && symbols / text.length > 0.12;
}

function buildTerminalSpeechText(output: string) {
  const claudeSpeech = buildClaudeSpeechText(output);
  if (claudeSpeech !== null) {
    return claudeSpeech;
  }

  const cleanedLines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isTerminalSpeechNoiseLine(line));

  let latestAssistantIndex = -1;
  for (let index = cleanedLines.length - 1; index >= 0; index -= 1) {
    if (isLikelyAssistantResponseLine(cleanedLines[index] || "")) {
      latestAssistantIndex = index;
      break;
    }
  }

  if (latestAssistantIndex < 0) {
    return "";
  }

  let startIndex = latestAssistantIndex;
  while (startIndex > 0 && isAssistantContinuationLine(cleanedLines[startIndex - 1] || "")) {
    startIndex -= 1;
  }

  let endIndex = latestAssistantIndex;
  while (endIndex + 1 < cleanedLines.length && isAssistantContinuationLine(cleanedLines[endIndex + 1] || "")) {
    endIndex += 1;
  }

  return cleanedLines
    .slice(startIndex, endIndex + 1)
    .filter((line) => isLikelyAssistantResponseLine(line) || isAssistantContinuationLine(line))
    .join("\n")
    .slice(-1200)
    .trim();
}

function isTerminalSpeechNoiseLine(line: string) {
  const normalized = line.trim().toLowerCase();

  return (
    !normalized ||
    /^working\b/i.test(line) ||
    /^[•·]\s*work/i.test(line) ||
    /^[•·]\s*$/i.test(line) ||
    /\besc to interrupt\b/i.test(line) ||
    /^work(?:ing)?$/i.test(line) ||
    /^boo(?:t(?:ing?)?)?\s*m?c?$/i.test(line) ||
    /^(orking|rking|king|ing|ng|g)\d*$/i.test(line) ||
    /^wor(?:k(?:i(?:ng?)?)?)?\d*$/i.test(line) ||
    /^microsoft\s+windows\s+\[version/i.test(line) ||
    /^\(c\)\s+microsoft\s+corporation/i.test(line) ||
    /^windows\s+powershell/i.test(line) ||
    /^copyright\s+\(c\)\s+microsoft/i.test(line) ||
    /^install\s+the\s+latest\s+powershell/i.test(line) ||
    /^[a-z]:\\.*>/i.test(line) ||
    /^>\s*_?\s*openai codex/i.test(line) ||
    /^model:\s+/i.test(line) ||
    /^directory:\s+/i.test(line) ||
    /^ps\s+[a-z]:\\/i.test(line) ||
    /^gpt-[\w.-]+\s+(low|medium|high)\b/i.test(line) ||
    /^\w[\w\s.-]+\s+gpt-[\w.-]+\s+(low|medium|high)\b/i.test(line) ||
    /^summarize recent commits$/i.test(line) ||
    /@filename\b/i.test(line) ||
    /^improve documentation in @filename$/i.test(line) ||
    /^tip:\s+/i.test(line) ||
    /^\[features\]\.collab/i.test(line) ||
    /^enable it with /i.test(line) ||
    /^https:\/\/developers\.openai\.com/i.test(line) ||
    /^heads up,/i.test(line) ||
    normalized.includes("if the speaker says") ||
    normalized.includes("return hello") ||
    normalized.includes("transcribe exactly")
  );
}

function isTerminalSpeechBoundaryLine(line: string) {
  return (
    /^codex$/i.test(line) ||
    /^>\s*_?\s*openai codex/i.test(line) ||
    /^model:\s+/i.test(line) ||
    /^directory:\s+/i.test(line) ||
    /^gpt-[\w.-]+\s+(low|medium|high)\b/i.test(line) ||
    /^\w[\w\s.-]+\s+gpt-[\w.-]+\s+(low|medium|high)\b/i.test(line) ||
    /^[a-z]:\\.*>/i.test(line)
  );
}

function isLikelyUserEchoLine(line: string) {
  const normalized = line.trim().toLowerCase();
  return (
    /^[›>]\s/.test(line) ||
    /^(how are you|what\??|whyats the date|what'?s the date|summarize recent commits)$/i.test(line) ||
    /@filename\b/i.test(line) ||
    /^'.+' is not recognized as an internal or external command/i.test(line) ||
    /^operable program or batch file\.?$/i.test(line) ||
    normalized.length <= 2
  );
}

function isLikelyAssistantResponseLine(line: string) {
  const normalized = line.trim().toLowerCase();

  if (isTerminalSpeechNoiseLine(line) || isTerminalSpeechBoundaryLine(line) || isLikelyUserEchoLine(line)) {
    return false;
  }

  const content = line.replace(/^[•·]\s*/, "");
  const minLength = content !== line ? 3 : 8;

  return (
    content.length >= minLength &&
    /[a-z]/i.test(content) &&
    !/^['"`]/.test(content) &&
    (
      /[.!?]$/.test(content) ||
      /^(doing|ready|the|i|you|it|this|that|there|here|yes|no|sure|okay|ok)\b/i.test(content)
    ) &&
    !normalized.includes("not recognized as an internal or external command")
  );
}

function isAssistantContinuationLine(line: string) {
  if (isTerminalSpeechNoiseLine(line) || isTerminalSpeechBoundaryLine(line) || isLikelyUserEchoLine(line)) {
    return false;
  }

  return line.length >= 4 && /[a-z]/i.test(line);
}

async function speakTerminalOutput(
  voiceApiBase: string,
  text: string,
  speechAudioRef: MutableRefObject<HTMLAudioElement | null>,
  speechVolumeRef: MutableRefObject<number>,
  speechAudioContextRef: MutableRefObject<AudioContext | null>,
  speechGainNodeRef: MutableRefObject<GainNode | null>,
  setIsSpeakingOutput: Dispatch<SetStateAction<boolean>>,
  speechRequestSeqRef: MutableRefObject<number>,
  speechRequestId: number
) {
  if (speechRequestSeqRef.current !== speechRequestId) {
    return;
  }

  const response = await fetch(`${voiceApiBase}/tts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ text })
  });

  if (speechRequestSeqRef.current !== speechRequestId) {
    return;
  }

  if (!response.ok) {
    return;
  }

  const audioBlob = await response.blob();
  if (speechRequestSeqRef.current !== speechRequestId) {
    return;
  }

  setIsSpeakingOutput(true);
  const audioUrl = URL.createObjectURL(audioBlob);
  const previousAudio = speechAudioRef.current;

  if (previousAudio) {
    previousAudio.pause();
    URL.revokeObjectURL(previousAudio.src);
  }

  const audio = new Audio(audioUrl);
  speechAudioRef.current = audio;

  // Use Web Audio GainNode so the slider can boost past 100%
  const audioWindow = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AudioContextCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
  let usedGainNode = false;

  if (AudioContextCtor) {
    try {
      let audioCtx = speechAudioContextRef.current;
      if (!audioCtx || audioCtx.state === "closed") {
        audioCtx = new AudioContextCtor();
        speechAudioContextRef.current = audioCtx;
      }
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      const source = audioCtx.createMediaElementSource(audio);
      const gainNode = audioCtx.createGain();
      gainNode.gain.value = Math.max(0, speechVolumeRef.current);
      source.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      speechGainNodeRef.current = gainNode;
      usedGainNode = true;
    } catch {
      // Fall through to direct volume
    }
  }

  if (!usedGainNode) {
    audio.volume = clampRatio(Math.min(1, speechVolumeRef.current));
  }

  audio.onended = () => {
    URL.revokeObjectURL(audioUrl);
    if (speechAudioRef.current === audio) {
      speechAudioRef.current = null;
      speechGainNodeRef.current = null;
    }
    if (speechRequestSeqRef.current === speechRequestId) {
      setIsSpeakingOutput(false);
    }
  };
  await audio.play().catch(() => {
    URL.revokeObjectURL(audioUrl);
    if (speechAudioRef.current === audio) {
      speechAudioRef.current = null;
      speechGainNodeRef.current = null;
    }
    if (speechRequestSeqRef.current === speechRequestId) {
      setIsSpeakingOutput(false);
    }
  });
}

function stopTerminalSpeechPlayback(
  speechAudioRef: MutableRefObject<HTMLAudioElement | null>,
  speechGainNodeRef: MutableRefObject<GainNode | null>,
  setIsSpeakingOutput: Dispatch<SetStateAction<boolean>>
) {
  const activeAudio = speechAudioRef.current;
  if (activeAudio) {
    activeAudio.pause();
    activeAudio.currentTime = 0;
    if (activeAudio.src) {
      URL.revokeObjectURL(activeAudio.src);
    }
    speechAudioRef.current = null;
  }

  speechGainNodeRef.current = null;
  setIsSpeakingOutput(false);
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
  const orderedSessions = sortSessionIds(sessionIds).slice(0, 9);
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

  slots.push({ kind: "placeholder", id: "launcher-placeholder" });

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

function formatSessionLabelForSpeech(sessionId: string) {
  return formatSessionLabel(sessionId).replace(/-/g, " ");
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

  const numbered = normalized.match(/^(cmd|powershell)-(\d+)$/);
  if (numbered) {
    return `${labelMap[numbered[1]]} ${numbered[2]}`;
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function getInspectorStatus(stream: SessionStreamResponse | null, isSending: boolean) {
  if (!stream) {
    return { label: "Connecting", tone: "muted" };
  }

  if (stream.missing) {
    return { label: "Ended", tone: "muted" };
  }

  if (stream.outputAvailable === false) {
    return { label: "App", tone: "muted" };
  }

  if (stream.waitingForInput) {
    return { label: "Needs input", tone: "input" };
  }

  if (stream.isBusy) {
    return { label: "Running", tone: "running" };
  }

  if (isSending) {
    return { label: "Sending", tone: "running" };
  }

  return { label: "Ready", tone: "ready" };
}

function getTileState(status: SessionStatus | undefined, unreadKind: string | undefined) {
  if (!status) {
    return { label: "Starting…", tone: "muted" };
  }

  if (status.activity === "app") {
    return { label: "Desktop app", tone: "muted" };
  }

  if (status.waitingForInput) {
    return { label: "Needs input", tone: "input" };
  }

  if (status.activity === "running") {
    return { label: "Running", tone: "running" };
  }

  if (unreadKind === "finished") {
    return { label: "Finished", tone: "done" };
  }

  if (unreadKind === "exited") {
    return { label: "Closed", tone: "muted" };
  }

  return { label: "Ready", tone: "ready" };
}

function formatElapsed(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.round(Math.max(0, durationMs) / 1000);
  if (totalSeconds <= 0) {
    return "";
  }

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      cache: "no-store",
      ...init,
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function playChime(audioContextRef: MutableRefObject<AudioContext | null>, urgent: boolean) {
  try {
    const audioWindow = window as Window & {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AudioContextCtor = audioWindow.AudioContext || audioWindow.webkitAudioContext;
    if (!AudioContextCtor) {
      return;
    }

    let context = audioContextRef.current;
    if (!context || context.state === "closed") {
      context = new AudioContextCtor();
      audioContextRef.current = context;
    }

    if (context.state === "suspended") {
      void context.resume().catch(() => {});
    }

    const notes = urgent ? [880, 660, 880] : [660, 990];
    const startAt = context.currentTime + 0.02;
    notes.forEach((frequency, index) => {
      const oscillator = context!.createOscillator();
      const gain = context!.createGain();
      const noteStart = startAt + index * 0.14;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, noteStart);
      gain.gain.exponentialRampToValueAtTime(0.18, noteStart + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.13);
      oscillator.connect(gain);
      gain.connect(context!.destination);
      oscillator.start(noteStart);
      oscillator.stop(noteStart + 0.14);
    });
  } catch {
    // Sound is a nice-to-have.
  }
}

function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }

  return output;
}

function isIosDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandaloneDisplay() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    Boolean((navigator as Navigator & { standalone?: boolean }).standalone)
  );
}

function describePushState(state: PushState) {
  switch (state) {
    case "on":
      return "On. You'll get a notification when a terminal finishes or needs input, even when the app is closed.";
    case "off":
      return "Get a notification on this phone when a terminal finishes or is waiting for input.";
    case "working":
      return "Setting up notifications…";
    case "denied":
      return "Notifications are blocked for this site. Allow them in your phone's settings for this app, then reopen it.";
    case "needs-install":
      return "On iPhone, notifications need the app on your Home Screen: tap Share → Add to Home Screen, then open it from there.";
    case "unsupported":
      return "This browser doesn't support push notifications. You'll still see alerts while the app is open.";
    default:
      return "Checking notification support…";
  }
}
