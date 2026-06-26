# Siylo

Siylo is a local Windows automation agent with a bundled radio web UI, a terminal control surface, and a Discord bot bridge for controlling a local machine.

The current build focuses on a small working surface:

- connect and disconnect a Discord bot
- store a bot token and authorized Discord user IDs locally
- create and track managed `cmd` and `powershell` sessions
- send quoted commands to those managed sessions
- bring a managed session window to the foreground
- kill one managed session or all managed sessions
- capture and return a desktop screenshot
- launch a few mapped apps such as `cursor` and `vscode`
- inspect recent runtime logs from Discord
- expose the bundled radio remote surface through a named Cloudflare Tunnel
- support the companion mobile app over that same tunnel URL
- configure the local runtime from a terminal dashboard with `siylo`

## Stack

- Node.js for the local agent runtime
- Next.js 15 and React 19 for the dashboard UI
- `discord.js` for bot connectivity
- `screenshot-desktop` for screenshot capture

## Current Architecture

The app now has two primary parts:

1. Local agent runtime in [src/main/runtime.js](/C:/Users/coler/Desktop/Backup/development/Siylo/src/main/runtime.js)
2. Bundled radio UI in [src/components/radio-shell.tsx](/C:/Users/coler/Desktop/Backup/development/Siylo/src/components/radio-shell.tsx)

The local runtime owns the real machine-facing behavior:

- terminal control surface
- Discord connection lifecycle
- local config persistence
- managed terminal sessions
- radio HTTP surface and local APIs

The CLI entrypoint lives in [src/cli/index.js](/C:/Users/coler/Desktop/Backup/development/Siylo/src/cli/index.js) and is intended to be the main user-facing control surface.

## Platform Assumptions

This implementation is currently Windows-oriented.

- managed sessions use PowerShell automation and `WScript.Shell`
- shell launching assumes `cmd.exe` and `powershell.exe`
- app launching uses Windows `start`

Running the UI in a browser works cross-platform as a preview, but the desktop automation features are implemented for Windows.

## Local Development

Install dependencies:

```bash
npm install
```

Open the terminal control dashboard:

```bash
npm run start:cli
```

Initialize or update config interactively:

```bash
npm run init:cli
```

Build the bundled radio UI:

```bash
npm run build
```

Run the agent headlessly:

```bash
node src/cli/index.js start
```

Type-check the project:

```bash
npm run typecheck
```

## Remote Access And Mobile App

Siylo now supports a remote radio surface that stays local on the PC and is meant to be published only through a named Cloudflare Tunnel with Cloudflare Access in front of it.

Supported path:

1. Run the desktop app on the Windows machine.
2. Enable remote access in the dashboard so the local radio surface is served from `http://localhost:3443/radio`.
3. Put a named Cloudflare Tunnel in front of that local origin.
4. Protect the public hostname with Cloudflare Access.
5. Use either the browser radio UI or the companion mobile app against that same tunnel hostname.

The mobile app lives in [remote-coder/README.md](/C:/Users/coler/Desktop/Backup/development/Siylo/remote-coder/README.md). It does not replace the desktop app. It talks to the same PC-side Siylo backend through the Cloudflare Tunnel URL and reuses the existing remote routes.

For the full tunnel setup, see [docs/remote-access-tunnel.md](/C:/Users/coler/Desktop/Backup/development/Siylo/docs/remote-access-tunnel.md).

## Configuration

Siylo stores config in Electron `userData` as `siylo.config.json`.

Tracked settings:

- `botToken`
- `authorizedUsers`
- `dashboardPort`
- `autoConnect`
- `commandPrefix`

The dashboard currently allows editing the bot token and authorized Discord user IDs. `dashboardPort` and `commandPrefix` exist in state, but the UI does not yet expose full editing controls for them.

## Tray Behavior

When the app starts, Electron creates:

- a hidden main window
- a tray icon
- a tray menu with `Start`, `Stop`, `Settings`, `Open Dashboard`, and `Quit`

In development, the window is shown automatically once the renderer is ready. In normal use, the app is intended to stay in the tray until opened.

## Discord Command Handling

Commands are accepted from:

- DMs to the bot
- messages that mention the bot user
- messages that mention one of the bot's roles
- messages that start with the configured prefix, which defaults to `@siylo`

Only Discord user IDs listed in `authorizedUsers` are allowed to execute commands.

## Supported Commands

Implemented command set in [src/main/discord-service.js](/C:/Users/coler/Desktop/Backup/development/Siylo/src/main/discord-service.js):

- `list`
- `logs`
- `screenshot`
- `restart`
- `open cmd`
- `open powershell`
- `open cursor`
- `open vscode`
- `open kiro`
- `open browser`
- `kill all`
- `kill <session-id>`
- `<session-id> front`
- `<session-id> k <key>`
- `<session-id> t <raw text>`
- `<session-id> "your command here"`

Examples:

```text
@siylo open cmd
@siylo cmd-1 "npm run dev"
@siylo cmd-1 t git commit -m "fixed changes"
@siylo cmd-1 k q
@siylo cmd-1 k enter
@siylo cmd-1 front
@siylo list
@siylo screenshot
```

The `t` format forwards everything after `t ` as raw text, including embedded quotes, and always presses Enter after typing it.

## Managed Sessions

Managed sessions are implemented in [src/main/session-manager.js](/C:/Users/coler/Desktop/Backup/development/Siylo/src/main/session-manager.js).

Current behavior:

- only `cmd` and `powershell` are treated as managed sessions
- sessions are assigned IDs like `cmd-1` and `powershell-1`
- the app tracks session metadata in memory
- commands are sent by bringing the terminal window forward and using simulated keystrokes

This means Siylo is not attaching to a PTY or streaming terminal output back to Discord. It automates visible shell windows on the local machine.

## Logging and State

Runtime state is held in [src/main/state.js](/C:/Users/coler/Desktop/Backup/development/Siylo/src/main/state.js).

The app keeps:

- Discord connection status
- current config snapshot
- up to 10 recent sessions
- up to 100 recent log entries

`logs` in Discord returns the most recent entries from this in-memory log buffer.

## Browser Preview vs Electron Runtime

Opening the Next.js app directly in a browser shows the dashboard with fallback sample data. Live controls only work when the page is loaded inside Electron with the preload bridge available.

The `Create session` button in the dashboard currently uses a simulated session path for UI feedback. Real managed session creation is implemented through Discord commands.

## Current Limitations

- no packaging or installer flow yet
- no database; config and runtime state are local only
- no terminal output capture or live command streaming
- no file browser or remote file editing
- no granular permission model beyond authorized Discord IDs
- no tests are included yet

## Repo Layout

- [src/app](/C:/Users/coler/Desktop/Backup/development/Siylo/src/app) contains the Next.js app shell
- [src/components](/C:/Users/coler/Desktop/Backup/development/Siylo/src/components) contains the dashboard UI
- [src/main](/C:/Users/coler/Desktop/Backup/development/Siylo/src/main) contains Electron, Discord, state, and session logic
- [scripts](/C:/Users/coler/Desktop/Backup/development/Siylo/scripts) contains dev/start launch scripts

## Status

This repo is currently an early local-first prototype. The implemented path is strongest around tray control, Discord connectivity, Windows shell automation, screenshots, and a small dashboard for local configuration.
