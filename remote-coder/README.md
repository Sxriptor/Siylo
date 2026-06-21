# Remote Coder

Native iPhone controller for the existing Siylo remote stack.

This app does not replace the website or the PC agent. It reuses the same Cloudflare Tunnel URL and the same backend routes already exposed by the desktop app:

- `/health`
- `/voice`
- `/sessions/:id/output`
- `/sessions/:id/input`
- `/desktop/metrics`
- `/desktop/screenshot`
- `/desktop/input`

## Install

```bash
cd remote-coder
npm install
npx expo install expo-dev-client expo-speech expo-av
npm install react-native-volume-manager
```

The app is currently hardcoded to:

```text
https://radio.ascendixgear.com
```

## Run

```bash
npx expo start --dev-client
```

## iOS custom dev build

```bash
eas build --profile development --platform ios
```

## Behavior

- Website stays unchanged.
- Native app talks to the same PC-side Siylo backend over the tunnel.
- Volume up starts recording.
- Volume down stops recording and sends audio to `/voice`.
- Hold the on-screen talk button for push-to-talk if you do not want to use hardware volume keys.
- Terminal output is spoken locally with `expo-speech`.

## Notes

- `react-native-volume-manager` requires a custom dev build; Expo Go is not enough.
- The package currently expects iOS 16.4+.
- Hardware volume behavior must be tested on a physical device.
