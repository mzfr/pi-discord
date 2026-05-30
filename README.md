# pi-discord

Single-file pi extension for controlling a live pi session from Discord.

Fully vibe coded

## Setup

Create a Discord bot, invite it to your server, and enable **Message Content Intent**. The bot needs:

- View Channels
- Send Messages
- Read Message History
- Use Application Commands
- Manage Channels

Install dependencies:

```bash
bun install --minimum-release-age 0
```

Symlink this package into pi extensions:

```bash
ln -s "$(pwd)" ~/.pi/agent/extensions/discord-relay
```

Create `~/.pi/agent/extensions/discord-relay.json`:

```json
{
  "discord_token": "your-bot-token",
  "authorized_user_id": "your-discord-user-id",
  "guild_id": "optional-server-id",
  "category_id": "optional-category-id"
}
```

## Usage

Start pi and run:

```text
/rc start
```

The extension creates or reuses a Discord channel for the current pi session. Messages in that channel are sent to pi; pi responses are posted back with cwd/model/thinking/context footer.

Local pi commands:

```text
/rc start
/rc stop
/rc status
```

Discord commands:

```text
/abort
/model
/recap
```

Notes:

- `/rc start` is terminal-side only; Discord no longer exposes `/rc start` or `/rc stop`.
- `/recap` sends `remind me what we were doing` to pi.
- On disconnect, the channel is marked inactive best-effort and reused on the next `/rc start` for the same pi session.
- Guardrails approval prompts are forwarded to Discord buttons while connected.
