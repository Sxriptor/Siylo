# Siylo
**Discord-Controlled Local Automation Agent**

Siylo is a lightweight desktop automation agent that allows authorized Discord users to control and interact with a computer remotely through simple Discord commands.

The application runs locally as an **Electron + Next.js + React desktop app** and primarily lives in the **system tray**. It connects to Discord using a bot token and listens for commands directed at `@siylo`.

The goal of Siylo is to provide a clean, secure, and extremely simple way to control development environments, terminals, and applications remotely.

---

# Core Concept

Siylo runs locally on the user's machine and maintains a persistent connection to Discord.

When a Discord user sends a command mentioning the Siylo bot, the bot receives the message and passes the command to the local Siylo agent.

The agent then executes the requested action on the local computer and optionally returns output back to Discord.


Discord User
↓
Discord Servers
↓
Siylo Bot Message Event
↓
Local Siylo Agent
↓
System Command Execution
↓
Response Sent Back To Discord


The Discord bot **does not execute anything itself**. It only relays commands to the Siylo application running locally.

---

# Tech Stack

Siylo is built as a modern desktop application using the following stack:

**Desktop Framework**
- Electron

**Frontend**
- Next.js
- React

**Backend (local runtime)**
- Node.js

**Communication**
- Discord Gateway API

---

# Application Behavior

Most of the time Siylo runs silently in the background.

The application primarily exists as a **system tray agent** with minimal UI.

Optional interfaces include:

- a simple **CLI overlay window**
- a **local web dashboard**

---

# System Tray

When Siylo launches, it places an icon in the system tray.

Clicking the tray icon reveals the primary control menu.

## Tray Menu


Siylo

Start
Stop
Settings
Quit


### Start
Starts the Discord connection and activates command listening.

### Stop
Disconnects Siylo from Discord and disables remote commands.

### Settings
Opens the Siylo configuration interface.

### Quit
Completely closes the Siylo application.

---

# Optional Interfaces

Siylo supports two optional control interfaces.

## CLI Overlay

A minimal terminal-style overlay window for quick command execution.

Example usage:


start
open cursor
screenshot


This is primarily for debugging and manual control.

---

## Local Web Dashboard

Siylo can optionally open a browser window pointing to:


http://localhost:{port}


This dashboard allows users to configure:

- Discord bot credentials
- authorized Discord users
- command permissions
- system integrations
- session management

The browser will open using the **system's default browser**.

---

# Authentication & Permissions

Security is handled through **Discord user ID authorization**.

Only explicitly authorized users may control Siylo.

Authorization is configured through the Siylo dashboard.

## Authorized Users

Each authorized user is stored by Discord ID.

Example:


Authorized Users

123456789012345678
987654321098765432


When a command is received:


if message.author.id not in authorized_users
ignore command


Unauthorized users receive no response.

---

# Discord Command Format

Commands must mention the Siylo bot.

All commands follow a very simple structure:


@siylo command arguments


Example:


@siylo open cursor
@siylo screenshot
@siylo restart
@siylo logs


The goal is to keep commands **extremely simple and natural**.

---

# Core Commands

## System Control


@siylo restart


Restarts the Siylo application.


@siylo logs


Returns recent logs from the Siylo agent.


@siylo screenshot


Captures a screenshot of the system and sends it back to Discord.

---

## Opening Applications

Siylo can launch applications installed on the system.


@siylo open cmd
@siylo open powershell
@siylo open cursor
@siylo open vscode
@siylo open kiro


Applications are mapped internally.

Example mapping:


cursor → Cursor IDE
vscode → Visual Studio Code
cmd → Windows Command Prompt
powershell → Windows PowerShell


---

# Terminal Sessions

Siylo supports persistent terminal sessions.

Each terminal instance is assigned a **session number**.

Example:


cmd-1
cmd-2
powershell-1
powershell-2


## Creating Sessions


@siylo open cmd


Response:


Session created: cmd-1


---

## Running Commands in Sessions

Users can send commands to specific sessions.

Example:


@siylo cmd-1 git pull
@siylo cmd-1 npm run dev


Siylo executes the command inside that terminal session.

---

## Interactive Session Example


@siylo open cmd
→ cmd-1 created

@siylo cmd-1 codex
→ codex started

@siylo cmd-1 continue
→ session continues


Sessions persist until closed.

---

# IDE Interaction

Siylo can open development environments.

Examples:


@siylo open cursor
@siylo open vscode


Future capabilities may include:

- sending commands to IDE terminals
- triggering builds
- executing scripts
- opening specific projects

---

# File Operations

Basic file commands can be supported.

Examples:


@siylo create file notes.txt
@siylo open folder projects
@siylo open browser


---

# Logging

Siylo maintains a runtime log.

Logs include:

- received commands
- executed actions
- errors
- session activity

Command:


@siylo logs


Returns the most recent log entries.

---

# Screenshot


@siylo screenshot


Captures the current screen and sends the image back to Discord.

Useful for:

- monitoring remote builds
- checking system state
- debugging UI issues

---

# Example Command Session


@siylo open cmd
→ cmd-1 started

@siylo cmd-1 git pull
→ pulling repository

@siylo cmd-1 npm run build
→ build started

@siylo screenshot
→ screenshot returned


---

# Startup Behavior

When Siylo launches:

1. Tray icon initializes
2. Configuration loads
3. Discord connection initializes
4. Authorized user list loads
5. Command listener activates

---

# Design Goals

Siylo is designed with the following priorities:

### Simplicity
Commands must be easy to remember and type.

### Security
Only authorized Discord IDs may control the system.

### Lightweight
The application runs silently in the tray with minimal resource usage.

### Developer Focused
Built primarily for developers controlling local machines remotely.

---

# Future Expansion

Potential features for future versions include:

- remote file browser
- terminal streaming
- process monitoring
- AI command interpretation
- multi-machine cluster control
- encrypted command relay
- remote system metrics

---

# Example Use Cases

### Remote Development

Run builds from your phone.


@siylo cmd-1 npm run dev


---

### Restart Servers


@siylo restart


---

### Debug Systems


@siylo screenshot
@siylo logs


---

### Launch Tools


@siylo open cursor
@siylo open vscode


---

# Summary

Siylo turns Discord into a simple remote command interface for your computer.

It runs quietly in the system tray and allows authorized users to interact with:

- terminals
- development environments
- system utilities
- local processes

All through simple commands directed at:


@siylo