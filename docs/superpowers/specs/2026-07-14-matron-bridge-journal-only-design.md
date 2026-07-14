# SP1 — matron-bridge: retire Matrix, journal-only, rename

> Status: **approved — re-scoped 2026-07-14 (button primitives moved to SP2/SP3); planning**
> Date: 2026-07-14
> Repo: `claude-matrix-bridge` → `matron-bridge` (this repo)

## Program context (the Matron journal migration)

This spec is **sub-project 1 of 5** in a program that moves the whole dev-box
stack off Matrix and onto [matron-journal](https://github.com/Matronhq/matron-journal),
renames the bridge, and drops the hard Cloudflare-domain requirement from the
provisioner. The pieces (each gets its own spec → plan → implementation cycle):

| SP | Repo(s) | Summary | Depends on |
|----|---------|---------|------------|
| **SP1 (this doc)** | matron-bridge | Retire Matrix; journal becomes the sole transport; rename | — |
| SP2 | matron-journal | Client-API: app-initiated session start, recent-folders response, and a connected-servers roster | — |
| SP3 | matron-bridge | Consume SP2's client-API — the two "new chat" button primitives (structured start + recent-folders) | SP1, SP2 |
| SP4 | dev-boxer | Module 08 stands up matron-journal + provisions user/agent + installs renamed bridge; module 09 becomes **two co-equal exposure modes** (IP + self-signed WSS / Cloudflare named tunnel); strip Matrix | SP1 |
| SP5 | matron-apple, matron-web | Trust a pinned self-signed journal cert with an "insecure connection" warning (apple native; web = docs-only) | SP4 |

**Why the two "new chat" primitives moved out of SP1 (2026-07-14):** planning
against the live `matron-journal` protocol (`src/ws.js`) showed the server only
lets a client send `text` (op `send`, `type` hard-limited to `text`) or
`prompt_reply`, and lets an agent publish only a **closed** type whitelist
(`text, prompt, prompt_reply, tool_output, diff, permission_request, file,
image, edit`). There is no custom client op, no arbitrary/namespaced event type,
and no device roster. A machine-readable "start session" frame, a structured
"recent folders" response, and a "list connected servers" query therefore all
require **server** changes — so they now live in **SP2 (matron-journal
client-API)**, and the bridge consumes them in **SP3**. SP1 is pure bridge work
(retire Matrix + rename) with **no** journal-protocol dependency, so it proceeds
independently and ships against the current server. The existing human-typed
`new <workdir>` control-convo text command keeps working throughout.

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
matron-journal server and boots from a journal agent token (no Matrix token).
Rename every user-facing surface from `claude-matrix-bridge` to `matron-bridge`.
The app "new chat" button primitives are **out of scope here** — they depend on
SP2's server changes and land in SP3.

## Architecture (end state)

```
 Claude Code (--print, stream-json)
        │  (unchanged: spawn/PTY, prompt detection, MCP, hooks, viewer, ask-user)
        ▼
   matron-bridge  ──WS /ws (agent token, wss://)──►  matron-journal
        │                                              ▲  user msgs / prompt replies /
        │                                              │  control commands (return path)
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
  `Send to Matrix Room` (only the Matrix branches — several functions here are
  interleaved, see below), `Room Management`, `Media Handling` (the
  `/_matrix/client/v1/media/download/...` path), `Matrix Message Handler`,
  `Room Membership Handler`, and the hard `MATRIX_ACCESS_TOKEN` startup exit
  (currently `index.js:3415-3418`). The single Matrix SDK import is
  `index.js:3` (`matrix-bot-sdk`).
- **Matrix bootstrap files:** `add-bot.mjs`, `bootstrap-crosssigning.mjs`,
  `bootstrap-from-creds.mjs`, `setup-user.mjs`, `verify-bots.mjs`,
  `verify-respond.mjs`, `setup/import-bot-blob.mjs`, `setup/cloudflare*.sh`,
  plus their `package.json` `scripts` entries (`bootstrap-crosssigning`, and the
  `node --check` references in `check`).
- **Config / deps:** all `MATRIX_*` env vars, `BRIDGE_ROOM_ID`,
  `ALLOWED_USER_IDS`, `ENCRYPT_SESSION_ROOMS`, and the Matrix dependencies in
  `package.json` — `matrix-bot-sdk` (used by `index.js`), `matrix-js-sdk` +
  `@matrix-org/matrix-sdk-crypto-wasm` (used only by the deleted bootstrap
  `.mjs` scripts), and the `matrix-js-sdk` `overrides` entry. Crypto is
  `RustSdkCryptoStorageProvider` (vodozemac), not the `olm` package.
- `lib/journal-title-seed.js` is **repurposed, not removed** — its
  Matrix-room-name source goes away, but its title-derivation logic is reused
  by the workdir-sourced title seed (see "Session title" below).

**Correction (verified against code):** `lib/prompt-buttons.js` is **not**
removed. Despite the name it is shared — the journal inbound path calls
`promptButtons` / `promptResponseForButton` (`index.js:5130`, `5134`) to resolve
prompt replies. Only its **Matrix** consumer `sendButtonMessage`
(`index.js:3650-3672`) goes away; the module and its journal use stay.

### Interleaved functions (surgical, not whole-function deletes)

These post to BOTH Matrix and journal in the same body; the plan removes only
the Matrix branch and preserves the journal path:

- `sendToRoom` (`index.js:3435-3480`) — the core dual-post choke point (journal
  `3436-3464` / Matrix `3465-3479`). Note it currently returns the Matrix
  `eventId`; journal-only callers that used the return value for edits/pins must
  be audited (most of those Matrix-edit features are themselves removed).
- `sendLiveOutputEvent` (`3482-3511`), `sendButtonMessage` (`3650-3672`),
  `updateRoomName` (`3751-3762`, the sole title choke point — journal
  `upsertConvo` rides through it), `maybeUpdatePinnedSummary` (`3764-3875`,
  title→journal via `updateRoomName`; pinned-message half is Matrix-only),
  `buildMediaContentBlocks` (`3951-4031`, Matrix byte-fetch at `3958` via
  `downloadMatrixFile`; the `attachPendingMediaMirror` journal hooks must
  survive).
- `client.on('room.message', …)` (`5509-6013`) — the Matrix inbound handler.
  Much of its interior (command classification, plan-build, busy-queue, rescue
  keystrokes, prompt resolution) is already shared with the journal route via
  `lib/command-dispatch.js` and the Journal Input Consumer. **Highest-risk
  removal:** confirm the journal consumer reaches parity before deleting.

Functions that sit under the "Send to Matrix Room" banner but are **journal-only**
and must be kept: `finalizeToolStreamEntry` (`3535-3620`),
`stopAndFinalizeToolStream` (`3622-3628`), `sweepToolStreams` (`3641-3648`).

### Promoted

- The journal path becomes unconditional. The "Journal dual-post mirroring"
  section (`index.js:416+`) stops being secondary/optional; it is simply
  "publishing."
- The **control conversation** (`JOURNAL_CONTROL_CONVO_ID`, default
  `bridge-<hostname>`) is the sole session-management surface for typed
  commands (`new` / `list` / `help`). The Journal Input Consumer /
  `journal-input-router` is the sole inbound entry point.

### Kept (transport-agnostic — unchanged)

Claude orchestration (PTY/print spawn, `lib/prompt-detector.js`, command
surface: `/model` `/effort` `/context` busy-queue interrupts), MCP config,
hooks, the **file viewer + `ask-user` secure-data flow** (HMAC/viewer — the
bridge's secure-data rule depends on it), voice-note transcription.

### Deferred to SP2 + SP3 — the two "new chat" button primitives

The structured app-initiated **start-session op** and the **recent-folders**
response are **not built here** — see the "Why the two primitives moved out"
note above. The current control-convo text command `new <workdir>` (which
already funnels `new → !start <workdir> → createSession(...)`) continues to work
unchanged in SP1; the machine-readable versions land in SP3 on top of SP2's
server support.

### Session title (in scope for SP1)

Retiring Matrix removes the room-name title seed, so SP1 must replace it.
`seedJournalTitleFromRoom` (`lib/journal-title-seed.js`) currently pulls the
title from `m.room.name` via a `getRoomName` seam wired at `index.js:474`
(`client.getRoomStateEvent(... 'm.room.name' ...)`), which breaks once the
Matrix client is gone. SP1 re-sources the seed from the session's `workdir`
(basename + a short seed), reusing the module's title-derivation/idempotency
logic. Exact heuristic is a plan-time detail.

## Rename mapping (approved)

| Surface | From | To |
|---|---|---|
| GitHub repo | `Matronhq/claude-matrix-bridge` | `Matronhq/matron-bridge` (via `gh repo rename`) |
| Local dir / clone path | `~/claude-matrix-bridge` | `~/matron-bridge` |
| systemd service | `claude-matrix-bridge.service` | `matron-bridge.service` |
| viewer service | `claude-matrix-file-viewer.service` | `matron-bridge-viewer.service` |
| launchd labels | `chat.matron.claude-matrix-bridge` / `…file-viewer` | `chat.matron.matron-bridge` / `…viewer` |
| env prefix | `MATRON_BRIDGE_API_PORT`, `MATRON_VIEWER_PORT` | `MATRON_BRIDGE_API_PORT`, `MATRON_VIEWER_PORT` |
| package name, README, `BRIDGE_CLAUDE.md`, bridge instructions | "Claude Matrix Bridge" | "Matron Bridge" |

- Service/plist files are **generated at install time** by shell heredocs
  (`setup/service-linux.sh`, `setup/service-macos.sh`) — there are no committed
  `*.service`/`*.plist` files. The rename edits those generators plus
  `restart.sh` / `start-bridge.sh` (which hardcode `claude-matrix-bridge` log
  and process names).
- The GitHub rename is done via `gh repo rename` (confirmed: `danbarker` has
  `ADMIN` + `repo` scope). GitHub auto-redirects the old URL, so nothing breaks
  in the interim; SP4 updates dev-boxer's clone URL and **fixes the existing
  org bug** (module 08 currently clones `yearbook/claude-matrix-bridge`; the
  real repo is under `Matronhq`).
- Depth: delete Matrix code, rename user-facing surfaces per the table.
  Incidental "matrix" mentions in comments of shared/transport-agnostic code
  are cleaned up where they fall in the diff, not chased exhaustively. Historical
  docs under `docs/` that reference the old name are left as history.

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
token and wiring it into `JOURNAL_TOKEN_FILE` is **SP4's** job (dev-boxer). SP1
only needs the bridge to read it and boot.

## Non-goals

- No Matrix, no BYOH, no dual-transport fallback.
- No app-initiated start op, recent-folders response, or connected-servers
  roster (those are SP2 server work + SP3 bridge work). The existing
  `new <workdir>` control-convo text command is untouched and keeps working.
- No app UI (user-owned).
- No E2E encryption (transport TLS only — see program decisions).
- No change to Claude orchestration behavior, MCP, hooks, or the viewer.

## Verification

- `npm test` (Vitest — `vitest run`) stays green: delete/replace Matrix-coupled
  test pins — the "Matrix regression pin" cases in `test/command-dispatch.test.js`
  and `test/journal-input-router.test.js` read `index.js` and assert a
  `// --- Matrix Message Handler ---` block and shared respawn helper, so they
  must be updated when that handler is deleted; keep/extend journal tests; add a
  test that the workdir-sourced title seed replaces the room-name seam.
- End-to-end smoke: bridge boots against a local matron-journal with an agent
  token → `new <dir>` in the control convo spawns a session in `<dir>` → a
  typed message round-trips → a file-write posts a working viewer link → the
  convo title reflects the workdir. (The structured button primitives are
  verified in SP3.)

## Risks / watch-items

- `index.js` is ~6.8k lines with Matrix and journal interleaved in the publish
  paths; the risk is removing a Matrix branch that a journal path implicitly
  depended on. Mitigation: lean on the existing journal tests + the E2E smoke,
  and remove section-by-section with the suite green between steps.
- The `client.on('room.message')` handler duplicates logic the journal consumer
  also implements. Before deleting it, verify the journal route reaches parity
  for every branch currently exercised only there (media, prompt-opt buttons,
  auto-resume) — this is the single highest-risk removal.
- WebSocket-over-Cloudflare and self-signed WSS behavior is an SP4 concern, but
  SP1 should not assume a plaintext `ws://` default — `.env.example` shows
  `wss://`.
