# SP1 — matron-bridge: retire Matrix, journal-only, rename

> Status: **design / approved for spec review**
> Date: 2026-07-14
> Repo: `claude-matrix-bridge` → `matron-bridge` (this repo)

## Program context (the Matron journal migration)

This spec is **sub-project 1 of 4** in a program that moves the whole dev-box
stack off Matrix and onto [matron-journal](https://github.com/Matronhq/matron-journal),
renames the bridge, and drops the hard Cloudflare-domain requirement from the
provisioner. The pieces (each gets its own spec → plan → implementation cycle):

| SP | Repo(s) | Summary | Depends on |
|----|---------|---------|------------|
| **SP1 (this doc)** | matron-bridge | Retire Matrix; journal becomes the sole transport; rename; add two "new chat" button primitives | — |
| SP2 | dev-boxer | Module 08 stands up matron-journal + provisions user/agent + installs renamed bridge; module 09 becomes **two co-equal exposure modes** (IP + self-signed WSS / Cloudflare named tunnel); strip Matrix | SP1 |
| SP3 | matron-apple, matron-web | Trust a pinned self-signed journal cert with an "insecure connection" warning (apple native; web = docs-only) | SP2 |
| SP4 | matron-journal | Client endpoint to list connected servers/agents + relay recent-folders + route an app-initiated start | SP1 |

Excluded from the program: **matron-desktop** (currently just an Electron
wrapper around matron-web with no journal client of its own — its journal
conversion, and an Electron `certificate-error` accept-with-warning path for
self-signed mode, is a downstream follow-up owned separately). The app-side
**"new chat" button UI** is owned by the user, like the desktop conversion.

### Program-level decisions already made

- **Matrix is fully retired** from the bridge (not kept optional).
- **No cleartext.** Client↔journal transport is always TLS: self-signed WSS
  (IP mode) or a real cert (Cloudflare named-tunnel mode). This is a
  deliberate move from Matrix **E2E** encryption to **transport** encryption
  (the journal server can see plaintext).
- **Exposure is two co-equal choices**, presented with their tradeoffs — IP +
  self-signed WSS ("quick and cheap, no domain") vs. Cloudflare domain
  ("box can mint subdomains, real trusted cert"). **No Cloudflare quick
  tunnel** (ephemeral URL, testing-only — rejected).

## SP1 goal

Turn the bridge into a single Node service that speaks **only** to a
matron-journal server, boots from a journal agent token (no Matrix token),
and is ready to be driven by an app "new chat" button. Rename every
user-facing surface from `claude-matrix-bridge` to `matron-bridge`.

## Architecture (end state)

```
 Claude Code (--print, stream-json)
        │  (unchanged: spawn/PTY, prompt detection, MCP, hooks, viewer, ask-user)
        ▼
   matron-bridge  ──WS /ws (agent token, wss://)──►  matron-journal
        │                                              ▲  user msgs / prompt replies /
        │                                              │  structured start (return path)
        └── local HTTP API (MATRON_BRIDGE_API_PORT) + file viewer (MATRON_VIEWER_PORT)
```

The journal transport already exists and is mature (`lib/journal-publisher.js`,
`lib/journal-input-router.js`, `lib/journal-activity.js`, `lib/journal-stream.js`,
and the "Journal Input Consumer" return path in `index.js`). Today it is a
*mirror* layered on top of Matrix. SP1 promotes it to **the** path and removes
the Matrix layer beneath it.

## Scope

### Removed

- **`index.js` Matrix sections:** `Matrix Typing Indicator`, `Matrix Client`,
  `Send to Matrix Room`, `Room Management`, `Media Handling` (the
  `/_matrix/client/v1/media/download/...` path), `Matrix Message Handler`,
  `Room Membership Handler`, and the hard `MATRIX_ACCESS_TOKEN` startup exit
  (currently `index.js:3310`).
- **Matrix bootstrap files:** `add-bot.mjs`, `bootstrap-crosssigning.mjs`,
  `bootstrap-from-creds.mjs`, `setup-user.mjs`, `verify-bots.mjs`,
  `verify-respond.mjs`, `setup/import-bot-blob.mjs`, `setup/cloudflare*.sh`.
- **Config:** all `MATRIX_*` env vars, `ENCRYPT_SESSION_ROOMS`, and the
  matrix-js-sdk / olm / crypto-storage dependencies in `package.json`.
- **Matrix-only lib:** `lib/prompt-buttons.js` (Matrix button encoding —
  journal already carries prompts/replies over its own `prompt_reply` path).
  `lib/journal-title-seed.js` is **repurposed, not removed** — its
  Matrix-room-name source goes away, but its title-derivation logic is reused
  by the new start path (see "Session title" below).

### Promoted

- The journal path becomes unconditional. The "Journal dual-post mirroring"
  section stops being secondary/optional; it is simply "publishing."
- The **control conversation** (`JOURNAL_CONTROL_CONVO_ID`, default
  `bridge-<hostname>`) is the sole session-management surface for typed
  commands (`new` / `list` / `help`). The Journal Input Consumer /
  `journal-input-router` is the sole inbound entry point.

### Kept (transport-agnostic — unchanged)

Claude orchestration (PTY/print spawn, `lib/prompt-detector.js`, command
surface: `/model` `/effort` `/context` busy-queue interrupts), MCP config,
hooks, the **file viewer + `ask-user` secure-data flow** (HMAC/viewer — the
bridge's secure-data rule depends on it), voice-note transcription.

### Added — two "new chat" button primitives

So the bridge is button-ready regardless of who builds the UI (SP4 + the
user's app work consume these):

1. **Structured start-session op.** In addition to the human-typed `new` in
   the control convo, accept a machine-readable start request carrying a
   `workdir`. It funnels into the existing `createSession(...)` (which already
   takes a `workdir` argument). Wire shape follows matron-journal's return-path
   op conventions (alongside `send` / `prompt_reply`); exact frame fixed at
   plan time against `matron-journal/docs/protocol.md`.
2. **Recent-folders reporting.** Answer a "list my recent folders" request
   with the distinct `workdir`s from the persisted-session store (see
   `persistSession(...)`) plus `DEFAULT_WORKDIR`. No configurable "project
   roots" list — persisted sessions only (confirmed).

**Session title:** with no Matrix room name to seed from, a session's journal
convo title is derived at start (workdir basename + a short seed) via the
repurposed `lib/journal-title-seed.js` logic fed from the workdir/start request
instead of a Matrix room name. Exact heuristic is a plan-time detail.

## Rename mapping (approved)

| Surface | From | To |
|---|---|---|
| GitHub repo | `Matronhq/claude-matrix-bridge` | `Matronhq/matron-bridge` (via `gh repo rename`) |
| Local dir / clone path | `~/claude-matrix-bridge` | `~/matron-bridge` |
| systemd service | `claude-matrix-bridge.service` | `matron-bridge.service` |
| viewer service | `claude-matrix-file-viewer.service` | `matron-bridge-viewer.service` |
| env prefix | `MATRIX_BRIDGE_API_PORT`, `MATRIX_VIEWER_PORT` | `MATRON_BRIDGE_API_PORT`, `MATRON_VIEWER_PORT` |
| package name, README, `BRIDGE_CLAUDE.md`, bridge instructions | "Claude Matrix Bridge" | "Matron Bridge" |

- The GitHub rename is done via `gh repo rename` (confirmed: `danbarker` has
  `ADMIN` + `repo` scope). GitHub auto-redirects the old URL, so nothing breaks
  in the interim; SP2 updates dev-boxer's clone URL and **fixes the existing
  org bug** (module 08 currently clones `yearbook/claude-matrix-bridge`; the
  real repo is under `Matronhq`).
- Depth: delete Matrix code, rename user-facing surfaces per the table.
  Incidental "matrix" mentions in comments of shared/transport-agnostic code
  are cleaned up where they fall in the diff, not chased exhaustively.

## Config surface (new `.env.example`, Matrix removed)

Journal is required; everything else is as today minus Matrix:

```
# Journal (required)
JOURNAL_WS_URL=wss://127.0.0.1:9810/ws
JOURNAL_TOKEN_FILE=            # agent token file (preferred)
JOURNAL_TOKEN=                 # raw agent token (alternative)
JOURNAL_CONTROL_CONVO_ID=      # default bridge-<hostname>
JOURNAL_CURSOR_FILE=           # return-path resume cursor
JOURNAL_STREAM_INTERVAL_MS=200

# Claude Code defaults
DEFAULT_WORKDIR=~/
SESSION_TIMEOUT=3600000
BRIDGE_CLAUDE_MD_PATH=

# File viewer / ask-user
HMAC_SECRET=
VIEWER_BASE_URL=
LINK_EXPIRY_MS=900000
MATRON_BRIDGE_API_PORT=9802
MATRON_VIEWER_PORT=9803

# Voice notes (optional)
WHISPER_MODEL_PATH=
WHISPER_LANGUAGE=en
DEBUG=0
```

Startup no longer exits on a missing Matrix token; it validates
`JOURNAL_WS_URL` + a resolvable agent token instead.

## Provisioning

The bridge consumes a journal **agent token** (`matron-admin agent add <user>
<name>` on the journal server, which prints the token once). Producing that
token and wiring it into `JOURNAL_TOKEN_FILE` is **SP2's** job (dev-boxer). SP1
only needs the bridge to read it and boot.

## Non-goals

- No Matrix, no BYOH, no dual-transport fallback.
- No app UI (user-owned); no journal server-list endpoint (SP4).
- No E2E encryption (transport TLS only — see program decisions).
- No change to Claude orchestration behavior, MCP, hooks, or the viewer.

## Verification

- `npm test` stays green: delete Matrix-specific tests; keep/extend journal
  tests; add tests for the two new primitives (structured start funnels to
  `createSession` with the given workdir; recent-folders returns distinct
  persisted workdirs + `DEFAULT_WORKDIR`).
- End-to-end smoke: bridge boots against a local matron-journal with an agent
  token → `new` in the control convo spawns a session → a typed message
  round-trips → a file-write posts a working viewer link → a structured start
  with `workdir=X` spawns a session in X → recent-folders lists X.

## Risks / watch-items

- `index.js` is ~6.7k lines with Matrix and journal interleaved in the publish
  paths; the risk is removing a Matrix branch that a journal path implicitly
  depended on. Mitigation: lean on the existing journal tests + the E2E smoke,
  and remove section-by-section with the suite green between steps.
- WebSocket-over-Cloudflare and self-signed WSS behavior is an SP2 concern, but
  SP1 should not assume a plaintext `ws://` default — `.env.example` shows
  `wss://`.
```