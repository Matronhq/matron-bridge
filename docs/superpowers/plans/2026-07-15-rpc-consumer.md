# Agent RPC Consumer Implementation Plan (SP3: start + recent_folders)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the bridge answer journal agent-RPC requests (`start`, `recent_folders`) per `docs/superpowers/specs/2026-07-15-rpc-consumer-design.md`, so the app's New Chat button works end-to-end.

**Architecture:** Three layers. (1) `lib/journal-publisher.js` gains an `onRpcRequest` dispatch branch and an ephemeral `respondRpc` method (the `publishActivity` contract). (2) A new injectable factory `lib/journal-rpc.js` holds all method logic — validation, folder aggregation, the answer-every-request guarantee — with session machinery injected. (3) `index.js` wires the two together with a thin `journalStartSessionForRpc` that replicates the `!start` body minus chat replies.

**Tech Stack:** Node 20+, `ws`, vitest (`npm test` = `vitest run`; `npm run check` for syntax; `npm run lint`).

## Global Constraints

- The spec is the contract: `docs/superpowers/specs/2026-07-15-rpc-consumer-design.md`. Read it first. If code and plan disagree with the spec, the spec wins — stop and flag it.
- `start` responds `{convo_id: session.claudeSessionId}` — NEVER the room key passed to `createSession`.
- Every delivered request gets exactly one response; the guarantee is structural in the handler (whole dispatch wrapped, catch answers `{code:'internal'}`).
- `respondRpc` follows the publisher's fail-open contract: never throws, never queues, never retries.
- RPC frames never touch the cursor/replay machinery (no `seq`).
- Work only in your assigned git worktree — NEVER touch `/home/danbarker/matron-bridge` (live service checkout). NEVER restart `matron-bridge.service`.
- Before every commit: `npm test` (vitest, all green), `npm run check`, `npm run lint`.
- Comment style: match lib/journal-publisher.js — contracts and invariants, not narration.

---

### Task 1: Publisher — `onRpcRequest` dispatch + `respondRpc`

**Files:**
- Modify: `lib/journal-publisher.js`
- Test: `test/journal-rpc-dispatch.test.js` (create)

**Interfaces:**
- Consumes: existing message-handler chain, `warn`, `connected`/`closed`/`ws` closure state.
- Produces: factory option `onRpcRequest(request)`; method `respondRpc({requestId, toDeviceId, ok, result, error})`; noop stub `respondRpc() {}`. Task 3 wires both.

- [ ] **Step 1: Write the failing tests**

Create `test/journal-rpc-dispatch.test.js`. Copy the minimal fake-server harness from `test/journal-publisher.test.js` (silentLog, delay, waitFor, startFakeServer — trim startFakeServer to just what's used; keep `connections` exposed so the server can push frames to the client):

```js
import { describe, it, expect } from 'vitest';
import { WebSocketServer } from 'ws';
import { createJournalPublisher } from '../lib/journal-publisher.js';

const silentLog = { warn: () => {}, error: () => {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out');
    await delay(intervalMs);
  }
}

function startFakeServer() {
  const wss = new WebSocketServer({ port: 0 });
  const received = [];
  const connections = [];
  wss.on('connection', (ws) => {
    connections.push(ws);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello') {
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: 0 }));
        return;
      }
      received.push(msg);
    });
  });
  return new Promise((resolve) => {
    wss.on('listening', () => resolve({
      url: `ws://127.0.0.1:${wss.address().port}/ws`,
      received,
      connections,
      push: (frame) => connections[0].send(JSON.stringify(frame)),
      close: () => new Promise((r) => wss.close(r)),
    }));
  });
}

describe('journal-publisher agent-RPC', () => {
  it('dispatches well-formed rpc request frames to onRpcRequest', async () => {
    const server = await startFakeServer();
    const seen = [];
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog, onRpcRequest: (r) => seen.push(r) });
    await waitFor(() => server.connections.length === 1);
    await delay(50); // hello_ok round-trip
    const request = { request_id: 'r1', from_device_id: 4, method: 'recent_folders', params: {} };
    server.push({ kind: 'rpc', request });
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual(request);
    pub.close();
    await server.close();
  });

  it('ignores malformed rpc frames', async () => {
    const server = await startFakeServer();
    const seen = [];
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog, onRpcRequest: (r) => seen.push(r) });
    await waitFor(() => server.connections.length === 1);
    await delay(50);
    server.push({ kind: 'rpc' });                                                        // no request
    server.push({ kind: 'rpc', request: null });                                         // null request
    server.push({ kind: 'rpc', request: { from_device_id: 4, method: 'x' } });           // no request_id
    server.push({ kind: 'rpc', request: { request_id: 'r', from_device_id: '4', method: 'x' } }); // non-int device
    server.push({ kind: 'rpc', request: { request_id: 'r', from_device_id: 4 } });       // no method
    // then a valid one proves the socket survived all of the above
    server.push({ kind: 'rpc', request: { request_id: 'ok', from_device_id: 4, method: 'm' } });
    await waitFor(() => seen.length === 1);
    expect(seen[0].request_id).toBe('ok');
    pub.close();
    await server.close();
  });

  it('a throwing handler warns and does not kill the socket handler', async () => {
    const server = await startFakeServer();
    const warnings = [];
    const seen = [];
    const pub = createJournalPublisher({
      url: server.url, token: 't',
      log: { warn: (m) => warnings.push(m), error: () => {} },
      onRpcRequest: (r) => { seen.push(r); if (r.request_id === 'boom') throw new Error('boom'); },
    });
    await waitFor(() => server.connections.length === 1);
    await delay(50);
    server.push({ kind: 'rpc', request: { request_id: 'boom', from_device_id: 4, method: 'm' } });
    await waitFor(() => warnings.some((w) => w.includes('onRpcRequest handler threw')));
    server.push({ kind: 'rpc', request: { request_id: 'after', from_device_id: 4, method: 'm' } });
    await waitFor(() => seen.length === 2);
    pub.close();
    await server.close();
  });

  it('rpc frames do not advance the input cursor (a later journal frame still delivers)', async () => {
    const server = await startFakeServer();
    const events = [];
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog, onEvent: (e) => events.push(e), onRpcRequest: () => {} });
    await waitFor(() => server.connections.length === 1);
    await delay(50);
    // an rpc frame with a bogus high seq must not poison replay dedup
    server.push({ kind: 'rpc', seq: 999, request: { request_id: 'r', from_device_id: 4, method: 'm' } });
    server.push({ kind: 'journal', seq: 1, convo_id: 'c', type: 'text', sender: 'user:dan', payload: { body: 'hi' } });
    await waitFor(() => events.length === 1);
    expect(events[0].seq).toBe(1);
    pub.close();
    await server.close();
  });

  it('respondRpc sends the exact agent_response frames for ok and error', async () => {
    const server = await startFakeServer();
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog });
    await waitFor(() => server.connections.length === 1);
    await delay(50);
    pub.respondRpc({ requestId: 'r1', toDeviceId: 4, ok: true, result: { convo_id: 'abc' } });
    pub.respondRpc({ requestId: 'r2', toDeviceId: 4, ok: false, error: { code: 'bad_workdir', detail: '/nope' } });
    await waitFor(() => server.received.length === 2);
    expect(server.received[0]).toEqual({ op: 'agent_response', request_id: 'r1', to_device_id: 4, ok: true, result: { convo_id: 'abc' } });
    expect(server.received[1]).toEqual({ op: 'agent_response', request_id: 'r2', to_device_id: 4, ok: false, error: { code: 'bad_workdir', detail: '/nope' } });
    pub.close();
    await server.close();
  });

  it('respondRpc while disconnected drops silently, never throws', async () => {
    const pub = createJournalPublisher({ url: 'ws://127.0.0.1:1/ws', token: 't', log: silentLog });
    expect(() => pub.respondRpc({ requestId: 'r', toDeviceId: 4, ok: true, result: {} })).not.toThrow();
    pub.close();
  });

  it('respondRpc drops an unserializable result with a warning, never throws', async () => {
    const server = await startFakeServer();
    const warnings = [];
    const pub = createJournalPublisher({ url: server.url, token: 't', log: { warn: (m) => warnings.push(m), error: () => {} } });
    await waitFor(() => server.connections.length === 1);
    await delay(50);
    const circular = {}; circular.self = circular;
    expect(() => pub.respondRpc({ requestId: 'r', toDeviceId: 4, ok: true, result: circular })).not.toThrow();
    await waitFor(() => warnings.some((w) => w.includes('unserializable agent_response')));
    expect(server.received.length).toBe(0);
    pub.close();
    await server.close();
  });
});
```

Also append, inside the same `describe` block (`createJournalPublisher({url:null})` returns the no-op — verified at lib/journal-publisher.js:139-143):

```js
  it('the disabled no-op publisher has a respondRpc stub', () => {
    const noop = createJournalPublisher({ url: null, token: null, log: silentLog });
    expect(typeof noop.respondRpc).toBe('function');
    expect(() => noop.respondRpc({ requestId: 'r', toDeviceId: 1, ok: true })).not.toThrow();
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/journal-rpc-dispatch.test.js`
Expected: FAIL — `onRpcRequest` is never called (frames ignored) and `pub.respondRpc is not a function`.

- [ ] **Step 3: Implement**

In `lib/journal-publisher.js`:

(a) `noopPublisher()` gains, next to `publishStatus() {}`:

```js
    respondRpc() {},
```

(b) Factory options, immediately after `onStreamResync,`:

```js
  // Inbound agent-RPC dispatch (docs/superpowers/specs/
  // 2026-07-15-rpc-consumer-design.md): when set, every inbound
  // `{kind:'rpc', request:{...}}` frame whose request is well-formed
  // (string request_id, integer from_device_id, string method) is handed to
  // this callback. Unset: rpc frames are ignored like any other
  // unrecognised frame. RPC frames carry no seq and never touch the
  // cursor/replay machinery.
  onRpcRequest,
```

(c) In `socket.on('message')`, insert between the `stream_resync` branch and the `msg.kind === 'journal'` branch:

```js
      } else if (msg.kind === 'rpc' && onRpcRequest) {
        const r = msg.request;
        if (r && typeof r === 'object' && typeof r.request_id === 'string'
            && Number.isInteger(r.from_device_id) && typeof r.method === 'string') {
          try {
            onRpcRequest(r);
          } catch (e) {
            warn(`[journal-publisher] onRpcRequest handler threw: ${e.message}`);
          }
        }
```

(d) In the returned method table, immediately after `publishStatus`:

```js
    // Agent-RPC response — EPHEMERAL, the publishActivity contract exactly:
    // never queued, never retried, never replayed. The journal relay is
    // stateless and the requesting client owns its timeout, so a response
    // that can't go out right now is worthless by the time we reconnect.
    // The answer-every-request guarantee lives in the HANDLER
    // (lib/journal-rpc.js), which relies on this method never throwing.
    respondRpc({ requestId, toDeviceId, ok, result, error }) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'agent_response', request_id: requestId, to_device_id: toDeviceId, ok: !!ok };
        if (ok) frame.result = result ?? null;
        else frame.error = error;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable agent_response frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] respondRpc failed: ${e.message}`);
      }
    },
```

Adapt the closure variable names (`closed`/`connected`/`ws`/`warn`) to exactly what `publishActivity` in this file uses — copy its guard line verbatim.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/journal-rpc-dispatch.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + checks, then commit**

Run: `npm test` (all green), `npm run check`, `npm run lint`.

```bash
git add lib/journal-publisher.js test/journal-rpc-dispatch.test.js
git commit -m "feat: onRpcRequest dispatch + ephemeral respondRpc in journal publisher"
git push
```

---

### Task 2: `lib/journal-rpc.js` — method handlers

**Files:**
- Create: `lib/journal-rpc.js`
- Test: `test/journal-rpc-handlers.test.js` (create)

**Interfaces:**
- Consumes: nothing from other tasks (pure factory; injected collaborators).
- Produces: `createRpcRequestHandler({respondRpc, startSession, stopSession, listPersistedSessions, defaultWorkdir, expandHome, statSync?, log?}) -> handleRpcRequest(request)`. Task 3 wires it.

- [ ] **Step 1: Write the failing tests**

Create `test/journal-rpc-handlers.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { createRpcRequestHandler } from '../lib/journal-rpc.js';

const silentLog = { warn: () => {}, error: () => {} };
const REQ = (method, params, id = 'r1') => ({ request_id: id, from_device_id: 7, method, params });

function harness(overrides = {}) {
  const responses = [];
  const handler = createRpcRequestHandler({
    respondRpc: (args) => responses.push(args),
    startSession: () => ({ claudeSessionId: 'session-uuid-1' }),
    stopSession: () => {},
    listPersistedSessions: () => [],
    defaultWorkdir: '/home/dan',
    expandHome: (p) => p.replace(/^~(?=\/|$)/, '/home/dan'),
    statSync: () => ({ isDirectory: () => true }),
    log: silentLog,
    ...overrides,
  });
  return { handler, responses };
}

describe('recent_folders', () => {
  it('dedupes by workdir keeping max lastUsed, sorts newest-first, caps at 20, appends default', () => {
    const records = [];
    for (let i = 0; i < 25; i++) records.push({ workdir: `/w/${i}`, lastUsed: 1000 + i });
    records.push({ workdir: '/w/24', lastUsed: 5 });          // duplicate, older — must not demote /w/24
    records.push({ workdir: '', lastUsed: 99999 });           // junk — skipped
    records.push({ notAWorkdir: true });                      // junk — skipped
    const { handler, responses } = harness({ listPersistedSessions: () => records });
    handler(REQ('recent_folders', {}));
    expect(responses).toHaveLength(1);
    const { ok, result } = responses[0];
    expect(ok).toBe(true);
    expect(result.folders).toHaveLength(21); // 20 capped history + appended default
    expect(result.folders[0]).toEqual({ path: '/w/24', last_used: 1024 });
    expect(result.folders[19]).toEqual({ path: '/w/5', last_used: 1005 });
    expect(result.folders[20]).toEqual({ path: '/home/dan', last_used: null });
  });

  it('does not duplicate the default workdir when history already has it', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/home/dan', lastUsed: 42 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders).toEqual([{ path: '/home/dan', last_used: 42 }]);
  });

  it('a record without lastUsed surfaces as last_used null and sorts last', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => [{ workdir: '/a' }, { workdir: '/b', lastUsed: 10 }],
    });
    handler(REQ('recent_folders', {}));
    expect(responses[0].result.folders.map((f) => f.path)).toEqual(['/b', '/a', '/home/dan']);
    expect(responses[0].result.folders[1].last_used).toBe(null);
  });
});

describe('start', () => {
  it('happy path: resolves ~ workdir, passes mcpExtras, responds with claudeSessionId (never the room key)', () => {
    const calls = [];
    const { handler, responses } = harness({
      startSession: (args) => { calls.push(args); return { claudeSessionId: 'the-real-convo-id' }; },
    });
    handler(REQ('start', { workdir: '~/yearbook-app', browser: true }));
    expect(calls).toEqual([{ workdir: '/home/dan/yearbook-app', mcpExtras: ['browser'] }]);
    expect(responses).toEqual([{ requestId: 'r1', toDeviceId: 7, ok: true, result: { convo_id: 'the-real-convo-id' } }]);
  });

  it('omitted workdir uses the default; browser omitted means no extras', () => {
    const calls = [];
    const { handler } = harness({
      startSession: (args) => { calls.push(args); return { claudeSessionId: 'x' }; },
    });
    handler(REQ('start', {}));
    handler(REQ('start', undefined, 'r2')); // non-object params treated as {}
    expect(calls).toEqual([
      { workdir: '/home/dan', mcpExtras: [] },
      { workdir: '/home/dan', mcpExtras: [] },
    ]);
  });

  it('bad_workdir on a missing or non-directory path, with the resolved path as detail', () => {
    const { handler, responses } = harness({
      statSync: () => { throw new Error('ENOENT'); },
    });
    handler(REQ('start', { workdir: '/nope' }));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'bad_workdir', detail: '/nope' } });

    const { handler: h2, responses: r2 } = harness({
      statSync: () => ({ isDirectory: () => false }),
    });
    h2(REQ('start', { workdir: '/a-file' }));
    expect(r2[0].error.code).toBe('bad_workdir');
  });

  it('spawn_failed when startSession throws', () => {
    const { handler, responses } = harness({
      startSession: () => { throw new Error('claude not found'); },
    });
    handler(REQ('start', {}));
    expect(responses[0].error).toEqual({ code: 'spawn_failed', detail: 'claude not found' });
  });

  it('unsupported_mode tears the session down when claudeSessionId is missing', () => {
    const stopped = [];
    const orphan = { claudeSessionId: null };
    const { handler, responses } = harness({
      startSession: () => orphan,
      stopSession: (s) => stopped.push(s),
    });
    handler(REQ('start', {}));
    expect(stopped).toEqual([orphan]);
    expect(responses[0].error.code).toBe('unsupported_mode');
  });
});

describe('dispatch guarantees', () => {
  it('unknown methods answer unknown_method', () => {
    const { handler, responses } = harness();
    handler(REQ('stop_session', {}));
    expect(responses[0]).toEqual({ requestId: 'r1', toDeviceId: 7, ok: false, error: { code: 'unknown_method' } });
  });

  it('a handler-internal throw answers exactly one internal response', () => {
    const { handler, responses } = harness({
      listPersistedSessions: () => { throw new Error('store corrupt'); },
    });
    handler(REQ('recent_folders', {}));
    expect(responses).toHaveLength(1);
    expect(responses[0].error).toEqual({ code: 'internal', detail: 'store corrupt' });
  });

  it('every branch responds exactly once to from_device_id', () => {
    const { handler, responses } = harness();
    handler(REQ('recent_folders', {}, 'a'));
    handler(REQ('start', {}, 'b'));
    handler(REQ('nope', {}, 'c'));
    expect(responses.map((r) => [r.requestId, r.toDeviceId])).toEqual([['a', 7], ['b', 7], ['c', 7]]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/journal-rpc-handlers.test.js`
Expected: FAIL — module `../lib/journal-rpc.js` does not exist.

- [ ] **Step 3: Implement**

Create `lib/journal-rpc.js`:

```js
// Agent-RPC request handler (docs/superpowers/specs/
// 2026-07-15-rpc-consumer-design.md): the bridge-side counterpart to
// matron-journal's agent RPC relay. Injectable factory in the style of
// lib/journal-publisher.js — index.js wires the real session machinery in,
// tests stub it.
//
// Contract: EVERY request delivered here gets exactly one respondRpc call —
// the whole dispatch is wrapped, and a throw anywhere answers
// {code:'internal'}. respondRpc never throws (publisher contract), so the
// guarantee is structural, not best-effort.

import fs from 'fs';
import path from 'path';

const RECENT_FOLDERS_CAP = 20;

export function createRpcRequestHandler({
  respondRpc,
  // ({workdir, mcpExtras}) -> session; throws on spawn failure. index.js
  // implements this as the !start body minus the origin-room replies.
  startSession,
  // (session) -> void; teardown for the unsupported_mode path.
  stopSession,
  // () -> array of persisted session records ({workdir, lastUsed, ...}).
  listPersistedSessions,
  defaultWorkdir,
  expandHome,
  statSync = fs.statSync,
  log = console,
}) {
  const respond = (request, ok, body) => {
    respondRpc({
      requestId: request.request_id,
      toDeviceId: request.from_device_id,
      ok,
      ...(ok ? { result: body } : { error: body }),
    });
  };

  const handlers = {
    // Folder picker data. Source of truth is the persisted session store
    // only — ~/.claude/projects dir names are NOT decoded (the /→-
    // encoding is lossy; inventing wrong paths is worse than missing
    // rarely-used ones). last_used:null means "available, never used".
    recent_folders(request) {
      const byPath = new Map();
      for (const rec of listPersistedSessions()) {
        if (!rec || typeof rec.workdir !== 'string' || !rec.workdir) continue;
        const lastUsed = typeof rec.lastUsed === 'number' ? rec.lastUsed : 0;
        const prev = byPath.get(rec.workdir);
        if (prev === undefined || lastUsed > prev) byPath.set(rec.workdir, lastUsed);
      }
      const folders = [...byPath.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, RECENT_FOLDERS_CAP)
        .map(([p, t]) => ({ path: p, last_used: t || null }));
      // The picker's "home" entry, present even on a fresh box (and even if
      // the cap sliced it out of a long history).
      if (!folders.some((f) => f.path === defaultWorkdir)) {
        folders.push({ path: defaultWorkdir, last_used: null });
      }
      respond(request, true, { folders });
    },

    // Structured session start: !start's semantics minus the chat replies.
    start(request) {
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      let workdir = defaultWorkdir;
      if (typeof params.workdir === 'string' && params.workdir) {
        const resolved = path.resolve(expandHome(params.workdir));
        let stat = null;
        try { stat = statSync(resolved); } catch { /* missing -> bad_workdir below */ }
        if (!stat || !stat.isDirectory()) {
          return respond(request, false, { code: 'bad_workdir', detail: resolved });
        }
        workdir = resolved;
      }
      const mcpExtras = params.browser === true ? ['browser'] : [];
      let session;
      try {
        session = startSession({ workdir, mcpExtras });
      } catch (e) {
        return respond(request, false, { code: 'spawn_failed', detail: e.message });
      }
      if (!session || !session.claudeSessionId) {
        // Print-mode sessions learn their id asynchronously; v1 RPC start
        // supports interactive mode only (spec). Tear the orphan down —
        // answering success with no usable convo id would strand the app.
        try { if (session) stopSession(session); } catch { /* best-effort teardown */ }
        return respond(request, false, { code: 'unsupported_mode', detail: 'print-mode bridges cannot answer start' });
      }
      // The room key is bridge-internal; the journal convo id is the
      // session UUID — the only id the app can navigate to.
      respond(request, true, { convo_id: session.claudeSessionId });
    },
  };

  return function handleRpcRequest(request) {
    try {
      const handler = handlers[request.method];
      if (!handler) return respond(request, false, { code: 'unknown_method' });
      handler(request);
    } catch (e) {
      log.warn?.(`[journal-rpc] ${request.method} handler threw: ${e.message}`);
      respond(request, false, { code: 'internal', detail: e.message });
    }
  };
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run test/journal-rpc-handlers.test.js`
Expected: PASS.

- [ ] **Step 5: Full suite + checks, then commit**

Run: `npm test`, `npm run check`, `npm run lint`.

```bash
git add lib/journal-rpc.js test/journal-rpc-handlers.test.js
git commit -m "feat: journal-rpc method handlers (start, recent_folders)"
git push
```

---

### Task 3: index.js wiring + spec status + check script

**Files:**
- Modify: `index.js`, `package.json` (check script), `docs/superpowers/specs/2026-07-15-rpc-consumer-design.md` (status line)

**Interfaces:**
- Consumes: `createRpcRequestHandler` (Task 2), `respondRpc`/`onRpcRequest` (Task 1), existing `createSession`/`newSessionConvoId`/`persistSession`/`killSession`/`journalEvictConvoInput`/`sessions`/`loadPersistedSessions`/`DEFAULT_WORKDIR`/`expandHome`/`sendToRoom`/`sendButtonMessage`/`plainTextFormat`/`markdownToHtml`.
- Produces: a live bridge that answers `start`/`recent_folders`.

- [ ] **Step 1: Import the factory**

At the top of `index.js`, next to the existing `import { createJournalPublisher } from './lib/journal-publisher.js';` (line ~47 — the repo is ESM, `"type": "module"`):

```js
import { createRpcRequestHandler } from './lib/journal-rpc.js';
```

- [ ] **Step 2: Add `onRpcRequest` to the publisher options**

In the `createJournalPublisher({...})` call (~line 232), after the `onStreamResync` entry:

```js
  // Agent-RPC dispatch. Arrow + late-bound const (journalRpcHandler is
  // defined below): safe for the same reason onEvent's forward reference
  // is — the callback only ever fires once the socket is live, long after
  // module evaluation.
  onRpcRequest: (request) => journalRpcHandler(request),
```

- [ ] **Step 3: Add the start/stop lambdas and the handler**

Immediately after the `JOURNAL_ENABLED` boot block (after the `if (JOURNAL_ENABLED) { ... }` that publishes "Bridge online"), insert:

```js
// RPC-start (lib/journal-rpc.js `start`): the !start command body minus the
// origin-room replies — an RPC start has no origin chat room. Returns the
// session; the RPC handler answers with its claudeSessionId (the journal
// convo id — NOT the room key, which is bridge-internal).
function journalStartSessionForRpc({ workdir, mcpExtras }) {
  const sessionRoomId = newSessionConvoId();
  const sessionSendReply = (reply) => sendToRoom(sessionRoomId, plainTextFormat(reply), markdownToHtml(reply));
  const sessionSendHtml = (plainText, html) => sendToRoom(sessionRoomId, plainText, html);
  const sessionSendButtons = (prompt, buttons, mode, plainText, html) =>
    sendButtonMessage(sessionRoomId, prompt, buttons, mode, plainText, html);
  const session = createSession(sessionRoomId, workdir, undefined, { mcpExtras });
  session.originRoomId = null;
  session.sendCallback = sessionSendReply;
  session.sendHtml = sessionSendHtml;
  session.sendButtonMessage = sessionSendButtons;
  // Same iv-mode persistence rule as !start: claudeSessionId is known
  // immediately, so persist extras now rather than losing them to a bridge
  // restart before the first transcript-driven persist.
  if (mcpExtras.length > 0 && session.claudeSessionId) {
    persistSession(sessionRoomId, session.claudeSessionId, session.workdir, null);
  }
  return session;
}

const journalRpcHandler = createRpcRequestHandler({
  respondRpc: (args) => journalPublisher.respondRpc(args),
  startSession: journalStartSessionForRpc,
  // The !stop teardown for the unsupported_mode orphan: kill, drop from the
  // sessions map (keyed by room id — scan, this path is rare), evict input.
  stopSession: (session) => {
    killSession(session);
    for (const [key, value] of sessions) {
      if (value === session) { sessions.delete(key); break; }
    }
    journalEvictConvoInput(session);
  },
  listPersistedSessions: () => Object.values(loadPersistedSessions()),
  defaultWorkdir: DEFAULT_WORKDIR,
  expandHome,
  log: console,
});
```

NOTE: `journalStartSessionForRpc` references `sendToRoom`, `plainTextFormat`, `markdownToHtml`, `sendButtonMessage`, `createSession`, `newSessionConvoId`, `persistSession` — all function declarations defined later in the module; hoisting makes the references safe exactly as the file's existing forward-reference comment explains. `sessions` (line ~357) and `DEFAULT_WORKDIR` (line ~69) are consts defined ABOVE this insertion point; verify both line numbers still hold before choosing the exact insertion spot — the insertion must come after `const sessions = new Map()`. If the `JOURNAL_ENABLED` block sits above line 357, place this block after the `sessions` declaration instead, keeping the publisher-option arrow untouched (it late-binds).

- [ ] **Step 4: Add the new file to `npm run check`**

In `package.json`'s `check` script, append ` && node --check lib/journal-rpc.js` (keep the existing entries untouched).

- [ ] **Step 5: Flip the spec status**

In `docs/superpowers/specs/2026-07-15-rpc-consumer-design.md`, change
`**Status:** draft — awaiting review` to
`**Status:** implemented — pending deploy (bridge restart required)`.

- [ ] **Step 6: Full suite + checks, then commit**

Run: `npm test` (all green), `npm run check` (must include the new file), `npm run lint`.

Also run a wiring smoke that requires no live journal: `node --check index.js` (already part of check) and `npx vitest run test/journal-rpc-dispatch.test.js test/journal-rpc-handlers.test.js`.

```bash
git add index.js package.json docs/superpowers/specs/2026-07-15-rpc-consumer-design.md
git commit -m "feat: wire agent-RPC handler into the bridge (start + recent_folders live)"
git push
```

---

## Out of scope (deliberate)

- Deploying: requires a `matron-bridge.service` restart, which kills live
  Claude sessions — the operator schedules it; NEVER restart it from a task.
- `resume`/`stop`/`list_sessions` methods (spec non-goals; `unknown_method`
  covers them).
- The SP3 "button primitives" work — separate deliverable.
