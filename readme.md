# Siylo

Siylo is a local-first remote computer control platform built around a Windows desktop agent, a secure Cloudflare Tunnel web interface, and a companion mobile app.

The desktop app runs in the system tray and manages terminal sessions, screenshots, application launching, and remote control of the local machine. Remote access is provided through a Cloudflare Tunnel, allowing the browser dashboard and mobile app to securely connect to the PC from anywhere.

Discord integration is also available as an optional control surface for users who want to manage their machine through bot commands.

The current build focuses on a small working surface:

* connect to a local Windows machine through a secure Cloudflare Tunnel
* access the remote dashboard from any browser
* control the machine through the companion mobile app
* optionally connect and disconnect a Discord bot
* store bot tokens and authorized Discord user IDs locally
* create and track managed `cmd` and `powershell` sessions
* send quoted commands to managed sessions
* bring a managed session window to the foreground
* kill one managed session or all managed sessions
* capture and return desktop screenshots
* launch mapped applications such as Cursor and VS Code
* inspect recent runtime logs
* expose the remote radio interface through a named Cloudflare Tunnel

## Stack

* Electron for the desktop shell and tray integration
* Next.js 15 and React 19 for the dashboard UI
* Cloudflare Tunnel for secure remote connectivity
* Expo React Native for the companion mobile app
* `discord.js` for optional Discord integration
* `screenshot-desktop` for screenshot capture

## Current Architecture

Siylo consists of three primary components:

### 1. Desktop Agent

Electron desktop application running on the Windows machine.

Responsible for:

* tray integration
* local configuration
* terminal session management
* application launching
* screenshot capture
* remote command execution
* IPC bridge exposed through `src/main/preload.js`

### 2. Remote Dashboard

Next.js dashboard used locally or remotely through Cloudflare Tunnel.

Responsible for:

* machine status
* session management
* configuration
* logs
* remote controls
* mobile-friendly browser interface

### 3. Companion Mobile App

Expo-based iOS and Android app that connects to the same Siylo backend through Cloudflare Tunnel.

The mobile app does not replace the desktop agent. It acts as a portable remote control surface that communicates with the PC through the same remote APIs used by the web dashboard.

### Optional: Discord Bridge

Discord remains supported as an additional control interface.

Users can issue commands through Discord DMs, mentions, or configured prefixes while continuing to use the dashboard and mobile app as primary control surfaces.

## Platform Assumptions

This implementation is currently Windows-oriented.

* managed sessions use PowerShell automation and `WScript.Shell`
* shell launching assumes `cmd.exe` and `powershell.exe`
* app launching uses Windows `start`

The dashboard and mobile app work cross-platform, but machine automation features currently target Windows.

## Local Development

Install dependencies:

```bash
npm install
```

Run the Next.js renderer and Electron together:

```bash
npm run dev
```

Build the renderer:

```bash
npm run build
```

Start Electron against the built renderer:

```bash
npm start
```

Type-check the project:

```bash
npm run typecheck
```

## Remote Access

Remote access is the primary Siylo workflow.

The desktop app hosts local services that are published securely through Cloudflare Tunnel.

Typical setup:

1. Install and run Siylo on the Windows machine.
2. Enable remote access in the dashboard.
3. Configure a named Cloudflare Tunnel.
4. Protect the public hostname with Cloudflare Access.
5. Connect using:

   * the browser dashboard
   * the mobile app
   * optional Discord commands

This allows secure access to the machine without opening ports or exposing local services directly to the internet.

For setup instructions see:

`docs/remote-access-tunnel.md`

## Mobile App

The companion mobile app lives in:

`remote-coder/README.md`

Features include:

* remote terminal controls
* push-to-talk style interactions
* dashboard access
* screenshot viewing
* machine status monitoring
* quick command execution

The mobile app communicates with the same Siylo backend through the Cloudflare Tunnel URL and reuses the existing remote APIs.

## Configuration

Siylo stores config in Electron `userData` as:

`siylo.config.json`

Tracked settings:

* `botToken`
* `authorizedUsers`
* `dashboardPort`
* `autoConnect`
* `commandPrefix`

The dashboard currently exposes bot token and authorized user management. Additional configuration controls are planned.

## Tray Behavior

When the app starts, Electron creates:

* a hidden main window
* a tray icon
* a tray menu with:

  * Start
  * Stop
  * Settings
  * Open Dashboard
  * Quit

The intended workflow is for Siylo to remain running in the tray while providing remote access through the dashboard, mobile app, and optional Discord integration.

## Discord Integration

Discord support remains available but is no longer the primary control path.

Commands can be accepted from:

* direct messages
* bot mentions
* role mentions
* configured command prefixes

Only user IDs listed in `authorizedUsers` are allowed to execute commands.

### Supported Commands

Implemented in:

`src/main/discord-service.js`

* `list`
* `logs`
* `screenshot`
* `restart`
* `open cmd`
* `open powershell`
* `open cursor`
* `open vscode`
* `open kiro`
* `open browser`
* `kill all`
* `kill <session-id>`
* `<session-id> front`
* `<session-id> k <key>`
* `<session-id> t <raw text>`
* `<session-id> "your command here"`

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

## Managed Sessions

Managed sessions are implemented in:

`src/main/session-manager.js`

Current behavior:

* only `cmd` and `powershell` are managed sessions
* sessions receive IDs such as `cmd-1` and `powershell-1`
* session metadata is tracked in memory
* commands are executed by bringing windows forward and sending keystrokes

Siylo currently automates visible terminal windows rather than attaching to PTYs or streaming terminal output.

## Logging and State

Runtime state is managed in:

`src/main/state.js`

Stored information includes:

* connection status
* configuration snapshot
* recent sessions
* recent logs

The dashboard, mobile app, and Discord integration all consume the same underlying runtime state.

## Browser Preview vs Runtime

Opening the Next.js application directly in a browser shows preview data.

Full functionality is available when connected to a running Siylo desktop agent either:

* locally
* through Cloudflare Tunnel
* through the mobile app

## Current Limitations

* no installer or packaging flow yet
* no database
* config and runtime state remain local
* no terminal output streaming
* no remote file editing
* limited permissions model
* no automated tests yet

## Repo Layout

* `src/app` — Next.js application
* `src/components` — dashboard UI components
* `src/main` — Electron runtime and machine automation
* `remote-coder` — companion mobile application
* `scripts` — development and startup scripts
* `docs` — deployment and remote access documentation

## Status

Siylo is currently an early local-first prototype focused on secure remote access to a Windows machine through Cloudflare Tunnel. The strongest implemented workflows today are browser-based remote control, mobile access, Windows shell automation, screenshots, tray management, and optional Discord-based control.
