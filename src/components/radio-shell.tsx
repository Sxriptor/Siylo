"use client";

import type { MutableRefObject, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./radio-shell.module.css";

const DEFAULT_SESSION_IDS = ["cmd-1", "cmd-2", "cursor", "codex"];
const SESSION_STORAGE_KEY = "siylo-radio-session-id";
const RADIO_API_BASE = process.env.NEXT_PUBLIC_RADIO_API_BASE?.replace(/\/$/, "") ?? "";
const HOLD_TO_RECORD_DELAY_MS = 1000;

type RadioStatus = "idle" | "listening" | "processing" | "executed" | "error";

type VoiceResponse = {
  output?: string;
  route?: string;
  sessionId?: string;
  transcript?: string;
  status?: string;
  error?: string;
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

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const activePointerIdRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartedRef = useRef(false);
  const pressSessionIdRef = useRef<string | null>(null);
  const activeSessionIdRef = useRef(currentSessionId);
  const sessionIdsRef = useRef(sessionIds);

  const isBusy = status === "processing";
  const isListening = status === "listening";
  const sessionSlots = useMemo(() => buildSessionSlots(sessionIds), [sessionIds]);

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
        setSessionIds([]);
        return;
      }

      setVoiceApiBase(health.baseUrl);
      setSessionIds(mergeSessionIds(health.payload.sessions?.map((session) => session.id) || []));
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
    return () => {
      clearHoldTimer(holdTimerRef);

      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }

      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
    };
  }, []);

  async function handleHoldStart(pointerId: number) {
    if (isBusy || isListening) {
      return;
    }

    if (!voiceApiBase) {
      setStatus("error");
      return;
    }

    if (!("MediaRecorder" in window) || !navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      return;
    }

    activePointerIdRef.current = pointerId;

    try {
      const stream = await getOrCreateStream(streamRef);

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
      setStatus("error");
      activePointerIdRef.current = null;
    }
  }

  function handlePressStart(pointerId: number, target: HTMLElement) {
    if (isBusy || isListening) {
      return;
    }

    if (activePointerIdRef.current !== null) {
      return;
    }

    activePointerIdRef.current = pointerId;
    pressSessionIdRef.current = target.closest<HTMLElement>(`[data-session-id]`)?.dataset.sessionId || null;
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

    if (!holdStartedRef.current) {
      const tappedSessionId = pressSessionIdRef.current;
      pressSessionIdRef.current = null;

      if (tappedSessionId && sessionIdsRef.current.includes(tappedSessionId)) {
        setCurrentSessionId(tappedSessionId);
        setStatus("idle");
      }

      return;
    }

    pressSessionIdRef.current = null;

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

  async function uploadRecording(audioBlob: Blob, sessionId: string) {
    setStatus("processing");

    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, `radio-input.${getFileExtension(audioBlob.type)}`);
      formData.append("sessionId", sessionId);

      const response = await fetch(`${voiceApiBase}/voice`, {
        method: "POST",
        body: formData
      });

      const payload = await parseVoiceResponse(response);

      if (!response.ok) {
        throw new Error(payload?.error || `Voice request failed with ${response.status}.`);
      }

      if (payload?.sessionId) {
        setSessionIds((currentIds) => mergeSessionIds([payload.sessionId || "", ...currentIds]));
        setCurrentSessionId(payload.sessionId);
      }

      setStatus("executed");
    } catch {
      setStatus("error");
    }
  }

  return (
    <main
      className={`${styles.page} ${isListening ? styles.listening : ""}`}
      onPointerDown={(event) => {
        if (event.button !== 0 && event.pointerType === "mouse") {
          return;
        }

        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        handlePressStart(event.pointerId, event.target as HTMLElement);
      }}
      onPointerUp={(event) => {
        event.preventDefault();

        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

        handleHoldEnd(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }

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
              {formatSessionLabel(slot.id)}
            </div>
          ) : (
            <div key={slot.id} className={`${styles.sessionButton} ${styles.placeholder}`} aria-hidden="true">
              <span className={styles.plus}>+</span>
            </div>
          )
        )}
      </div>

      <div className={styles.micIconContainer}>
        <svg
          className={styles.micIcon}
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

async function getOrCreateStream(streamRef: RefObject<MediaStream | null>) {
  const existing = streamRef.current;

  if (existing && existing.active) {
    return existing;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
  });

  streamRef.current = stream;
  return stream;
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

function buildSessionSlots(sessionIds: string[]) {
  const knownSessionIds = new Set(sessionIds);
  const defaultSlots = DEFAULT_SESSION_IDS.map((sessionId) =>
    knownSessionIds.has(sessionId)
      ? ({ kind: "session", id: sessionId } as const)
      : ({ kind: "placeholder", id: `${sessionId}-placeholder` } as const)
  );

  const extraSessionSlots = sessionIds
    .filter((sessionId) => !DEFAULT_SESSION_IDS.includes(sessionId))
    .map((sessionId) => ({ kind: "session", id: sessionId } as const));

  return [...defaultSlots, ...extraSessionSlots].slice(0, 4);
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
