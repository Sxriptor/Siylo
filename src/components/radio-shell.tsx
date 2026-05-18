"use client";

import type { Dispatch, MutableRefObject, PointerEvent, RefObject, SetStateAction, WheelEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./radio-shell.module.css";

const DEFAULT_SESSION_IDS = ["cmd-1", "cmd-2", "cursor", "codex"];
const LAUNCHER_TARGETS = ["cmd", "powershell", "cursor", "codex"] as const;
const SESSION_STORAGE_KEY = "siylo-radio-session-id";
const RADIO_API_BASE = process.env.NEXT_PUBLIC_RADIO_API_BASE?.replace(/\/$/, "") ?? "";
const HOLD_TO_RECORD_DELAY_MS = 1000;
const SESSION_POLL_INTERVAL_MS = 900;
const PENDING_SESSION_GRACE_MS = 5000;
const MIN_AUDIBLE_PEAK = 0.015;
const MIN_AUDIBLE_RMS = 0.003;
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
  error?: string;
  inputAvailable?: boolean;
  isBusy?: boolean;
  message?: string;
  output?: string;
  outputAvailable?: boolean;
  sessionId?: string;
  status?: string;
};

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
  const [isKeyboardOpen, setIsKeyboardOpen] = useState(false);
  const [terminalInput, setTerminalInput] = useState("");
  const [isSendingTerminalInput, setIsSendingTerminalInput] = useState(false);
  const [isSpeakingOutput, setIsSpeakingOutput] = useState(false);
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
  const desktopPointerSendRef = useRef(0);
  const viewerCursorRef = useRef(viewerCursor);
  const viewerFallbackImageUrlRef = useRef("");
  const speechAudioRef = useRef<HTMLAudioElement | null>(null);
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

  const isBusy = status === "processing";
  const isListening = status === "listening";
  const sessionSlots = useMemo(() => buildSessionSlots(sessionIds), [sessionIds]);
  const inspectorStatusLabel = getInspectorStatusLabel(sessionStream);
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

    navigator.serviceWorker.register("/sw.js").catch(() => {
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

    if (isNowBusy || (!wasBusy && !isPendingSpeech)) {
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
    if (isKeyboardOpen) {
      terminalInputRef.current?.focus();
    }
  }, [isKeyboardOpen]);

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
    }

    button.addEventListener("touchstart", onTouchStart, { passive: false });
    return () => button.removeEventListener("touchstart", onTouchStart);
  }, [inspectorSessionId]);

  useEffect(() => {
    const area = mainHoldAreaRef.current;
    if (!area) return;

    function onTouchStart() {
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
    }

    area.addEventListener("touchstart", onTouchStart, { passive: true });
    return () => area.removeEventListener("touchstart", onTouchStart);
  }, []);

  async function handleHoldStart(pointerId: number, options: { allowInspector?: boolean } = {}) {
    if (isBusy || isListening || (inspectorSessionId && !options.allowInspector)) {
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
    } catch {
      holdStartedRef.current = false;
      setIsPressingToRecord(false);
      setStatus("error");
      activePointerIdRef.current = null;
      if (options.allowInspector && inspectorSessionId) {
        setSessionStream((currentValue) => ({
          ...(currentValue || {}),
          error: "Microphone access failed. On iPhone/iPad: Settings → Safari → Microphone → Allow. On Android: tap the lock icon in your browser address bar and allow microphone.",
          sessionId: inspectorSessionId,
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
        setCurrentSessionId(pressedTarget);
        setStatus("idle");
        lastSessionTapRef.current = null;
        openInspector(pressedTarget);
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
    wasInspectorBusyRef.current = false;
    spokenOutputSignatureRef.current = "";
    pendingInspectorSpeechSessionRef.current = null;
  }

  function closeInspector() {
    setInspectorSessionId(null);
    setSessionStream(null);
    setIsKeyboardOpen(false);
    setTerminalInput("");
    setIsSendingTerminalInput(false);
    pendingInspectorSpeechSessionRef.current = null;
    speechRequestSeqRef.current += 1;
    stopTerminalSpeechPlayback(speechAudioRef, setIsSpeakingOutput);
  }

  async function uploadRecording(audioBlob: Blob, sessionId: string) {
    setStatus("processing");
    if (inspectorSessionId === sessionId) {
      pendingInspectorSpeechSessionRef.current = sessionId;
    }

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
      if (inspectorSessionId === sessionId) {
        await refreshInspectorSessionOutput(resolvedVoiceApiBase, sessionId);
      }
      setStatus("executed");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Voice request failed.";
      if (inspectorSessionId === sessionId) {
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
    pendingInspectorSpeechSessionRef.current = sessionId;

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
    pendingInspectorSpeechSessionRef.current = sessionId;

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

  function handleInspectorVoiceButtonStart(pointerId: number) {
    if (!inspectorSessionId || isBusy || isListening) {
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
          (event.target as HTMLElement).closest(`.${styles.launcherShell}`) ||
          (event.target as HTMLElement).closest(`.${styles.inspectorShell}`) ||
          (event.target as HTMLElement).closest(`.${styles.viewerDock}`) ||
          (event.target as HTMLElement).closest(`.${styles.bottomTabs}`)
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
      onContextMenu={(event) => event.preventDefault()}
    >
      {activeView === "sessions" ? (
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
            <p className={styles.inspectorHint}>
              Use the floating Talk button to speak to this terminal. Output speaks once through the current audio device after it stops working; use headphones to avoid feedback.
            </p>

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
          <button
            ref={inspectorTalkButtonRef}
            type="button"
            className={`${styles.inspectorTalkButton} ${isListening || isPressingToRecord ? styles.inspectorTalkButtonActive : ""}`}
            aria-label="Hold to speak to this terminal"
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
          >
            <span>{isListening ? "Release" : isPressingToRecord ? "Hold..." : "Talk"}</span>
          </button>
          <button
            type="button"
            className={`${styles.inspectorSpeechButton} ${isSpeakingOutput ? styles.inspectorSpeechButtonActive : ""}`}
            aria-label="Cancel spoken terminal output"
            onClick={() => {
              stopTerminalSpeechPlayback(speechAudioRef, setIsSpeakingOutput);
              speechRequestSeqRef.current += 1;
              pendingInspectorSpeechSessionRef.current = null;
              if (inspectorSessionId) {
                const currentSpeechText = buildTerminalSpeechText(sessionStream?.output || "");
                if (currentSpeechText) {
                  spokenOutputSignatureRef.current = `${inspectorSessionId}:${currentSpeechText}`;
                }
              }
            }}
          >
            <span>Cancel Voice</span>
          </button>
        </div>
      ) : null}

      {activeView === "sessions" ? (
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
      ) : null}

      <nav className={styles.bottomTabs} aria-label="Radio navigation">
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
          Viewer
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

function buildTerminalSpeechText(output: string) {
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
  audio.onended = () => {
    URL.revokeObjectURL(audioUrl);
    if (speechAudioRef.current === audio) {
      speechAudioRef.current = null;
    }
    if (speechRequestSeqRef.current === speechRequestId) {
      setIsSpeakingOutput(false);
    }
  };
  await audio.play().catch(() => {
    URL.revokeObjectURL(audioUrl);
    if (speechAudioRef.current === audio) {
      speechAudioRef.current = null;
    }
    if (speechRequestSeqRef.current === speechRequestId) {
      setIsSpeakingOutput(false);
    }
  });
}

function stopTerminalSpeechPlayback(
  speechAudioRef: MutableRefObject<HTMLAudioElement | null>,
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
