# pi-discord

Fully vibe-coded

Control [pi](https://github.com/badlogic/pi-mono) sessions from Discord. Send prompts, switch models, approve dangerous commands, all from your phone.

Two modes are available:

- **standalone-mode** — single pi extension, no separate process. You start pi, run `/rc start`, and your session is on Discord. Tested and working.
- **daemon-mode** — separate always-running daemon + per-session extension. Manages multiple pi sessions across Discord channels via tmux. Experimental, untested.

## Standalone Mode (Recommended)

A pi extension that connects your live pi session to Discord. No daemon, no extra processes. Same pattern as [pi-phone](https://github.com/MaliNamNam/pi-phone).

### Setup

#### 1. Create a Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. New Application, go to **Bot**
3. Reset Token, copy it (this is `discord_token`)
4. Enable **MESSAGE CONTENT INTENT** under Privileged Gateway Intents
5. Go to **OAuth2**, check scopes: `bot`, `applications.commands`
6. Bot permissions: `Send Messages`, `Read Message History`, `Use Application Commands`, `View Channels`
7. Copy the generated URL, open it, invite bot to your server

#### 2. Get your Discord user ID

Enable Developer Mode in Discord (Settings > Advanced), right-click your name, Copy User ID. It is a number like `123456789012345678`.

#### 3. Install

```bash
cd standalone-mode
bun install
```

#### 4. Add to pi

Symlink into your pi extensions directory:

```bash
ln -s "$(pwd)/standalone-mode" ~/.pi/agent/extensions/discord-relay
```

Or add the path to your `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/path/to/standalone-mode"
  ]
}
```

#### 5. Configure

Create `~/.pi/agent/extensions/discord-relay.json`:

```json
{
  "discord_token": "your-bot-token",
  "authorized_user_id": "your-discord-user-id"
}
```

#### 6. Guardrails integration (optional)

If you use a `guardrails.ts` extension that prompts for confirmation on dangerous commands, add this near the top of its `export default function`:

```typescript
let discordRelayConnected = false;
pi.events.on("discord-relay", (data: any) => {
  discordRelayConnected = data?.connected ?? false;
});
```

And at the start of its `tool_call` handler:

```typescript
if (discordRelayConnected) return undefined;
```

This lets the discord-relay extension handle approval prompts via Discord buttons instead of blocking on the TUI.

### Usage

Start pi, then:

```
/rc start
```

Pi connects to Discord. Now in Discord:

- `/rc start` — pair the current channel with pi
- `/rc stop` — unpair
- `/abort` — abort current operation
- `/model` — switch model (shows a dropdown of available models)

Type normally in the paired channel to send prompts to pi. Responses appear as messages.

Pi slash commands work from Discord too. Type `/new` for a new session, `/reload` to reload extensions, `/compact` to compact context.

Dangerous commands (rm, sudo, etc.) show Approve/Deny buttons in Discord. Writes outside CWD and protected markdown files show a selection prompt.

Every response includes a footer showing the current working directory and model.

### How it works

The extension hooks into pi's event system:

- `agent_start` / `agent_end` — tracks when pi is working, shows typing indicator, sends final response
- `tool_call` — intercepts dangerous operations, forwards approval prompts to Discord
- `model_select` — notifies Discord of model changes
- `session_start` / `session_switch` / `session_shutdown` — lifecycle management

Messages from Discord are injected via `pi.sendUserMessage()`. The extension uses `pi.events` to coordinate with guardrails (guardrails steps aside when Discord is connected).

Sessions started from Discord get their name prefixed with `[DISCORD]` for easy identification in the session list.

---

## Daemon Mode (Experimental)

Separate daemon process that manages multiple pi sessions via tmux. Each Discord channel can be paired with a different project.

**Status: untested.** The architecture is implemented but has not been validated end-to-end.

### Structure

- `daemon-mode/src/daemon/` — always-running Discord bot, tmux management, session routing
- `daemon-mode/src/extension/` — pi extension that opens a Unix socket for daemon communication
- `daemon-mode/src/shared/` — protocol types shared between daemon and extension

### Setup

```bash
cd daemon-mode
bun install
```

Create `~/.pi/discord/config.json`:

```json
{
  "discord_token": "your-bot-token",
  "authorized_user_id": "your-discord-user-id",
  "timezone": "UTC",
  "max_sessions": 5,
  "socket_dir": "~/.pi/agent/sockets",
  "projects": [
    { "name": "myproject", "path": "/path/to/myproject" }
  ]
}
```

Run the daemon:

```bash
cd daemon-mode
bun run src/daemon/main.ts
```

Load the extension in pi sessions (symlink or add to settings.json).

In Discord: `/rc start` shows a project picker. The daemon spawns a tmux session with pi, connects via Unix socket, and relays messages.

---

## License

MIT
