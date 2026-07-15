# matron-bridge

Chat with Claude Code or Codex CLI sessions from anywhere. The bridge spawns and manages coding-agent sessions on your dev box and connects them to a [matron-journal](https://github.com/Matronhq/matron-journal) server, so the native Matron apps ([iOS](https://github.com/Matronhq/matron-apple), [desktop](https://github.com/Matronhq/matron-desktop), [web](https://github.com/Matronhq/matron-web)) can chat with them — including live typing/streaming indicators and a return path for user input.

Claude uses `--print` structured JSON streaming. Codex uses the stable programmatic `codex exec --json` interface, starting one process per turn and resuming the same Codex thread automatically.

Use `/switch codex` or `/switch claude` inside an idle session to hand the same bridge conversation to the other agent. The bridge keeps separate native session IDs for Claude and Codex, resumes each one when you switch back, and prepends only the transcript messages that agent has not seen to your next real prompt. The Matron conversation ID stays stable, as do the shared working directory, files, and Git state. Provider-private reasoning and tool state are not transferable.

Codex turns run with `approval_policy="never"` because there is no interactive terminal to approve escalations. The sandbox defaults to `workspace-write`; blocked operations fail closed and the bridge surfaces the error. Only use `CODEX_SANDBOX_MODE=danger-full-access` on a host you intentionally trust for unattended agent execution.

For the full operator reference, see [Using the Codex backend](docs/codex.md).

## License

This project is licensed under AGPLv3. For alternative licensing, contact [licensing@matron.chat](mailto:licensing@matron.chat).

## Requirements

- Node.js 22+
- Claude Code CLI and/or Codex CLI installed and authenticated
- A [matron-journal](https://github.com/Matronhq/matron-journal) server and an agent token for the bridge (`matron-admin agent add <user> <device-name>` on the journal server)

**Linux (Ubuntu/Debian):** `apt-get install nodejs npm` (or use nvm). For voice notes: `setup/install-whisper.sh` will install the rest.

**macOS:** [Homebrew](https://brew.sh), Xcode Command Line Tools (`xcode-select --install`), and `brew install node@22`. For voice notes: `setup/install-whisper.sh` will run `brew install whisper-cpp ffmpeg` automatically.

For public file and secret viewer links on macOS, install `cloudflared` if you want to publish the local viewer through Cloudflare Tunnel:

```bash
brew install cloudflared
```

## Setup

```bash
npm install
cp .env.example .env
# Edit .env — set JOURNAL_WS_URL + JOURNAL_TOKEN_FILE (or JOURNAL_TOKEN) and ALLOWED_USER_IDS
npm start
```

### Enable Codex

Install and authenticate the Codex CLI as the same OS user that runs the bridge:

```bash
npm install -g @openai/codex
codex login
codex login status
codex exec --json "Reply with exactly: Codex is ready"
```

The last command verifies the same non-interactive interface used by the bridge. For a headless machine, use `codex login --device-auth`; API-key login is also supported by the CLI. Do not copy `~/.codex/auth.json` into this repository or put credentials in chat.

To make Codex the default, set these values in `.env`:

```dotenv
MATRON_DEFAULT_AGENT=codex
CODEX_SANDBOX_MODE=workspace-write
# Optional; the repository's BRIDGE_CODEX.md is used when empty
BRIDGE_CODEX_MD_PATH=
```

You can keep Claude Code as the default and select Codex per conversation instead:

```text
/start --codex ~/Dev/my-project
/agent
/model default
```

After changing `.env`, restart the bridge or re-run the service installer as described below. See [Using the Codex backend](docs/codex.md) for sandbox guidance, `/switch` behavior, provider-specific commands, files/media, and troubleshooting.

To run as a managed service, use the OS-detecting installer:

```bash
setup/install.sh                # installs npm deps, seeds .env

# Linux (systemd):
sudo setup/service.sh

# macOS (LaunchAgent — runs while you're logged in):
setup/service.sh
# or, system-wide LaunchDaemon (runs at boot, requires sudo):
sudo SCOPE=system setup/service.sh
```

After editing `.env`, re-run `setup/service.sh` (on macOS, launchd has no
`EnvironmentFile` equivalent — values are inlined into the plist at install
time).

## Publishing The Viewer On macOS

The macOS service installer starts both matron-bridge and the local file viewer. The viewer listens on `127.0.0.1:$MATRON_VIEWER_PORT` and powers file links, secure secret requests, and one-time sensitive-data links.

To make those links usable from Matron clients, set `VIEWER_BASE_URL` to a public HTTPS URL that forwards to the local viewer (e.g. via a Cloudflare named tunnel or your own reverse proxy pointed at `127.0.0.1:$MATRON_VIEWER_PORT`). The bridge no longer ships its own Cloudflare tunnel helper — provisioning the tunnel/DNS is a dev-box-level concern, not something this repo manages.

### Live command output rides the journal protocol

Live Bash output streams to Matron clients over the authenticated
matron-journal WebSocket (`stream_append` frames — see the design spec
`docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md` in the
matron-journal repo). It no longer uses `VIEWER_BASE_URL` or the viewer's
`/live/ws` endpoint, and new `chat.matron.live_output` events carry no
`viewer_url`. The viewer service is still required for file links, secure
secret requests, and one-time sensitive-data links.

## Managing The Service

**Linux (systemd):**

| Action | Command |
|---|---|
| Status | `systemctl status matron-bridge` |
| Restart | `sudo systemctl restart matron-bridge` |
| Logs | `journalctl -u matron-bridge -f` |
| Stop | `sudo systemctl stop matron-bridge` |

**macOS (launchd, user scope):**

| Action | Command |
|---|---|
| Status | `launchctl print gui/$UID/chat.matron.matron-bridge \| head -20` |
| Restart | `launchctl kickstart -k gui/$UID/chat.matron.matron-bridge` |
| Logs | `tail -f ~/Library/Logs/matron-bridge.log` |
| Stop | `launchctl kill TERM gui/$UID/chat.matron.matron-bridge` |
| Uninstall | `launchctl bootout gui/$UID/chat.matron.matron-bridge && rm ~/Library/LaunchAgents/chat.matron.matron-bridge.plist` |

For `SCOPE=system` setups, replace `gui/$UID` with `system` and `~/Library/LaunchAgents` with `/Library/LaunchDaemons`.

## Config (.env)

| Variable | Description | Default |
|---|---|---|
| `ALLOWED_USER_IDS` | Comma-separated allowlist of authorized user identities for this bridge (its sender label for journal-originated session commands) | `""` (any user) |
| `DEFAULT_WORKDIR` | Default working directory for coding-agent sessions; `~` expands to the service user's home directory | `process.cwd()` if unset |
| `MATRON_DEFAULT_AGENT` | Default coding agent (`claude` or `codex`); override per command with `--claude` / `--codex` | `claude` |
| `SESSION_IDLE_TIMEOUT_MS` | Idle time after which a session is silently reaped (next user message auto-resumes it). Set to `0` to disable, or `86400000` to restore the previous 24h default. | `3600000` (1 hour) |
| `SESSION_IDLE_CHECK_MS` | How often the reaper scans for idle sessions | `300000` (5 minutes) |
| `BRIDGE_CLAUDE_MD_PATH` | Optional markdown file appended to bridge-spawned Claude sessions for bridge-specific guidance | `BRIDGE_CLAUDE.md` |
| `BRIDGE_CODEX_MD_PATH` | Optional developer-instructions markdown injected into bridge-spawned Codex turns | `BRIDGE_CODEX.md` |
| `CODEX_SANDBOX_MODE` | Sandbox for Codex programmatic turns: `read-only`, `workspace-write`, or `danger-full-access` | `workspace-write` |
| `DEBUG` | Set to `1` to log verbose bridge and coding-agent events | `0` |
| `MATRON_INTERACTIVE_MODE` | Set to `1` to spawn Claude Code as a real PTY (instead of `--print` stream mode) so interactive flows like `/login` work | `0` |
| `MATRON_DUMP_PTY` | When `MATRON_INTERACTIVE_MODE=1`, set to `1` to dump raw PTY bytes for each session to a private per-session temp dir, e.g. `/tmp/iv-pty-XXXXXX/<roomId>.log` (exact path is printed to the bridge log at session start), for debugging stuck-prompt issues | `0` |
| `HMAC_SECRET` | Shared secret for signed file viewer URLs | — |
| `VIEWER_BASE_URL` | Public URL for file viewer | — |
| `LINK_EXPIRY_MS` | Signed URL expiry in ms | `900000` (15 min) |
| `MATRON_BRIDGE_API_PORT` | Internal API port (hooks, MCP, viewer) | `9802` |
| `MATRON_VIEWER_PORT` | Local file viewer port | `9803` |

## Commands

`/` and `!` command prefixes are interchangeable; the table uses `!` for brevity.

| Command | Description |
|---|---|
| `!start [--claude\|--codex] [workdir]` | Start a session with the selected agent (optional custom workdir) |
| `!start now` | Start a fresh session (skip resume offer) |
| `!start --browser [workdir]` | Claude only: also load the chrome-devtools MCP (off by default to save ~260M/session). The flag is order-independent and also accepted by `!resume`, `!workdir`, and `!restart`. |
| `!stop` | Stop the current session |
| `!restart [--browser]` | Stop and immediately resume the session (`--browser` is Claude-only) |
| `!resume [--claude\|--codex] <n\|id> [--browser]` | Resume a previous session (`--browser` is Claude-only) |
| `!sessions [--claude\|--codex]` | List past sessions for an agent |
| `!workdir [--claude\|--codex] <path> [--browser]` | Start an agent session in another working directory (`--browser` is Claude-only) |
| `!status` | Show session info (uptime, workdir, restarts) |
| `!agent` | Show the current/default coding agent |
| `!switch <claude\|codex>` | Hand the current conversation to the other agent (idle sessions only) |
| `!working` | Toggle tool call visibility |
| `!mcp` | Show MCP server status |
| `!model [model-id\|default]` | Show or change the active provider's model |
| `!mode` | Show the active mode (Codex is programmatic-only) |
| `!effort [level]` | Show or set reasoning effort (Claude only; use Codex config for Codex) |
| `!cost` | Show session cost |
| `!usage` | Show token usage stats |
| `!limits` | Show subscription limits when the active backend exposes them (not available for Codex) |
| `!tools` | List available tools |
| `!help` | Show available commands |

Any other message is forwarded directly to the selected agent. Claude Code slash commands (e.g. `/commit`, `/review-pr`) are passed through in Claude interactive mode; Codex programmatic sessions treat messages as normal task prompts. `/model` changes a model within the active provider; `/switch` hands the bridge conversation between Claude and Codex.

## Matron journal transport

The bridge connects to a [matron-journal](https://github.com/Matronhq/matron-journal) server as an **agent** device — this is the bridge's sole transport. `JOURNAL_WS_URL` and an agent token (`JOURNAL_TOKEN_FILE` or `JOURNAL_TOKEN`) are required; the bridge exits at startup without them.

What rides the journal connection:

- **Outbound mirror** — session output, uploaded files/images (media mirroring), and read-marker advances are published as journal events. The media HTTP endpoint is derived from `JOURNAL_WS_URL`; no extra config.
- **Ephemeral live UX** — activity indicators (typing / "running `<command>`…") and in-progress assistant-text streaming for Matron clients viewing the conversation. Best-effort: never queued or replayed, so an outage means a missed indicator, not a stale one.
- **Return path** — user messages and prompt-button replies sent from Matron clients are routed into the owning coding-agent session. The inbound cursor persists to `JOURNAL_CURSOR_FILE` so a restart resumes where it left off.
- **Control convo** — one stable conversation (`JOURNAL_CONTROL_CONVO_ID`, default `bridge-<hostname>`) accepts session-management commands from Matron clients: `/start [--claude|--codex] [dir]` (alias `new`), `/sessions [--claude|--codex]` (alias `list`), `/resume`, `/workdir`, `/help`. Session-scoped commands (`/status`, `/stop`, …) don't apply there — they belong to each session's own conversation. `/` and `!` prefixes are interchangeable.

| Variable | Description | Default |
|---|---|---|
| `JOURNAL_WS_URL` | Journal server WebSocket URL (required) | — |
| `JOURNAL_TOKEN_FILE` | Path to a file containing the agent token (takes precedence over `JOURNAL_TOKEN`) | — |
| `JOURNAL_TOKEN` | Raw agent token | — |
| `JOURNAL_CURSOR_FILE` | Where the inbound cursor is persisted | `journal-cursor.json` in the repo root |
| `JOURNAL_CONTROL_CONVO_ID` | Stable convo id for session-management commands | `bridge-<hostname>` |
| `JOURNAL_STREAM_INTERVAL_MS` | Streaming-overlay coalescing floor (at most one in-progress frame per conversation+message per window) | `200` |

Provision the agent token on the journal server with `matron-admin agent add <user> <device-name>`.

## How it works

1. User messages arrive via the matron-journal WebSocket connection
2. Claude Code is spawned with `--print --input-format stream-json --output-format stream-json`, or Codex is run with `codex exec --json`
3. User messages are sent as Claude stream JSON or as a Codex stdin prompt
4. Structured JSON events are parsed from stdout and normalized into the shared bridge session lifecycle
5. The complete response is published to the journal when the provider reports that the turn is complete
6. Long responses are split at 32K-char boundaries
7. Sessions persist across restarts via Claude `--resume <session-id>` or Codex `exec resume <thread-id>`
8. Agent handoffs persist one native session ID per provider plus a shared transcript cursor; the next prompt carries a bounded unseen transcript delta
9. Crashed sessions auto-restart up to 3 times
10. Messages sent while an agent is busy are queued and sent when the turn completes

## File structure

```
matron-bridge/
├── index.js              # Main bridge (journal wiring, session lifecycle)
├── lib/                  # Bridge modules: journal-* (Matron transport), command
│                         # dispatch, prompt detection/buttons, PTY interactive mode,
│                         # media mirroring, transcription, session summaries, …
├── ask-user.js           # MCP server for user questions / secure secret flows
├── BRIDGE_CLAUDE.md      # Extra instructions for bridge-spawned Claude sessions
├── BRIDGE_CODEX.md       # Extra instructions for bridge-spawned Codex turns
├── docs/codex.md         # Codex setup, switching, security, and troubleshooting
├── mcp-config.json       # MCP server config for Claude Code
├── viewer/               # HMAC-signed file viewer
├── setup/                # OS-dispatching installer, service, whisper
├── hooks/                # Claude Code hooks used by bridge sessions
├── test/                 # Vitest suite
├── docs/
├── SECURITY.md
├── package.json
└── .env.example
```
