# Live Bash Output Tile

## Problem

When Claude runs a Bash command via the bridge, the user sees an indicator line (`🔧 \`ls -la\``) but never the output. For anything beyond a one-liner — test runs, builds, multi-step shell pipelines — the user has no visibility into what's actually happening until Claude summarizes it later (if at all). Long-running commands are particularly opaque.

## Approach

Add a new custom Matrix event type that renders, in modified Element clients, as a sandboxed iframe pointing at the existing viewer. The viewer streams live command output over WebSocket from a tee'd log file on disk. After a configurable expiry window (default 4 hours) the log is deleted and the tile shows "Output expired" — no permanent record of command output in chat history.

A `PreToolUse` hook rewrites Bash commands to tee their output to a log file. The bridge correlates the tee'd path back to the `tool_use_id` from Claude's stream-json, posts the custom event, and tracks the log lifecycle. The on-the-wire event format is renderer-agnostic so a future native (non-iframe) renderer can drop in without changing the bridge.

## Scope

Three repos to modify:

- **claude-matrix-bridge** — new hook script, hook registration in `--settings`, custom event posting, in-memory live-output store, GC sweeper, viewer extension for live streaming.
- **viewer/** (in claude-matrix-bridge) — new `/live` HTML endpoint and `/live/ws` WebSocket endpoint with HMAC-token auth.
- **matron-web** (fork of element-web) — new module package that registers a custom renderer for `com.matron.live_output.v1` events.

Out of scope for v1:

- **matron-desktop / matron-x** — Element X (iOS/Android) gets the fallback `body` (plain viewer URL) until a native iOS/Android renderer ships in v2.
- Tools other than `Bash` — design accommodates them via the same event type, but only `Bash` is wired up in v1.
- Live native (non-iframe) renderer — same event format will support it later without bridge changes.
- Replacing the existing tool-call indicator — the `🔧 \`cmd\`` line continues to render alongside the new tile.

## Decisions locked during brainstorming

- **Expiry behavior**: hard expiry, no persistence, no on-demand re-fetch. After TTL the log is deleted and the tile shows "Output expired."
- **Live tail mechanism**: PreToolUse hook + tee + WebSocket. No phased "static-first" rollout.
- **Gating**: new per-room `showBashOutput` setting (separate from the existing `showWorking` indicator gate). Defaults on (a room with no persisted preference gets live output).
- **Default TTL**: 4 hours (`MATRON_LIVE_OUTPUT_TTL=14400`).
- **Renderer**: sandboxed iframe in v1; native React component is a possible v2.
- **Element X**: out of scope; falls back to plain viewer URL link.

## Architecture

```
Claude Code
   │ tool_use: Bash {command: "X"}
   ▼
PreToolUse hook (hooks/matron-bash-tee.sh)
   │  reads tool_use_id, BRIDGE_ROOM_ID, MATRON_BASH_TEE_ENABLED
   │  if enabled: outputs hookSpecificOutput.updatedInput.command =
   │    "matron-tee /tmp/matron-cmd-{tool_use_id}.log -- <original args>"
   │  else: pass-through
   ▼
Claude Code executes (possibly modified) command
   │ stream-json: tool_use {id, input.command (rewritten)}
   ▼
Bridge index.js stream-json parser
   │  detects matron-tee marker → extracts original command, log path
   │  indicator line uses original command (existing path at index.js:606)
   │  posts new Matrix event type=com.matron.live_output.v1
   │  registers entry in liveOutputs Map keyed by tool_use_id
   ▼
Matron-web custom renderer
   │  registered via ModuleApi.customComponents.registerMessageRenderer
   │  returns: header (command + status badge) + sandboxed iframe to viewer_url
   ▼
Viewer /live endpoint (viewer/server.js)
   │  validates HMAC token, serves HTML page with <pre> + WS client JS
   │
   ▼
Viewer /live/ws WebSocket
   │  validates token, opens log file, backfills from offset 0,
   │  then tails appends; watches sidecar .done sentinel
   │
   ▼
Page renders with auto-scroll, scroll-lock-on-user-scroll, expand/collapse,
internal scrollbar, max-height
```

**Closure path**: `tool_result` arrives in stream-json → bridge writes `/tmp/matron-cmd-{id}.log.done` containing `{exitCode, denied, truncated}` → WS server detects sentinel via `fs.watch` → flushes any remaining log content, sends final `{type: "complete", exitCode, denied, truncated}` frame → page updates badge → WS closes.

**Expiry path**: 60-second GC timer scans `liveOutputs`; entries past `expiresAt` get their log + sentinel deleted from disk and removed from the map. Tokens validate `exp` claim independently, so iframes loaded after expiry get 403 and render "Output expired" client-side.

**Bridge restart recovery**: on startup, sweep `/tmp/matron-cmd-*.log` and `.done` files older than `MATRON_LIVE_OUTPUT_TTL` and delete them. Stateless — no persisted bridge state needed.

## Components

### `hooks/matron-bash-tee.sh`

Same shape as `hooks/compact-notify.sh`. Reads PreToolUse JSON on stdin (`session_id`, `tool_use_id`, `tool_input.command`). Emits `hookSpecificOutput` with `updatedInput.command` set to the tee'd form, only when `MATRON_BASH_TEE_ENABLED=1`. Also requires `tool_name == "Bash"` in input — pass-through for other tool types.

### `hooks/matron-tee` (helper)

Small executable script (bash or Node) handling its own arg parsing and shell escaping. Invocation: `matron-tee /path/to/log -- <command and args...>`. Internally: opens log file, executes the command with stdout+stderr piped through `head -c 50MB` (configurable via `MATRON_LIVE_OUTPUT_MAX_BYTES`) into the log, propagates the command's exit code. Writes a final marker line on truncation. This is the layer that keeps the hook script free of escaping fragility.

### Bridge changes (`index.js`)

- Hook registration: extend the inline `--settings` JSON at `index.js:180` to include `PreToolUse` → `Bash` → `hooks/matron-bash-tee.sh`.
- Per-session env: when spawning Claude, set `MATRON_BASH_TEE_ENABLED=1` if the room has `showBashOutput` on. Existing pattern at `index.js:170-209`.
- New in-memory store: `liveOutputs = new Map<tool_use_id, {logPath, doneSentinelPath, roomId, expiresAt}>`.
- `assistant` event handler at `index.js:606`: when a `Bash` tool_use arrives, detect the `matron-tee` marker in `input.command`, extract the original command for the indicator line, register an entry in `liveOutputs`, and post a new Matrix event of type `com.matron.live_output.v1`.
- `user` event handler at `index.js:824`: on `tool_result` for a registered `tool_use_id`, write the `.done` sentinel as JSON: `{exitCode: number|null, denied: boolean, truncated: boolean}`. Mark complete in the map.
- New GC timer: `setInterval(60_000)` scans `liveOutputs` for expired entries, deletes log + sentinel files, removes from map.
- Startup sweep: at boot, glob `/tmp/matron-cmd-*.log*` and unlink anything older than `MATRON_LIVE_OUTPUT_TTL`.

### Viewer changes (`viewer/server.js`)

Add `ws` package as a dependency. Wrap the existing Express app with WebSocket upgrade handling on a new path.

- `GET /live` — validates token via `verifyToken()`, renders an HTML page (similar shape to existing `renderHtml`) containing a `<pre>` element, a status header, and inline JS that opens a WS to `/live/ws?token=<same-token>`.
- `GET /live/ws` (WS upgrade) — validates token, validates that the token's `liveCmdId` matches a still-existing log file. Opens the log file, streams initial contents to the client, then tails using `chokidar` or `fs.watch`. Polls for the `.done` sentinel; on detection, flushes final content and sends `{type: "complete", exitCode}`, then closes.
- Token payload extension: existing `{path, exp}` tokens get a sibling shape `{liveCmdId, logPath, doneSentinelPath, exp}` differentiated by presence of `liveCmdId`. Existing `/view` flow unchanged.

### Matron-web module (new package: `packages/matron-live-output/`)

A small module that calls `ModuleApi.customComponents.registerMessageRenderer('com.matron.live_output.v1', LiveOutputTile)`.

`LiveOutputTile` renders:

- Header row: monospace `$ <original_command>` + status badge (`running…` while no expiry-passed and no complete frame; `✓ exit 0` / `✗ exit 1` from complete frame; `expired` once `Date.now() > expires_at * 1000`; `not executed` for denial path).
- `<iframe sandbox="allow-scripts" src={viewer_url}>` with initial CSS height `240px`. An expand/collapse toggle in the header swaps height between `240px` (collapsed) and `600px` (expanded). The iframe handles its own internal scroll.
- Once `expires_at` is reached, the component swaps the iframe out for a static "Output expired" placeholder client-side without making an HTTP request.

The module registers via Element's `ModuleApi`. Module-system entrypoint stub at `packages/matron-live-output/src/index.ts`; the loader is what Matron's existing module-system already supports (per `module_system/` in matron-web).

### Matrix event format

```json
{
  "type": "com.matron.live_output.v1",
  "content": {
    "msgtype": "m.text",
    "body": "$ ls -la\n[live output: https://viewer.example/live?token=...]",
    "format": "org.matrix.custom.html",
    "formatted_body": "<a href=\"https://viewer.example/live?token=...\"><code>$ ls -la</code> · view live output</a>",
    "com.matron.live_output": {
      "tool_use_id": "toolu_01ABC...",
      "command": "ls -la",
      "viewer_url": "https://viewer.example/live?token=...",
      "expires_at": 1714750000
    }
  }
}
```

Top-level `type` is custom (not `m.room.message`), so non-Matron clients render it via their unknown-event fallback — typically the `body` field shown as text, which contains the viewer URL the user can click. The `formatted_body` provides a slightly nicer HTML rendering for clients that respect it without recognizing the type.

## Error handling & edge cases

- **Hook absent / hook errors**: pass-through, no event posted, indicator line still renders. Graceful degradation.
- **Command denied at permission gate**: hook may have fired before the deny; bridge posts the event speculatively on `tool_use`. On `tool_result` with denial, bridge writes `.done` sentinel marked `denied`; tile renders "Not executed." Empty log file (if created) cleans up on normal expiry.
- **Output cap (50 MB default)**: `matron-tee` truncates and writes a sentinel line. Viewer's WS client renders "Output truncated at 50 MB" when it sees the sentinel.
- **Long-running commands past expiry**: hard cutoff. Log file deleted; iframe reload returns "Output expired." The command itself continues running in its shell; Claude still sees the final result via stream-json. We just stop showing live output past the TTL.
- **Bridge restart**: orphaned `/tmp/matron-cmd-*` files older than TTL get swept on boot. In-flight commands at the moment of restart lose their live tile (iframe will 404 the WS) but the underlying command keeps running in Claude's shell.
- **WS disconnect / reconnect**: page reconnects with the same token while still valid; viewer streams from offset 0 (backfill) and continues tailing. User sees full content, no gap, possible duplicate of last few lines on a true mid-stream reconnect — acceptable.
- **Subagent (Task tool) Bash invocations**: hook fires for subagent Bash too; tiles post in the same room. Per-room `showBashOutput` toggle applies uniformly. Noted as a potential noise source if subagent invokes many Bash calls; revisit if it becomes a problem.
- **Concurrent commands across rooms**: `tool_use_id` is unique per Claude session; log filenames are fully addressable; no collision risk.
- **Non-Bash tool calls passing through hook**: hook checks `tool_name` and pass-throughs anything that isn't `Bash`.
- **`bash -c "..."` already in command**: hook's `matron-tee` wrapper invokes the original command via `exec`; embedded `bash -c` is just one of many possible argv patterns and works without special handling.

## Configuration

New env vars:

- `MATRON_LIVE_OUTPUT_TTL` (default `14400`, 4 hours) — token expiry and log retention.
- `MATRON_LIVE_OUTPUT_MAX_BYTES` (default `52428800`, 50 MB) — per-command log cap.
- `MATRON_BASH_TEE_ENABLED` (per-spawn) — set by bridge based on per-room `showBashOutput` setting.

New per-room setting:

- `showBashOutput` (default `false`) — toggles whether the hook is enabled and tiles are posted for that room. Stored alongside existing per-room settings (same pattern as `showWorking`).

### Matron-web runtime config

To enable the `LiveOutputTile` renderer in a deployed matron-web instance, add the plugin URL to `config.json`:

```json
{
    "modules": [
        "https://your-bridge-host/plugin/live-output.mjs"
    ]
}
```

The bundle is hosted by the bridge's viewer at `/plugin/live-output.mjs`. Build it via `pnpm --filter @matron/live-output build` in the matron-web checkout (emits `packages/matron-live-output/dist/live-output.mjs`) and ensure the bridge's `MATRON_PLUGIN_DIR` env var (default: `<matron-web>/packages/matron-live-output/dist`) points at the build output.

The bundle is a self-contained ESM file (~55 KB gzipped ~13 KB) that ships its own React + injects its own CSS at load time. Matron-web's plugin loader (`src/vector/init.tsx :: loadPlugins`) dynamic-imports each URL listed in `modules` and calls `ModuleLoader.load()` against the default export — see the `Module` / `ModuleFactory` types in `@element-hq/element-web-module-api`.

## Testing

**Bridge unit/integration tests** (high value):

- Hook output JSON: rewrites `tool_input.command` correctly for various input shapes (quoted args, embedded backticks, multi-line heredocs, `bash -c "..."`, `sh -c "..."`); pass-through for non-Bash tools; pass-through when env var unset.
- `tool_use` handler: detects matron-tee marker, extracts original command for indicator, registers `liveOutputs` entry with correct `expiresAt`, posts a Matrix event of the right type/content.
- `tool_result` handler: writes `.done` sentinel with exit code; handles denial path.
- GC sweep: deletes expired entries' log + sentinel files; removes from map.
- Startup sweep: pre-seeded old log files in temp dir get cleaned at boot; recent ones survive.

**Viewer/WS tests** (medium value):

- Token validation: valid live-output token, expired, tampered, references nonexistent log file (each yields the right HTTP/WS status).
- WS streaming: backfills initial content, tails subsequent appends, terminates on `.done` sentinel with the right close payload.
- Cap enforcement: oversized log gets truncated with sentinel marker visible in stream.

**Matron-web renderer**: manual smoke test in v1, no automated test infrastructure.

**Manual end-to-end checklist** (the real validation):

1. Toggle `showBashOutput` on for a room.
2. Fast command (`ls -la`) — tile appears, completes, shows exit code.
3. Long command (`sleep 5; echo done`) — tile streams "done" after 5 s.
4. Big output (`seq 1 100000`) — tile is scrollable, doesn't break chat layout.
5. Failing command (`false`) — tile shows ✗ exit 1.
6. Cap test (`yes | head -c 60M`) — tile shows "Output truncated at 50 MB".
7. Permission-denied command — tile shows "Not executed."
8. Wait past TTL — tile shows "Output expired"; `/tmp` is clean.
9. Toggle `showBashOutput` off — subsequent commands get the indicator line only, no tile.
10. Federated user / non-Matron client viewing the same room — sees `body` text with clickable viewer URL.

## Assumptions to validate before implementation

- **Claude Code's PreToolUse hook protocol supports modifying `tool_input.command`** via `hookSpecificOutput.updatedInput` (or equivalent). If not, fallback is replacing `$SHELL` with a wrapper. Verify with a 5-minute test before locking the design.
- **Wrapping commands in `matron-tee` does not break Claude's Bash tool semantics**. Specifically: (a) the tool's exit code surfaces correctly through the wrapper, (b) shell-state mutations (e.g., `cd`, env var assignments) work the same as without the wrapper. If Claude's Bash tool uses a persistent shell, the wrapper's subshell may break (a) or (b); the same 5-minute test should exercise a `cd` and a multi-line command to confirm.
- **Matron-web's module system supports `ModuleApi.customComponents.registerMessageRenderer`** at the version we're targeting. Confirmed present in upstream Element Web (`src/modules/customComponentApi.ts:69-75`); confirm Matron's fork hasn't disabled it.
- **`fs.watch` / `chokidar` works for tail-style streaming on the host platform** (Linux). Standard, but worth a smoke test.
