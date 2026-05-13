# Live Output Renderer for matron-web

## Problem

The bridge already emits `chat.matron.live_output.v1` Matrix events for every Bash command in rooms where `showBashOutput` is on. The events carry a viewer URL and metadata for an inline streaming-output tile. The bridge has the hooks, the in-memory store, the GC sweep, and the `/live` + `/live/ws` viewer endpoints — all built and running.

The client side is missing. Today these events reach matron-web's timeline and fall through `EventTileFactory`'s `noEventFactoryFactory()` fallback, so the tile never renders. Users only see the standard `🔧 \`cmd\`` tool-call indicator, not the streaming output the design intended.

This spec covers the matron-web work needed to consume those events and render the streaming-output tile inline.

## Approach

A small React component (`MLiveOutputBody`) opens a WebSocket directly to the bridge's `/live/ws` endpoint using the `viewer_url` token already present in the event content. Streamed output appends into a styled `<pre>`; a JSON `complete` frame transitions the tile to its terminal state. The renderer is built directly into matron-web's `src/` tree (not shipped as a runtime plugin), wired in via two small touchpoints in `EventTileFactory` and `MessageEvent` that mirror the existing `MATRON_BUTTONS` pattern.

The bridge does not change beyond bumping the default TTL.

## Scope

**In scope:**

- matron-web — new `MLiveOutputBody` component, new event-type constants, two integration points (`EventTileFactory`, `MessageEvent`), CSS.
- matron-desktop — automatic: matron-desktop is an Electron wrapper around the matron-web build, so the renderer ships with no extra work.
- claude-matrix-bridge — single one-line default change: `MATRON_LIVE_OUTPUT_TTL` 14400 → 86400 (4 hr → 24 hr).

**Out of scope:**

- matron-iOS / matron-ios — native iOS clients use the existing `body` fallback (a URL the user can tap). A native renderer would need a separate spec for the SwiftUI side.
- Stock Element clients (Element Web, Element X) — these silently hide the custom event type. Acceptable: matron-web is the only target client.
- TTL-triggered Matrix redaction — the Matrix event remains in chat history showing the command and an `expired` badge after the log on disk is deleted. The output itself never enters chat history.
- Live-output for any tool other than `Bash`.

## Decisions locked during brainstorming

- **Distribution**: built directly into matron-web `src/`, not a separate workspace package or runtime plugin.
- **Render approach**: native React component with its own `WebSocket` client (not a sandboxed iframe).
- **Client scope**: matron-web only; matron-desktop covered via the Electron wrapper.
- **TTL**: default bumped to 86400 (24 hr); env-var override still honoured.
- **Event type**: bridge keeps the custom top-level `chat.matron.live_output.v1`. Non-matron clients drop the event entirely. Acceptable trade-off for matron-only deployments.
- **Redaction at TTL**: not done. Event lingers in history with an `expired` badge.
- **Tile UI defaults**: collapsed by default (240px max-height) with click-to-expand to 600px; sticky-bottom auto-scroll; status badge in header; `$ <cmd>` rendered as monospace in header.

## Architecture

```
Bridge (claude-matrix-bridge)
  │ sendEvent(roomId, "chat.matron.live_output.v1", {
  │   msgtype: "m.text",
  │   body: "$ cmd\n[live output: URL]",
  │   format: "org.matrix.custom.html",
  │   formatted_body: "<a href=…>…</a>",
  │   "chat.matron.live_output": {
  │     tool_use_id, command, viewer_url, expires_at
  │   }
  │ })
  ▼
matron-web src/events/EventTileFactory.tsx
  │ EVENT_TILE_TYPES.get("chat.matron.live_output.v1") → MessageEventFactory
  ▼
src/components/views/messages/MessageEvent.tsx
  │ render() detects content["chat.matron.live_output"]
  │ short-circuits and returns <MLiveOutputBody mxEvent={…} />
  ▼
src/components/views/messages/MLiveOutputBody.tsx
  │ useEffect: opens WebSocket(viewer_url with http→ws and /live→/live/ws)
  │ onmessage: appends text frames; on `{type:"complete",…}` JSON frame → terminal state
  │ auto-expiry: setTimeout((expires_at*1000)-now) → status=expired
  ▼
Bridge viewer /live/ws (existing)
  │ validates HMAC token (1008 close on failure)
  │ pumps {type:"data", chunk} JSON frames from log file (backfill + tail)
  │ on done-sentinel: final pump + {type:"complete", exitCode, denied, truncated} + close 1000
  ▼
User sees: header ($ cmd + status badge + expand toggle) and streaming <pre> body
```

## Integration points in matron-web

### 1. `src/matron/EventTypes.ts` — extend with two constants

```ts
export const MATRON_LIVE_OUTPUT_EVENT_TYPE = "chat.matron.live_output.v1";
export const MATRON_LIVE_OUTPUT_CONTENT_KEY = "chat.matron.live_output";
```

### 2. `src/events/EventTileFactory.tsx` — register the custom top-level type

Add to the `EVENT_TILE_TYPES` map (around line 105):

```ts
[MATRON_LIVE_OUTPUT_EVENT_TYPE, MessageEventFactory],
```

This routes the custom event type through the standard `MessageEvent` component. Without it, the event falls through to `noEventFactoryFactory()` and renders nothing.

### 3. `src/components/views/messages/MessageEvent.tsx` — branch on the content key

Inside `render()`, right next to the existing `MATRON_BUTTONS` check (currently line 251):

```ts
if (!this.props.mxEvent.isRedacted() && content[MATRON_LIVE_OUTPUT_CONTENT_KEY]) {
    return <MLiveOutputBody mxEvent={this.props.mxEvent} />;
}
```

Order matters only if buttons and live-output ever co-exist on the same event, which they don't.

### 4. `src/components/views/messages/MLiveOutputBody.tsx` — the tile

New file. ~150–200 lines. No new npm dependencies (uses the browser's native `WebSocket`). Detailed in the component section below.

### 5. `res/css/views/messages/_MLiveOutputBody.pcss` — styles

New file. Standard matron-web PCSS pattern; uses existing theme tokens for colour, font, spacing.

## Component: `MLiveOutputBody`

### Props

```ts
interface MLiveOutputBodyProps {
    mxEvent: MatrixEvent;
}
```

### Internal state

```ts
type Status = "connecting" | "running" | "complete" | "expired" | "denied" | "error";
const [status, setStatus] = useState<Status>("connecting");
const [exitCode, setExitCode] = useState<number | null>(null);
const [truncated, setTruncated] = useState(false);
const [output, setOutput] = useState<string>("");
const [expanded, setExpanded] = useState(false);
const [stickyBottom, setStickyBottom] = useState(true);
const preRef = useRef<HTMLPreElement>(null);
```

### Lifecycle

On mount (`useEffect` keyed on `mxEvent.getId()`):

1. Read `{ command, viewer_url, expires_at }` from `mxEvent.getContent()[MATRON_LIVE_OUTPUT_CONTENT_KEY]`.
2. If `Date.now() >= expires_at * 1000` → `setStatus("expired")` and return without opening a WebSocket.
3. Derive WS URL: replace `^http` → `ws` in `viewer_url`, swap the path from `/live` → `/live/ws` (preserve the `token=` query string).
4. `new WebSocket(wsUrl)`.
5. `ws.onopen` → `setStatus("running")`.
6. `ws.onmessage` → every frame is JSON. `JSON.parse(ev.data)` then dispatch on `frame.type`:
   - `"data"` → append `frame.chunk` to `output`.
   - `"complete"` → `setExitCode(frame.exitCode)`, `setTruncated(!!frame.truncated)`. If `frame.denied` → `setStatus("denied")`, otherwise `setStatus("complete")`. The bridge closes the socket immediately after; no need to call `ws.close()` here.
   - Any other `type` (forward-compat): ignore.
   - Parse error: log to console and ignore.
7. `ws.onclose` → if status is still `"connecting"` or `"running"` and the close code isn't `1000` (normal), transition to `"error"`. Code `1008` (`invalid token`) also surfaces as `"error"`. Normal close after a `complete` frame is expected — leave status as-is.
8. `ws.onerror` → same as unexpected close.
9. Arm a `setTimeout` for `(expires_at * 1000) - Date.now()` ms that flips status to `"expired"` and closes the WS if still open.
10. Cleanup on unmount: `clearTimeout(expiryTimer)`, `ws.close()`.

### Auto-scroll

- `useEffect` watching `output` and `stickyBottom`: if `stickyBottom`, set `preRef.current.scrollTop = preRef.current.scrollHeight`.
- `onScroll` handler on `<pre>`: `setStickyBottom(scrollTop + clientHeight >= scrollHeight - 8)`. Threshold 8 px so a near-bottom position counts.

### Render shape (JSX outline)

```tsx
<div className="mx_MLiveOutputBody" data-expanded={expanded} data-status={status}>
    <header onClick={() => setExpanded(e => !e)} role="button" tabIndex={0}>
        <code className="mx_MLiveOutputBody_cmd">$ {command}</code>
        <span className="mx_MLiveOutputBody_status">{statusLabel}</span>
        <button
            aria-label={expanded ? "Collapse" : "Expand"}
            className="mx_MLiveOutputBody_toggle"
            onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
        >
            {expanded ? "−" : "+"}
        </button>
    </header>
    {(status !== "expired" && status !== "denied") && (
        <pre ref={preRef} className="mx_MLiveOutputBody_output" onScroll={onScroll}>
            {output}
            {truncated && "\n[output truncated]"}
        </pre>
    )}
    {status === "expired" && <p className="mx_MLiveOutputBody_placeholder">Output expired</p>}
    {status === "denied"  && <p className="mx_MLiveOutputBody_placeholder">Command not executed</p>}
</div>
```

### Status labels

| State | Badge text |
|---|---|
| `connecting` | `connecting…` |
| `running` | `running…` |
| `complete`, `exitCode === 0`, `truncated` false | `✓ exit 0` |
| `complete`, `exitCode === 0`, `truncated` true | `✓ exit 0 · truncated` |
| `complete`, `exitCode !== 0` | `✗ exit N` |
| `denied` | `not executed` |
| `expired` | `expired` |
| `error` | `⚠ disconnected` |

### Styling

`res/css/views/messages/_MLiveOutputBody.pcss`:

- Container: rounded border, subtle background colour from existing matron theme tokens. Margin matching adjacent message tiles.
- Header: flex row, monospace command, right-aligned status + toggle. Cursor pointer.
- `.mx_MLiveOutputBody_output`: `max-height: 240px` by default. Selector `[data-expanded="true"] .mx_MLiveOutputBody_output` overrides to `max-height: 600px`. `overflow-y: auto`, monospace font, theme-foreground colour, theme-background background.
- Placeholders (`expired` / `denied`): italic, muted theme colour.

Pick up dark/light theme via existing matron-web CSS variables — no theme-detection JS needed.

## Matrix event format (unchanged from bridge)

```json
{
  "type": "chat.matron.live_output.v1",
  "content": {
    "msgtype": "m.text",
    "body": "$ ls -la\n[live output: https://viewer.example/live?token=...]",
    "format": "org.matrix.custom.html",
    "formatted_body": "<a href=\"https://viewer.example/live?token=...\"><code>$ ls -la</code> · view live output</a>",
    "chat.matron.live_output": {
      "tool_use_id": "toolu_01ABC...",
      "command": "ls -la",
      "viewer_url": "https://viewer.example/live?token=...",
      "expires_at": 1714750000
    }
  }
}
```

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| `expires_at` already in the past at mount | Skip WS connect; render `expired`. |
| `expires_at` passes mid-stream | `setTimeout` flips to `expired` and closes WS. |
| WS closes before `complete` frame (non-1000 close code) | `status = error` (`⚠ disconnected`). |
| Malformed JSON frame | Logged and ignored; streaming continues. |
| Token expired / invalid at WS open | Bridge closes with code `1008` and reason `"invalid token"`; `status = error`. |
| Forward-compat: unknown `frame.type` | Ignored. |
| User scrolls up | `stickyBottom = false`; new chunks append but viewport doesn't move. Scrolling back to bottom re-engages sticky. |
| 50 MB cap hit (server-side) | `complete` frame carries `truncated: true`; tile renders truncation suffix and `truncated` in the status. |
| Event redacted | `MessageEvent`'s redaction guard short-circuits before `MLiveOutputBody` instantiates. |
| Component unmounts mid-stream | Cleanup closes WS. No leaked sockets. |
| Component re-mounts (scroll back into view) | Fresh WS connect. Viewer backfills from offset 0; possible duplicate of last few lines acceptable. |
| Non-matron-web client (Element Web/X, federated user) | Event hidden by the unknown-type fallback. No tile, no body text. Acceptable — matron-web is the only target client. |

## Bridge change (one line)

`/Users/danbarker/Dev/claude-matrix-bridge/index.js` — bump the live-output TTL default from 4 h to 24 h:

```js
// before
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '14400', 10);
// after
const _rawLiveOutputTtl = parseInt(process.env.MATRON_LIVE_OUTPUT_TTL || '86400', 10);
```

Env-var override remains. No other bridge change needed.

## Testing

matron-web uses jest (`nx test:unit`). New tests under `test/unit-tests/components/views/messages/MLiveOutputBody-test.tsx`:

- Renders `connecting`, then `running` once WS opens.
- Appends streamed text chunks to the `<pre>`.
- Transitions to `complete` + `✓ exit 0` on a JSON `complete` frame with `exitCode: 0`.
- Transitions to `✗ exit 1` for non-zero exit codes.
- Transitions to `denied` when `complete` frame has `denied: true`.
- Renders `expired` immediately and skips WS connect when `expires_at` is in the past at mount.
- Flips to `expired` when the auto-expiry timer fires mid-stream.
- Renders the truncation suffix when `complete` carries `truncated: true`.
- Auto-scrolls to bottom while `stickyBottom`; does not auto-scroll after user scrolls up; re-engages when scrolled back.
- Expand/collapse toggles `data-expanded` and the `max-height` styling.
- Closes WS on unmount.

Use `mock-socket` to drive the WebSocket lifecycle deterministically. (Verify it's already in element-web's deps; if not, add it — it's the standard tool for this pattern.)

**Light integration check:** test that `EventTileFactory` routes a `chat.matron.live_output.v1` event to `MessageEventFactory` and that `MessageEvent` dispatches to `MLiveOutputBody` when the content key is present. Mirror the patterns used to cover `MButtonGroupBody`.

**Manual end-to-end** (one-time, not automated):

1. Bridge running with `MATRON_LIVE_OUTPUT_TTL=60` temporarily (faster expiry test).
2. Toggle `showBashOutput` on for a room.
3. `ls -la` — tile appears, streams, transitions to `✓ exit 0`.
4. `sleep 5 && echo done` — tile streams `done` after 5 s.
5. `seq 1 100000` — tile is scrollable; chat layout unaffected.
6. `false` — tile shows `✗ exit 1`.
7. `yes | head -c 60M` — tile shows truncation suffix.
8. Wait 60 s past completion — tile shows `expired`.
9. `showBashOutput` off — no tiles posted.
10. View same room on stock Element Web — events silently hidden.

## Assumptions to validate before implementation

- **`mock-socket` (or an equivalent WebSocket stub) is available in matron-web's jest setup.** If not, the first implementation task is to add it.
- **WebSocket protocol on `/live/ws` is all-JSON frames.** Confirmed against `viewer/server.js`'s `handleLiveWs`: streaming frames are `{type:"data", chunk: string}`, terminal frame is `{type:"complete", exitCode, denied, truncated}`, close code `1000` on success and `1008` on invalid token.
- **PCSS pipeline picks up new files automatically.** matron-web inherits element-web's build; check that adding `res/css/views/messages/_MLiveOutputBody.pcss` only requires an import in the matching `_messages.pcss` aggregator.
- **`MessageEvent.render()` short-circuits cleanly when returning a custom component.** Confirmed via the existing `MATRON_BUTTONS` precedent at `src/components/views/messages/MessageEvent.tsx:251`.
- **`viewer_url` in production deploys is reachable from the browser.** The bridge serves it via Cloudflare Tunnel; if a deploy ever serves the viewer on a different origin than matron-web, CORS / mixed-content rules apply. Worth a smoke check when first deployed.
