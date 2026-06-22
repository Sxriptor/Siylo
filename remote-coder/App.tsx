import { requestRecordingPermissionsAsync } from "expo-audio";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { VolumeManager } from "react-native-volume-manager";
import WebView from "react-native-webview";
import type { WebViewMessageEvent, WebViewNavigation, WebViewProps } from "react-native-webview";

const RADIO_URL = "https://radio.ascendixgear.com/radio";
const VOLUME_BASELINE = 0.5;
const VOLUME_STEP_THRESHOLD = 0.04;
const VOLUME_RESET_TOLERANCE = 0.015;
type NativeVolumeAction = "volume-up-start" | "volume-up-stop" | "volume-down";
const RadioWebView = WebView as unknown as React.ComponentType<
  WebViewProps & { ref?: React.Ref<WebView> }
>;

const WEB_REMOTE_BRIDGE = `
(function () {
  if (window.__siyloNativeBridgeInstalled) {
    true;
    return;
  }

  window.__siyloNativeBridgeInstalled = true;
  window.__siyloNativePointerId = 989001;
  window.__siyloNativeFallbackHolding = false;

  function getTarget() {
    return document.querySelector("main") || document.body || document.documentElement;
  }

  function dispatchPressEvent(type) {
    var target = getTarget();
    if (!target) {
      return;
    }

    var rect = target.getBoundingClientRect ? target.getBoundingClientRect() : null;
    var x = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    var y = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    var common = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pointerId: window.__siyloNativePointerId,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1
    };

    try {
      target.dispatchEvent(new PointerEvent(type, common));
    } catch (error) {
      var mouseType = type === "pointerdown" ? "mousedown" : "mouseup";
      target.dispatchEvent(new MouseEvent(mouseType, common));
    }
  }

  window.__siyloNativePressToTalk = function (action) {
    if (action === "start") {
      dispatchPressEvent("pointerdown");
      return;
    }

    if (action === "stop") {
      dispatchPressEvent("pointerup");
    }
  };

  window.__siyloNativeFallbackVolumeAction = function (action) {
    if (action === "volume-up-start") {
      window.__siyloNativeFallbackHolding = true;
      window.__siyloNativePressToTalk("start");
      return;
    }

    if (action === "volume-up-stop") {
      window.__siyloNativeFallbackHolding = false;
      window.__siyloNativePressToTalk("stop");
      return;
    }

    if (action !== "volume-up") {
      return;
    }

    window.__siyloNativeFallbackHolding = !window.__siyloNativeFallbackHolding;
    window.__siyloNativePressToTalk(window.__siyloNativeFallbackHolding ? "start" : "stop");
  };

  function notifyNativeInteraction() {
    if (!window.ReactNativeWebView) {
      return;
    }

    window.ReactNativeWebView.postMessage(JSON.stringify({ type: "siylo-webview-interaction" }));
  }

  document.addEventListener("pointerdown", notifyNativeInteraction, { capture: true, passive: true });
  document.addEventListener("touchstart", notifyNativeInteraction, { capture: true, passive: true });

  true;
})();
`;

function App() {
  const webViewRef = useRef<WebView>(null);
  const lastVolumeRef = useRef(VOLUME_BASELINE);
  const ignoreNextBaselineVolumeRef = useRef(false);
  const resetFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reactivateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isHoldingVolumeTalkRef = useRef(false);
  const [currentUrl, setCurrentUrl] = useState(RADIO_URL);

  useEffect(() => {
    void requestRecordingPermissionsAsync().catch(() => {});
  }, []);

  useEffect(() => {
    let mounted = true;
    let listener: { remove: () => void } | undefined;

    async function setupVolumeButtons() {
      try {
        await keepVolumeCaptureActive();
        const initialVolume = await VolumeManager.getVolume();
        lastVolumeRef.current = initialVolume.volume ?? VOLUME_BASELINE;

        listener = VolumeManager.addVolumeListener(({ volume }) => {
          if (!mounted || typeof volume !== "number") {
            return;
          }

          if (
            ignoreNextBaselineVolumeRef.current &&
            Math.abs(volume - VOLUME_BASELINE) <= VOLUME_RESET_TOLERANCE
          ) {
            ignoreNextBaselineVolumeRef.current = false;
            lastVolumeRef.current = volume;
            return;
          }

          const delta = volume - lastVolumeRef.current;
          lastVolumeRef.current = volume;

          if (delta >= VOLUME_STEP_THRESHOLD) {
            isHoldingVolumeTalkRef.current = !isHoldingVolumeTalkRef.current;
            sendVolumeAction(isHoldingVolumeTalkRef.current ? "volume-up-start" : "volume-up-stop");
            void resetHardwareVolume();
            return;
          }

          if (delta <= -VOLUME_STEP_THRESHOLD) {
            isHoldingVolumeTalkRef.current = false;
            sendVolumeAction("volume-down");
            void resetHardwareVolume();
          }
        });
      } catch {
        // Hardware volume capture is best-effort. The web remote still works by touch.
      }
    }

    void setupVolumeButtons();

    return () => {
      mounted = false;
      listener?.remove();
      if (resetFallbackTimerRef.current) {
        clearTimeout(resetFallbackTimerRef.current);
      }
      if (reactivateTimerRef.current) {
        clearTimeout(reactivateTimerRef.current);
      }
      void VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        scheduleVolumeCaptureRefresh();
      }
    });

    return () => {
      subscription.remove();
    };
  }, []);

  async function keepVolumeCaptureActive() {
    try {
      await VolumeManager.enable(true, true);
      await VolumeManager.setCategory("PlayAndRecord", true);
      await VolumeManager.setMode("Default");
      await VolumeManager.enableInSilenceMode(true);
      await VolumeManager.setActive(true, true);
      await VolumeManager.showNativeVolumeUI({ enabled: false });
      await VolumeManager.setVolume(VOLUME_BASELINE, { showUI: false, playSound: false });
      lastVolumeRef.current = VOLUME_BASELINE;
    } catch {
      // The WebView remains usable even if iOS refuses an audio-session refresh.
    }
  }

  function scheduleVolumeCaptureRefresh() {
    if (reactivateTimerRef.current) {
      clearTimeout(reactivateTimerRef.current);
    }

    reactivateTimerRef.current = setTimeout(() => {
      reactivateTimerRef.current = null;
      void keepVolumeCaptureActive();
    }, 60);
  }

  async function resetHardwareVolume() {
    ignoreNextBaselineVolumeRef.current = true;
    if (resetFallbackTimerRef.current) {
      clearTimeout(resetFallbackTimerRef.current);
    }
    try {
      await VolumeManager.setActive(true, true);
      await VolumeManager.showNativeVolumeUI({ enabled: false });
      await VolumeManager.setVolume(VOLUME_BASELINE, { showUI: false, playSound: false });
      lastVolumeRef.current = VOLUME_BASELINE;
    } catch {
      // Keep the remote usable if the OS denies volume reset.
    } finally {
      resetFallbackTimerRef.current = setTimeout(() => {
        ignoreNextBaselineVolumeRef.current = false;
      }, 500);
    }
  }

  function sendVolumeAction(action: NativeVolumeAction) {
    webViewRef.current?.injectJavaScript(`
      var siyloNativeVolumeEvent = new CustomEvent("siylo-native-volume-action", {
        cancelable: true,
        detail: { action: ${JSON.stringify(action)} }
      });
      window.dispatchEvent(siyloNativeVolumeEvent);
      if (!siyloNativeVolumeEvent.defaultPrevented && window.__siyloNativeVolumeAction) {
        window.__siyloNativeVolumeAction(${JSON.stringify(action)});
      } else if (!siyloNativeVolumeEvent.defaultPrevented && window.__siyloNativeFallbackVolumeAction) {
        window.__siyloNativeFallbackVolumeAction(${JSON.stringify(action)});
      }
      true;
    `);
  }

  function onNavigationStateChange(event: WebViewNavigation) {
    setCurrentUrl(event.url || RADIO_URL);
  }

  function onWebViewMessage(event: WebViewMessageEvent) {
    try {
      const payload = JSON.parse(event.nativeEvent.data) as { type?: string };
      if (payload.type === "siylo-webview-interaction") {
        scheduleVolumeCaptureRefresh();
      }
    } catch {
      // Ignore messages not sent by our injected bridge.
    }
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <RadioWebView
          ref={webViewRef}
          source={{ uri: RADIO_URL }}
          style={styles.webView}
          containerStyle={styles.webViewContainer}
          originWhitelist={["https://*", "http://*"]}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          mediaCapturePermissionGrantType="grantIfSameHostElsePrompt"
          injectedJavaScript={WEB_REMOTE_BRIDGE}
          injectedJavaScriptBeforeContentLoaded={WEB_REMOTE_BRIDGE}
          onNavigationStateChange={onNavigationStateChange}
          onMessage={onWebViewMessage}
          onLoadEnd={() => {
            webViewRef.current?.injectJavaScript(WEB_REMOTE_BRIDGE);
            scheduleVolumeCaptureRefresh();
          }}
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingShell}>
              <ActivityIndicator color="#f4f7fb" />
              <Text style={styles.loadingText}>Opening radio.ascendixgear.com/radio</Text>
            </View>
          )}
          renderError={() => (
            <View style={styles.loadingShell}>
              <Text style={styles.errorTitle}>Unable to load radio</Text>
              <Text style={styles.loadingText}>{currentUrl || RADIO_URL}</Text>
            </View>
          )}
        />
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
  webViewContainer: {
    flex: 1,
    backgroundColor: "#05070d"
  },
  webView: {
    flex: 1,
    backgroundColor: "#05070d"
  },
  loadingShell: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    padding: 24,
    backgroundColor: "#05070d"
  },
  loadingText: {
    color: "rgba(244,247,251,0.72)",
    textAlign: "center",
    lineHeight: 20
  },
  errorTitle: {
    color: "#f4f7fb",
    fontSize: 18,
    fontWeight: "900"
  }
});
