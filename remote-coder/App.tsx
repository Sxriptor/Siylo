import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  GestureResponderEvent,
  Image,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { VolumeManager } from "react-native-volume-manager";

const DEFAULT_SESSION_IDS = ["cmd-1", "cmd-2", "cursor", "codex"];
const LAUNCHER_TARGETS = ["cmd", "powershell", "cursor", "codex"] as const;
const TUNNEL_URL = "https://radio.ascendixgear.com";
const SESSION_POLL_MS = 900;
const HEALTH_POLL_MS = 5000;
const VIEWER_POLL_MS = 900;
const VOLUME_BASELINE = 0.5;
const VOLUME_STEP_THRESHOLD = 0.04;

type RadioTab = "sessions" | "viewer";
type RadioStatus = "idle" | "listening" | "processing" | "executed" | "error";

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
  sessions?: Array<{ id: string }>;
  voice?: {
    status?: string;
  };
  remoteAccess?: {
    status?: string;
  };
};

type DesktopMetricsResponse = {
  screen?: {
    width?: number;
    height?: number;
  };
};

type ViewerSize = {
  width: number;
  height: number;
};

function buildUrl(path: string) {
  return `${TUNNEL_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

async function parseJson<T>(response: Response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    return null;
  }

  return (await response.json()) as T;
}

function mergeSessionIds(sessionIds: string[]) {
  const merged = sessionIds
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  return Array.from(new Set([...DEFAULT_SESSION_IDS, ...merged]));
}

function formatSessionLabel(sessionId: string) {
  const normalized = String(sessionId || "").trim().toLowerCase();
  const labelMap: Record<string, string> = {
    cmd: "CMD",
    codex: "Codex",
    cursor: "Cursor",
    powershell: "PowerShell"
  };

  if (labelMap[normalized]) {
    return labelMap[normalized];
  }

  if (/^(cmd|powershell)-\d+$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return normalized ? normalized.charAt(0).toUpperCase() + normalized.slice(1) : "Unknown";
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

  return cleanedLines.slice(startIndex, endIndex + 1).join("\n").slice(-900).trim();
}

function isTerminalSpeechNoiseLine(line: string) {
  const normalized = line.trim().toLowerCase();
  return (
    !normalized ||
    /^working\b/i.test(line) ||
    /^tip:\s+/i.test(line) ||
    /^microsoft\s+windows\s+\[version/i.test(line) ||
    /^\(c\)\s+microsoft\s+corporation/i.test(line) ||
    /^windows\s+powershell/i.test(line) ||
    /^ps\s+[a-z]:\\/i.test(line) ||
    /^[a-z]:\\.*>/i.test(line) ||
    /^>\s*_?\s*openai codex/i.test(line) ||
    /^model:\s+/i.test(line) ||
    /^directory:\s+/i.test(line) ||
    normalized.includes("esc to interrupt")
  );
}

function isLikelyAssistantResponseLine(line: string) {
  if (isTerminalSpeechNoiseLine(line)) {
    return false;
  }

  return line.length >= 8 && /[a-z]/i.test(line) && (/[.!?]$/.test(line) || /^(the|it|this|that|i|you|ready)\b/i.test(line));
}

function isAssistantContinuationLine(line: string) {
  return line.length >= 4 && /[a-z]/i.test(line) && !isTerminalSpeechNoiseLine(line);
}

function App() {
  const [activeTab, setActiveTab] = useState<RadioTab>("sessions");
  const [status, setStatus] = useState<RadioStatus>("idle");
  const [sessionIds, setSessionIds] = useState<string[]>(DEFAULT_SESSION_IDS);
  const [activeSessionId, setActiveSessionId] = useState(DEFAULT_SESSION_IDS[0]);
  const [sessionStream, setSessionStream] = useState<SessionStreamResponse | null>(null);
  const [terminalInput, setTerminalInput] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [viewerImageUrl, setViewerImageUrl] = useState(buildUrl("/desktop/screenshot?format=jpg"));
  const [viewerSize, setViewerSize] = useState<ViewerSize>({ width: 1, height: 1 });
  const [desktopFrame, setDesktopFrame] = useState({ width: 1920, height: 1080 });
  const [viewerCursor, setViewerCursor] = useState({ x: 0.5, y: 0.5 });
  const [viewerControlEnabled, setViewerControlEnabled] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [lastTranscript, setLastTranscript] = useState("");
  const [healthState, setHealthState] = useState("Connecting");
  const [isSendingInput, setIsSendingInput] = useState(false);

  const recordingRef = useRef<Audio.Recording | null>(null);
  const isRecordingRef = useRef(false);
  const viewerThrottleRef = useRef(0);
  const lastSpokenSignatureRef = useRef("");
  const lastVolumeRef = useRef(VOLUME_BASELINE);
  const resettingVolumeRef = useRef(false);

  const viewerAspect = useMemo(
    () => desktopFrame.width / Math.max(desktopFrame.height, 1),
    [desktopFrame.height, desktopFrame.width]
  );

  useEffect(() => {
    void refreshHealth();
    const intervalId = setInterval(() => {
      void refreshHealth();
    }, HEALTH_POLL_MS);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    void refreshDesktopMetrics();
    const intervalId = setInterval(() => {
      void refreshDesktopMetrics();
    }, 10000);

    return () => clearInterval(intervalId);
  }, []);

  useEffect(() => {
    void refreshSessionOutput(activeSessionId);
    const intervalId = setInterval(() => {
      void refreshSessionOutput(activeSessionId);
    }, SESSION_POLL_MS);

    return () => clearInterval(intervalId);
  }, [activeSessionId]);

  useEffect(() => {
    if (activeTab !== "viewer") {
      return;
    }

    const intervalId = setInterval(() => {
      setViewerImageUrl(buildUrl(`/desktop/screenshot?format=jpg&t=${Date.now()}`));
    }, VIEWER_POLL_MS);

    return () => clearInterval(intervalId);
  }, [activeTab]);

  useEffect(() => {
    if (!ttsEnabled || !sessionStream?.output || sessionStream.isBusy) {
      return;
    }

    const speechText = buildTerminalSpeechText(sessionStream.output);
    const signature = `${activeSessionId}:${speechText}`;
    if (!speechText || lastSpokenSignatureRef.current === signature) {
      return;
    }

    lastSpokenSignatureRef.current = signature;
    Speech.stop();
    Speech.speak(speechText, {
      language: "en-US",
      pitch: 1,
      rate: 0.95
    });
  }, [activeSessionId, sessionStream, ttsEnabled]);

  useEffect(() => {
    let mounted = true;
    let listener: { remove: () => void } | undefined;

    async function setupVolumeButtons() {
      try {
        await VolumeManager.showNativeVolumeUI({ enabled: false });
        await VolumeManager.setVolume(VOLUME_BASELINE);
        const initialVolume = await VolumeManager.getVolume();
        lastVolumeRef.current = initialVolume.volume ?? VOLUME_BASELINE;

        listener = VolumeManager.addVolumeListener(({ volume }) => {
          if (!mounted || typeof volume !== "number") {
            return;
          }

          if (resettingVolumeRef.current) {
            lastVolumeRef.current = volume;
            return;
          }

          const delta = volume - lastVolumeRef.current;
          lastVolumeRef.current = volume;

          if (delta >= VOLUME_STEP_THRESHOLD) {
            void startRecording();
            void resetHardwareVolume();
            return;
          }

          if (delta <= -VOLUME_STEP_THRESHOLD) {
            void stopRecordingAndUpload();
            void resetHardwareVolume();
          }
        });
      } catch {
        // Volume button support is optional at runtime.
      }
    }

    void setupVolumeButtons();

    return () => {
      mounted = false;
      listener?.remove();
      void VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
      Speech.stop();
    };
  }, [activeSessionId]);

  async function resetHardwareVolume() {
    resettingVolumeRef.current = true;
    try {
      await VolumeManager.setVolume(VOLUME_BASELINE);
      lastVolumeRef.current = VOLUME_BASELINE;
    } catch {
      // Ignore reset failures and keep the app functional.
    } finally {
      setTimeout(() => {
        resettingVolumeRef.current = false;
      }, 150);
    }
  }

  async function refreshHealth() {
    try {
      const response = await fetch(buildUrl("/health"), { cache: "no-store" });
      const payload = await parseJson<HealthResponse>(response);
      if (!response.ok || !payload) {
        throw new Error(`Health check failed with ${response.status}.`);
      }

      const nextSessionIds = mergeSessionIds((payload.sessions || []).map((session) => session.id));
      setSessionIds(nextSessionIds);
      if (!nextSessionIds.includes(activeSessionId)) {
        setActiveSessionId(nextSessionIds[0] || DEFAULT_SESSION_IDS[0]);
      }

      setHealthState(
        [payload.status, payload.voice?.status, payload.remoteAccess?.status].filter(Boolean).join(" / ") || "Connected"
      );
    } catch (error) {
      setHealthState(error instanceof Error ? error.message : "Disconnected");
    }
  }

  async function refreshDesktopMetrics() {
    try {
      const response = await fetch(buildUrl("/desktop/metrics"), { cache: "no-store" });
      const payload = await parseJson<DesktopMetricsResponse>(response);
      if (!response.ok || !payload) {
        return;
      }

      setDesktopFrame({
        width: Number(payload.screen?.width) || 1920,
        height: Number(payload.screen?.height) || 1080
      });
    } catch {
      // Keep default desktop metrics.
    }
  }

  async function refreshSessionOutput(sessionId: string) {
    try {
      const response = await fetch(buildUrl(`/sessions/${encodeURIComponent(sessionId)}/output`), {
        cache: "no-store"
      });
      const payload = await parseJson<SessionStreamResponse>(response);
      if (!response.ok || !payload) {
        return;
      }

      setSessionStream(payload);
      if (payload.error) {
        setErrorMessage(payload.error);
      }
    } catch {
      // Silent polling failure.
    }
  }

  async function ensureRecordingPermissions() {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error("Microphone access is required.");
    }
  }

  async function startRecording() {
    if (isRecordingRef.current) {
      return;
    }

    try {
      setErrorMessage("");
      await ensureRecordingPermissions();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true
      });

      const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      recordingRef.current = recording;
      isRecordingRef.current = true;
      setStatus("listening");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to start recording.");
    }
  }

  async function stopRecordingAndUpload() {
    if (!isRecordingRef.current || !recordingRef.current) {
      return;
    }

    setStatus("processing");

    try {
      const recording = recordingRef.current;
      await recording.stopAndUnloadAsync();
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true
      });

      const uri = recording.getURI();
      recordingRef.current = null;
      isRecordingRef.current = false;

      if (!uri) {
        throw new Error("Recording URI missing.");
      }

      const formData = new FormData();
      formData.append("audio", {
        uri,
        name: "remote-command.m4a",
        type: "audio/mp4"
      } as unknown as Blob);
      formData.append("sessionId", activeSessionId);

      const response = await fetch(buildUrl("/voice"), {
        method: "POST",
        body: formData
      });

      const payload = await parseJson<VoiceResponse>(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Voice request failed with ${response.status}.`);
      }

      applyVoicePayload(payload);
      setStatus("executed");
      await refreshSessionOutput(payload?.sessionId || activeSessionId);
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to upload recording.");
    }
  }

  function applyVoicePayload(payload: VoiceResponse | null) {
    if (!payload) {
      return;
    }

    if (payload.sessionId) {
      setActiveSessionId(payload.sessionId);
      setSessionIds((currentValue) => mergeSessionIds([payload.sessionId || "", ...currentValue]));
    }

    if (payload.transcript) {
      setLastTranscript(payload.transcript);
    }

    if (payload.error) {
      setErrorMessage(payload.error);
    } else {
      setErrorMessage("");
    }
  }

  async function sendLauncherCommand(target: (typeof LAUNCHER_TARGETS)[number]) {
    setStatus("processing");
    try {
      const response = await fetch(buildUrl("/voice"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          transcript: `open ${target}`
        })
      });
      const payload = await parseJson<VoiceResponse>(response);
      if (!response.ok) {
        throw new Error(payload?.error || `Open request failed with ${response.status}.`);
      }

      applyVoicePayload(payload);
      setStatus("executed");
      setActiveTab("sessions");
    } catch (error) {
      setStatus("error");
      setErrorMessage(error instanceof Error ? error.message : "Unable to launch session.");
    }
  }

  async function sendTerminalText() {
    if (!terminalInput.trim()) {
      return;
    }

    setIsSendingInput(true);
    try {
      const response = await fetch(buildUrl(`/sessions/${encodeURIComponent(activeSessionId)}/input`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: terminalInput.trim()
        })
      });
      const payload = await parseJson<SessionStreamResponse>(response);
      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal input failed with ${response.status}.`);
      }

      setSessionStream(payload);
      setTerminalInput("");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to send terminal input.");
    } finally {
      setIsSendingInput(false);
    }
  }

  async function sendTerminalKey(key: string) {
    setIsSendingInput(true);
    try {
      const response = await fetch(buildUrl(`/sessions/${encodeURIComponent(activeSessionId)}/input`), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          key
        })
      });
      const payload = await parseJson<SessionStreamResponse>(response);
      if (!response.ok || payload?.status === "error") {
        throw new Error(payload?.error || `Terminal key failed with ${response.status}.`);
      }

      setSessionStream(payload);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Unable to send terminal key.");
    } finally {
      setIsSendingInput(false);
    }
  }

  async function sendViewerPointer(ratioX: number, ratioY: number, click = false) {
    if (!viewerControlEnabled) {
      return;
    }

    const now = Date.now();
    if (!click && now - viewerThrottleRef.current < 120) {
      return;
    }
    viewerThrottleRef.current = now;

    const clampedX = Math.max(0, Math.min(ratioX, 1));
    const clampedY = Math.max(0, Math.min(ratioY, 1));

    setViewerCursor({
      x: clampedX,
      y: clampedY
    });

    try {
      await fetch(buildUrl("/desktop/input"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          x: Math.round(clampedX * desktopFrame.width),
          y: Math.round(clampedY * desktopFrame.height),
          click
        })
      });
    } catch {
      // Ignore viewer input transport failures to keep the UI responsive.
    }
  }

  function onViewerLayout(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setViewerSize({
      width: Math.max(width, 1),
      height: Math.max(height, 1)
    });
  }

  function onViewerPress(event: GestureResponderEvent) {
    const ratioX = event.nativeEvent.locationX / viewerSize.width;
    const ratioY = event.nativeEvent.locationY / viewerSize.height;
    void sendViewerPointer(ratioX, ratioY, true);
  }

  function onViewerMove(event: GestureResponderEvent) {
    const ratioX = event.nativeEvent.locationX / viewerSize.width;
    const ratioY = event.nativeEvent.locationY / viewerSize.height;
    void sendViewerPointer(ratioX, ratioY, false);
  }

  function confirmTunnelPlaceholder() {
    if (!TUNNEL_URL.includes("your-tunnel.trycloudflare.com")) {
      return true;
    }

    Alert.alert("Set your tunnel URL", "Replace EXPO_PUBLIC_TUNNEL_URL before using the app.");
    return false;
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={[styles.safeArea, status === "listening" ? styles.safeAreaListening : null]}>
        <StatusBar style="light" />
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>Remote Coder</Text>
            <Text style={styles.title}>{formatSessionLabel(activeSessionId)}</Text>
          </View>
          <View style={styles.headerRight}>
            <Text style={styles.headerStatus}>{healthState}</Text>
            <Pressable style={styles.headerButton} onPress={() => setTtsEnabled((value) => !value)}>
              <Text style={styles.headerButtonText}>{ttsEnabled ? "Speech on" : "Speech off"}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.tabRow}>
          <Pressable
            style={[styles.tabButton, activeTab === "sessions" ? styles.tabButtonActive : null]}
            onPress={() => setActiveTab("sessions")}
          >
            <Text style={[styles.tabText, activeTab === "sessions" ? styles.tabTextActive : null]}>Terminals</Text>
          </Pressable>
          <Pressable
            style={[styles.tabButton, activeTab === "viewer" ? styles.tabButtonActive : null]}
            onPress={() => setActiveTab("viewer")}
          >
            <Text style={[styles.tabText, activeTab === "viewer" ? styles.tabTextActive : null]}>Viewer</Text>
          </Pressable>
        </View>

        {activeTab === "sessions" ? (
          <>
            <ScrollView contentContainerStyle={styles.content}>
              <View style={styles.sessionGrid}>
                {sessionIds.slice(0, 6).map((sessionId) => (
                  <Pressable
                    key={sessionId}
                    style={[styles.sessionCard, activeSessionId === sessionId ? styles.sessionCardActive : null]}
                    onPress={() => setActiveSessionId(sessionId)}
                  >
                    <Text style={styles.sessionCardText}>{formatSessionLabel(sessionId)}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.launcherRow}>
                {LAUNCHER_TARGETS.map((target) => (
                  <Pressable
                    key={target}
                    style={styles.launchButton}
                    onPress={() => {
                      if (!confirmTunnelPlaceholder()) {
                        return;
                      }
                      void sendLauncherCommand(target);
                    }}
                  >
                    <Text style={styles.launchButtonText}>Open {formatSessionLabel(target)}</Text>
                  </Pressable>
                ))}
              </View>

              <View style={styles.outputPanel}>
                <Text style={styles.outputTitle}>Live stdout</Text>
                <ScrollView style={styles.outputScroll}>
                  <Text style={styles.outputText}>
                    {sessionStream?.outputAvailable === false
                      ? sessionStream.message || sessionStream.error || "Live stdout is not available for this session."
                      : sessionStream?.output || "Waiting for terminal output..."}
                  </Text>
                </ScrollView>
              </View>

              <View style={styles.keyboardPanel}>
                <TextInput
                  style={styles.input}
                  placeholder="Type into the active terminal"
                  placeholderTextColor="#8090a5"
                  value={terminalInput}
                  onChangeText={setTerminalInput}
                  autoCapitalize="none"
                  autoCorrect={false}
                  onSubmitEditing={() => void sendTerminalText()}
                />
                <View style={styles.keyRow}>
                  <Pressable style={styles.keyButton} onPress={() => void sendTerminalText()}>
                    <Text style={styles.keyButtonText}>{isSendingInput ? "Sending..." : "Send"}</Text>
                  </Pressable>
                  <Pressable style={styles.keyButtonMuted} onPress={() => void sendTerminalKey("enter")}>
                    <Text style={styles.keyButtonMutedText}>Enter</Text>
                  </Pressable>
                  <Pressable style={styles.keyButtonMuted} onPress={() => void sendTerminalKey("ctrl+c")}>
                    <Text style={styles.keyButtonMutedText}>Ctrl+C</Text>
                  </Pressable>
                </View>
              </View>

              <View style={styles.metaPanel}>
                <Text style={styles.metaLabel}>Last transcript</Text>
                <Text style={styles.metaValue}>{lastTranscript || "No voice command yet."}</Text>
              </View>

              {errorMessage ? (
                <View style={styles.errorBanner}>
                  <Text style={styles.errorText}>{errorMessage}</Text>
                </View>
              ) : null}
            </ScrollView>

            <Pressable
              style={[styles.talkButton, status === "listening" ? styles.talkButtonActive : null]}
              onPressIn={() => {
                if (!confirmTunnelPlaceholder()) {
                  return;
                }
                void startRecording();
              }}
              onPressOut={() => {
                void stopRecordingAndUpload();
              }}
            >
              {status === "processing" ? (
                <ActivityIndicator color="#06101a" />
              ) : (
                <Text style={styles.talkButtonText}>
                  {status === "listening" ? "Release to send" : "Hold to talk"}
                </Text>
              )}
            </Pressable>
          </>
        ) : (
          <View style={styles.viewerShell}>
            <View style={styles.viewerToolbar}>
              <Text style={styles.viewerHint}>Tap to click. Drag to move. Volume up starts recording, volume down sends.</Text>
              <Pressable style={styles.headerButton} onPress={() => setViewerControlEnabled((value) => !value)}>
                <Text style={styles.headerButtonText}>{viewerControlEnabled ? "Control on" : "View only"}</Text>
              </Pressable>
            </View>

            <Pressable
              style={styles.viewerFrame}
              onLayout={onViewerLayout}
              onPress={onViewerPress}
              onResponderMove={onViewerMove}
              onMoveShouldSetResponder={() => true}
            >
              <Image
                source={{ uri: viewerImageUrl }}
                resizeMode="contain"
                style={[
                  styles.viewerImage,
                  {
                    aspectRatio: viewerAspect
                  }
                ]}
              />
              <View
                style={[
                  styles.viewerCursor,
                  {
                    left: `${viewerCursor.x * 100}%`,
                    top: `${viewerCursor.y * 100}%`
                  }
                ]}
              />
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

export default App;

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: "#05070d"
  },
  safeAreaListening: {
    backgroundColor: "#15080d"
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingHorizontal: 18,
    paddingTop: 14,
    paddingBottom: 10
  },
  eyebrow: {
    color: "#7f91a8",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1.6,
    textTransform: "uppercase"
  },
  title: {
    color: "#f4f7fb",
    fontSize: 28,
    fontWeight: "800",
    marginTop: 6
  },
  headerRight: {
    alignItems: "flex-end",
    gap: 10
  },
  headerStatus: {
    color: "#b9c4d2",
    fontSize: 12,
    maxWidth: 180,
    textAlign: "right"
  },
  headerButton: {
    backgroundColor: "rgba(255,255,255,0.1)",
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 9
  },
  headerButtonText: {
    color: "#f4f7fb",
    fontSize: 12,
    fontWeight: "700"
  },
  tabRow: {
    flexDirection: "row",
    marginHorizontal: 18,
    marginBottom: 12,
    backgroundColor: "#0d1522",
    borderRadius: 999,
    padding: 6
  },
  tabButton: {
    flex: 1,
    borderRadius: 999,
    paddingVertical: 12,
    alignItems: "center"
  },
  tabButtonActive: {
    backgroundColor: "#f4f7fb"
  },
  tabText: {
    color: "#95a4b8",
    fontWeight: "800"
  },
  tabTextActive: {
    color: "#07111a"
  },
  content: {
    paddingHorizontal: 18,
    paddingBottom: 140,
    gap: 16
  },
  sessionGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12
  },
  sessionCard: {
    width: "47%",
    minHeight: 96,
    backgroundColor: "#f4f7fb",
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    padding: 14
  },
  sessionCardActive: {
    backgroundColor: "#dbe6f6"
  },
  sessionCardText: {
    color: "#08101b",
    fontSize: 18,
    fontWeight: "800"
  },
  launcherRow: {
    gap: 10
  },
  launchButton: {
    backgroundColor: "#101827",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)"
  },
  launchButtonText: {
    color: "#f4f7fb",
    fontWeight: "700"
  },
  outputPanel: {
    backgroundColor: "#0b1220",
    borderRadius: 20,
    padding: 16,
    minHeight: 220
  },
  outputTitle: {
    color: "#f4f7fb",
    fontWeight: "800",
    marginBottom: 12
  },
  outputScroll: {
    maxHeight: 260
  },
  outputText: {
    color: "#dbe6f6",
    lineHeight: 22
  },
  keyboardPanel: {
    backgroundColor: "#0b1220",
    borderRadius: 20,
    padding: 16,
    gap: 12
  },
  input: {
    minHeight: 52,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    color: "#f4f7fb",
    paddingHorizontal: 14
  },
  keyRow: {
    flexDirection: "row",
    gap: 10
  },
  keyButton: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: "#f4f7fb",
    paddingVertical: 14,
    alignItems: "center"
  },
  keyButtonText: {
    color: "#08101b",
    fontWeight: "800"
  },
  keyButtonMuted: {
    flex: 1,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    paddingVertical: 14,
    alignItems: "center"
  },
  keyButtonMutedText: {
    color: "#f4f7fb",
    fontWeight: "800"
  },
  metaPanel: {
    backgroundColor: "#0b1220",
    borderRadius: 20,
    padding: 16
  },
  metaLabel: {
    color: "#7f91a8",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 8
  },
  metaValue: {
    color: "#f4f7fb",
    lineHeight: 22
  },
  errorBanner: {
    backgroundColor: "#2a1117",
    borderRadius: 16,
    padding: 14
  },
  errorText: {
    color: "#ffb8c1"
  },
  talkButton: {
    position: "absolute",
    right: 18,
    bottom: 24,
    left: 18,
    minHeight: 62,
    backgroundColor: "#f4f7fb",
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.26,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12
  },
  talkButtonActive: {
    backgroundColor: "#ff7979"
  },
  talkButtonText: {
    color: "#08101b",
    fontSize: 16,
    fontWeight: "900"
  },
  viewerShell: {
    flex: 1,
    paddingHorizontal: 18,
    paddingBottom: 18
  },
  viewerToolbar: {
    gap: 12,
    marginBottom: 12
  },
  viewerHint: {
    color: "#b9c4d2",
    lineHeight: 20
  },
  viewerFrame: {
    flex: 1,
    borderRadius: 22,
    backgroundColor: "#0b1220",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center"
  },
  viewerImage: {
    width: "100%",
    height: "100%"
  },
  viewerCursor: {
    position: "absolute",
    width: 18,
    height: 18,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#ffffff",
    marginLeft: -9,
    marginTop: -9
  }
});
