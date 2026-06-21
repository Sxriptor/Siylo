import { requestRecordingPermissionsAsync } from "expo-audio";
import { StatusBar } from "expo-status-bar";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { VolumeManager } from "react-native-volume-manager";
import WebView from "react-native-webview";
import type { WebViewNavigation, WebViewProps } from "react-native-webview";

const RADIO_URL = "https://radio.ascendixgear.com/radio";
const VOLUME_BASELINE = 0.5;
const VOLUME_STEP_THRESHOLD = 0.04;
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
    if (action !== "volume-up") {
      return;
    }

    window.__siyloNativeFallbackHolding = !window.__siyloNativeFallbackHolding;
    window.__siyloNativePressToTalk(window.__siyloNativeFallbackHolding ? "start" : "stop");
  };

  true;
})();
`;

function App() {
  const webViewRef = useRef<WebView>(null);
  const lastVolumeRef = useRef(VOLUME_BASELINE);
  const resettingVolumeRef = useRef(false);
  const [currentUrl, setCurrentUrl] = useState(RADIO_URL);

  useEffect(() => {
    void requestRecordingPermissionsAsync().catch(() => {});
  }, []);

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
            sendVolumeAction("volume-up");
            void resetHardwareVolume();
            return;
          }

          if (delta <= -VOLUME_STEP_THRESHOLD) {
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
      void VolumeManager.showNativeVolumeUI({ enabled: true }).catch(() => {});
    };
  }, []);

  async function resetHardwareVolume() {
    resettingVolumeRef.current = true;
    try {
      await VolumeManager.setVolume(VOLUME_BASELINE);
      lastVolumeRef.current = VOLUME_BASELINE;
    } catch {
      // Keep the remote usable if the OS denies volume reset.
    } finally {
      setTimeout(() => {
        resettingVolumeRef.current = false;
      }, 150);
    }
  }

  function sendVolumeAction(action: "volume-up" | "volume-down") {
    webViewRef.current?.injectJavaScript(`
      if (window.__siyloNativeVolumeAction) {
        window.__siyloNativeVolumeAction(${JSON.stringify(action)});
      } else if (window.__siyloNativeFallbackVolumeAction) {
        window.__siyloNativeFallbackVolumeAction(${JSON.stringify(action)});
      }
      true;
    `);
  }

  function onNavigationStateChange(event: WebViewNavigation) {
    setCurrentUrl(event.url || RADIO_URL);
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
          onLoadEnd={() => {
            webViewRef.current?.injectJavaScript(WEB_REMOTE_BRIDGE);
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
