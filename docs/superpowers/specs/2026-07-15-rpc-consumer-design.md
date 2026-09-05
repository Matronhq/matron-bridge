# Agent RPC consumer: `start` + `recent_folders` — design (SP3, bridge side)

**Date:** 2026-07-15
**Status:** implemented — pending deploy (bridge restart required)
**Depends on:** matron-journal's agent RPC relay (merged + deployed;
`docs/protocol.md` "Agent RPC" section and
`docs/superpowers/specs/2026-07-15-agent-rpc-design.md` in that repo)
**Consumed by:** the app's New Chat button and folder picker (SP2 client work)

## Problem

The journal now relays structured client→agent requests: the app can send
`agent_request {method:'start', params:{workdir}}` at this bridge and get a
`{kind:'rpc', request:{...}}` frame on the very WS this module already holds.
The bridge ignores those frames today (the message handler's "all other
inbound frames are intentionally ignored" tail), so the app's New Chat button
has no counterparty: requests time out client-side. This spec makes the
bridge answer.

## Goals

1. Consume `kind:'rpc'` request frames and answer **every** one with an
   `agent_response` — success, method error, or `unknown_method`; a request
   must never be silently dropped once delivered.
2. Implement the v1 vocabulary pinned in the journal spec:
   `recent_folders` and `start`.
3. Zero behavior change for every existing path (text commands, control
   convo, prompts, streams).

## Non-goals

- New journal ops or server changes — the relay is complete.
- `stop`/`list_sessions`/other methods (add later; `unknown_method` covers
  them safely).
- Request dedup (server delivers single-consumer; the app disables its
  button while a request is pending — journal spec's stance).
- The SP3 "button primitives" work (prompt/picker rendering) — separate
  deliverable, unrelated to RPC consumption.

## Design

Three pieces: a dispatch branch in the publisher's message handler, a
`respondRpc` publisher method, and a method-handler table in index.js.

### 1. Frame dispatch (lib/journal-publisher.js)

New option `onRpcRequest` (like `onEvent`/`onStreamResync`). In the
`socket.on('message')` chain, before the ignored-frames tail:

```js
} else if (msg.kind === 'rpc' && msg.request && onRpcRequest) {
  const r = msg.request;
  if (typeof r.request_id === 'string' && Number.isInteger(r.from_device_id)
      && typeof r.method === 'string') {
    try { onRpcRequest(r); }
    catch (e) { warn(`[journal-publisher] onRpcRequest handler threw: ${e.message}`); }
  }
}
```

Malformed request frames (shouldn't exist — the server validates) are
ignored like any unrecognized frame. No cursor interaction: RPC frames carry
no `seq` and never touch `lastSeq`/replay dedup.

### 2. `respondRpc` (lib/journal-publisher.js)

Ephemeral send, exactly the `publishActivity` contract — never queued, never
retried, never replayed; if the socket is down the response is dropped and
the client's own timeout handles it (the journal relay is stateless by
design, and a reconnecting bridge could not usefully answer a stale request
anyway):

```js
respondRpc({ requestId, toDeviceId, ok, result, error }) {
  // guards + JSON.stringify try/catch identical to publishActivity
  const frame = { op: 'agent_response', request_id: requestId, to_device_id: toDeviceId, ok };
  if (ok) frame.result = result ?? null; else frame.error = error;
  ws.send(JSON.stringify(frame));
}
```

The no-op publisher (used when the journal is unconfigured in tests) gains a
`respondRpc() {}` stub alongside `publishActivity`.

### 3. Method handlers (index.js)

`journalHandleRpcRequest(request)` — a small dispatch table; every branch
ends in exactly one `respondRpc` targeting `request.from_device_id` with the
request's `request_id`.

**The answer-every-request guarantee lives HERE, structurally:** the
handler's entire dispatch is wrapped in try/catch, and the catch itself
responds `ok:false, error:{code:'internal', detail:<message>}` (respondRpc
never throws — it swallows internally). The publisher-level catch around
`onRpcRequest` (section 1) is only a last-resort log for the pathological
case where even that response path throws; it must never be the sole thing
standing between a handler bug and a client timeout.

**`recent_folders`** — params ignored. Source of truth is the persisted
session store (`~/.claude-matrix-sessions.json`, records carry
`{workdir, lastUsed}`): dedupe by workdir keeping the max `lastUsed`, sort
newest-first, cap 20. `DEFAULT_WORKDIR` is appended with `last_used: null`
if not already present (the picker's "home" entry even on a fresh box —
`null` means "available, never used here"; the app sorts nulls last).
`~/.claude/projects/` directory names are NOT decoded as a source: the
`/`→`-` encoding is lossy (dashes in real path segments are
indistinguishable), and inventing wrong paths in a picker is worse than
missing rarely-used ones.

```
-> { folders: [ { path: '/home/dan/yearbook-app', last_used: 1784500000000 },
                { path: '/home/dan', last_used: null } ] }
```

Errors: none expected; an unexpected throw answers `{code:'internal'}`.

**`start`** — params `{workdir?, browser?}` (a non-object params is treated
as `{}`). Mirrors the `!start` text command's semantics exactly, minus the
chat reply:

- `workdir` string → `path.resolve(expandHome(workdir))`, must exist and be
  a directory (`fs.statSync`), else `ok:false, error:{code:'bad_workdir',
  detail:<resolved path>}`. Omitted/empty → `DEFAULT_WORKDIR`.
- `browser === true` → `mcpExtras: ['browser']` (same effect as `--browser`);
  anything else → no extras.
- Mint a room key with `newSessionConvoId()` and call
  `const session = createSession(roomKey, workdir, undefined, { mcpExtras })`,
  persisting as `!start` does (originRoomId null — there is no origin chat
  room for an RPC start).
- Success: `{convo_id: session.claudeSessionId}` — **not** the room key.
  The room key is only the bridge's sessions-map/persistence identifier;
  `createInteractiveSessionForRoom` mints its own session UUID and *that*
  (`session.claudeSessionId`) is what every journal frame and the
  `convo_upsert` carry (index.js: "The journal's convo_id is the Claude
  session UUID"). Returning the room key would send the app to a
  conversation id the journal never uses.
- Interactive mode (the default, and what every dev box runs) sets
  `claudeSessionId` synchronously at spawn. If the resolved mode is
  print-mode the id is not known at return: kill the just-created session
  (the `!stop` teardown) and answer `ok:false,
  error:{code:'unsupported_mode', detail:'print-mode bridges cannot answer
  start'}` — v1 explicitly does not support RPC-start on print-mode
  bridges.
- The `convo_upsert` announcing the new conversation flows on the journal
  as usual; per the journal spec the app must tolerate either ordering
  between that and this response.
- `createSession` throwing → `ok:false, error:{code:'spawn_failed',
  detail:<message>}`.

**Anything else** → `ok:false, error:{code:'unknown_method'}`.

Handler wiring: `createJournalPublisher({ ..., onRpcRequest:
journalHandleRpcRequest })` next to the existing `onEvent` wiring.

## Security analysis

The journal already guarantees every delivered request comes from a client
device of this bridge's own user (server-side scoping + stamped
`from_device_id`), so the bridge extends exactly the trust it already
extends to text commands in the control convo — `start` here can do nothing
`/start ~/dir` couldn't. Workdir validation is unchanged from the text path
(resolve + must-be-directory); no shell interpolation anywhere (`workdir`
goes to `spawn`'s `cwd`). `recent_folders` exposes only paths the user's own
sessions already used. Responses go only to the stamped requester device.
The 16 KiB response cap is enforced server-side; 20 folder entries sit far
under it.

## Testing

Repo-idiomatic `node:test` files:

- `test/journal-rpc-dispatch.test.js` (publisher): an injected fake WS
  receiving `{kind:'rpc', request:{...}}` calls `onRpcRequest` with the
  request; malformed shapes (no request, bad request_id/from_device_id/
  method) don't; a throwing handler warns and doesn't kill the socket
  handler; RPC frames never advance the persisted cursor. `respondRpc`
  sends the exact `agent_response` frame when connected; drops silently
  when disconnected/closed; survives an unserializable `result`; no-op
  publisher stub exists.
- `test/journal-rpc-handlers.test.js` (index.js handler, with
  `createSession`/`persistSession`/store access stubbed per existing test
  idioms): `recent_folders` dedupes/sorts/caps and appends
  `DEFAULT_WORKDIR` with `last_used:null`; `start` happy path returns the
  stubbed session's `claudeSessionId` (NOT the room key passed to
  `createSession`) and passes the resolved workdir + mcpExtras through;
  `bad_workdir` on missing dir; `spawn_failed` on a throwing
  `createSession`; a stubbed session without `claudeSessionId` →
  `unsupported_mode` and the session is torn down; `browser:true` →
  `['browser']`; unknown method → `unknown_method`; a handler-internal
  throw (e.g. the persisted-store read throwing) still answers exactly one
  `{code:'internal'}` response; every branch responds exactly once to
  `from_device_id`.

## Rollout

1. This repo: dispatch + respondRpc + handlers + tests, one PR.
2. Deploy = `git pull` + **bridge restart, which kills active Claude
   sessions** — schedule it deliberately (do NOT auto-restart from within a
   bridge-hosted session).
3. App: New Chat button → pick a `connected` agent → optional
   `recent_folders` picker → `agent_request start` → navigate to `convo_id`
   (or the `convo_upsert`, whichever lands first).

## Open questions

1. Should `start` also accept `resume: <session-id>`? (Recommend: no for
   v1 — the app's resume UX isn't designed yet; `unknown_method`-style
   extension is cheap later.)
