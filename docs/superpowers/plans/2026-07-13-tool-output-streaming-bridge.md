# Tool-Output Streaming over the Journal Protocol — Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream live Bash output to Matron clients over the journal WebSocket (`stream_append` frames) and publish a durable `tool_output` completion event with snippet + blob, replacing the HMAC-signed viewer-URL live path.

**Architecture:** A new per-command pump module tails the matron-tee log file and feeds `journalPublisher.streamAppend()`; the publisher gains the `stream_append` ephemeral, `stream_resync` control-frame dispatch, and a durable `finalizeToolOutput()`. `index.js` wires three thin seams: `tool_use` starts a pump, `tool_result` stops it and finalizes with an uploaded log blob, `killSession` finalizes orphans with `exit_code: null`. The server side (matron-journal PR #11) is already shipped; this plan implements the bridge half of `docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md` §9 (the spec lives in the **matron-journal** repo).

**Tech Stack:** Node.js ≥22 ESM, `ws`, vitest (`npm test` = `vitest run`), no new dependencies.

## Global Constraints

Copied from the spec and this repo's standing contracts — every task's requirements implicitly include these:

- **Fail-open publisher contract** (lib/journal-publisher.js header): every public method "MUST fail open. A journal outage, a bad token, a network partition, a malformed frame from the server — none of it may ever throw, reject, block, or otherwise touch Matrix behavior."
- **Gating:** all new behavior sits behind the existing `session.showBashOutput` toggle AND `JOURNAL_ENABLED`. With either off, behavior for the journal is a no-op (Matrix room UX still works).
- **Byte-exact offsets:** a frame's `offset` is "the absolute byte position of `chunk`'s first byte in the command's logical output stream (= the tee log file offset)" (spec §5.1). Therefore for every frame the bridge sends, `Buffer.byteLength(chunk, 'utf-8')` MUST equal the count of raw log-file bytes the chunk represents, and no frame boundary may split a multi-byte UTF-8 character. (If decode changed the byte length — e.g. an invalid byte became U+FFFD, 1 byte → 3 — bridge and server offsets would diverge and every subsequent frame would trip a `stream_resync` loop.)
- **meta on creating frames:** `meta: {tool: 'Bash', command: <string>}` is required on every `offset === 0` frame (the buffer-creating frame); the server truncates `command` at 2 000 chars itself.
- **Pump throttle:** ≥250 ms between pump passes (spec §9). Appends are NEVER coalesced latest-wins bridge-side — a dropped delta is a permanent gap (unlike `replace_text` snapshots).
- **Durable completion payload** (spec §5.3), exactly: `{message_ref, command, exit_code, denied, truncated, snippet, blob_ref, live_log: true}` — sent via `finalize` with the SAME `blob_ref` ALSO at the frame's top level (the column-level ref is what server retention scans key on). `snippet` is the last ≤50 lines and ≤4 096 bytes. No `viewer_url`, no `expires_at`.
- **Every stream ends in exactly one finalize:** normal completion (`tool_result`), denial (`denied: true`), and session teardown (`exit_code: null`) all finalize, so server buffers are freed deterministically — "the idle sweep is the backstop, not the mechanism" (spec §9).
- **Viewer untouched:** `viewer/server.js` keeps its file-view/secret/one-time-link jobs and its (now-legacy) `/live/ws` endpoint. Only the *generation* of live-output viewer URLs is removed.
- **Wire frames** (server contract, pinned by matron-journal `test/fixtures/conformance/13_tool_stream.json`):
  - out: `{op:'stream_append', convo_id, message_ref, offset, chunk, meta?}`
  - in: `{kind:'control', op:'stream_resync', convo_id, message_ref, have}`
  - out: `{op:'finalize', convo_id, type:'tool_output', message_ref, payload, blob_ref}` (server composes idem key `agent:<device>:fin:<message_ref>` — re-sends after reconnect dedupe server-side).
- Run the named test file per task (`npx vitest run test/<file>`); full `npm run ci` (lint + node --check + suite + audit) in the final task.

## File Structure

- **Create** `lib/tool-stream-pump.js` — `decodeByteExact`, `toolOutputSnippet`, `createToolStreamPump` (the viewer's proven tail-pump logic, lifted into a testable module with byte-exact decoding).
- **Create** `test/tool-stream-pump.test.js`.
- **Modify** `lib/journal-publisher.js` — `streamAppend`, `finalizeToolOutput`, `onStreamResync` option + dispatch; noop publisher parity.
- **Modify** `test/journal-publisher.test.js` — new describe block against the existing in-process fake server.
- **Modify** `index.js` — pump registry + resync routing (near line 226), `tool_use` seam (~line 2142), `sendLiveOutputEvent` (~line 3181), `tool_result` seam (~line 2493) + new `stopAndFinalizeToolStream` helper, `killSession` (~line 6166), boot warning (~line 182), imports.
- **Modify** `test/journal-publisher.integration.test.js` — end-to-end pump/resync/finalize against the real matron-journal server (dev-2 only, auto-skipped elsewhere).
- **Modify** `package.json` (`check` script), `README.md`, `docs/superpowers/specs/2026-06-12-matron-events-protocol.md` (one table row).

---

### Task 1: `lib/tool-stream-pump.js` — byte-exact decoder, snippet, pump

**Files:**
- Create: `lib/tool-stream-pump.js`
- Test: `test/tool-stream-pump.test.js`

**Interfaces:**
- Consumes: nothing from this repo (pure module + `node:fs`).
- Produces (later tasks rely on these exact signatures):
  - `decodeByteExact(buf: Buffer) -> {text: string, consumed: number, held: number}` — `Buffer.byteLength(text) === consumed`, always.
  - `toolOutputSnippet(text: string) -> string` — last ≤50 lines, ≤4096 bytes, never splits a UTF-8 char.
  - `createToolStreamPump({logPath, convoId, messageRef, meta, streamAppend, throttleMs = 250, chunkBytes = 65536}) -> {start(), resync(have), stop()}` — `streamAppend(convoId, messageRef, offset, chunk, metaOrUndefined)` is called with `meta` ONLY on `offset === 0` frames.

- [ ] **Step 1: Write the failing tests**

Create `test/tool-stream-pump.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { decodeByteExact, toolOutputSnippet, createToolStreamPump } from '../lib/tool-stream-pump.js';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
    await delay(intervalMs);
  }
}

// Collects streamAppend calls; content() reassembles the logical stream by
// offset so tests assert on WHAT arrived, not how it was chunked.
function makeSink() {
  const frames = [];
  const sink = (convoId, messageRef, offset, chunk, meta) => {
    frames.push({ convoId, messageRef, offset, chunk, meta, at: Date.now() });
  };
  sink.frames = frames;
  sink.content = () => {
    let out = '';
    for (const f of [...frames].sort((a, b) => a.offset - b.offset)) {
      // A resync re-send can overlap what we already have; overlay by offset.
      const bytes = Buffer.byteLength(out);
      if (f.offset <= bytes) {
        out = Buffer.concat([
          Buffer.from(out).subarray(0, f.offset),
          Buffer.from(f.chunk),
        ]).toString('utf-8');
      }
    }
    return out;
  };
  return sink;
}

describe('decodeByteExact', () => {
  it('decodes plain ASCII, consuming every byte', () => {
    const r = decodeByteExact(Buffer.from('hello world'));
    expect(r).toEqual({ text: 'hello world', consumed: 11, held: 0 });
  });

  it('decodes multi-byte UTF-8 with byte length preserved', () => {
    const buf = Buffer.from('a😀é');
    const r = decodeByteExact(buf);
    expect(r.text).toBe('a😀é');
    expect(r.consumed).toBe(buf.length);
    expect(Buffer.byteLength(r.text)).toBe(r.consumed);
  });

  it('holds back an incomplete trailing sequence', () => {
    const emoji = Buffer.from('😀'); // 4 bytes
    const buf = Buffer.concat([Buffer.from('ab'), emoji.subarray(0, 2)]);
    const r = decodeByteExact(buf);
    expect(r).toEqual({ text: 'ab', consumed: 2, held: 2 });
  });

  it('replaces invalid bytes 1:1 with ? so byte length never drifts', () => {
    const buf = Buffer.from([0x61, 0xff, 0xfe, 0x62]); // a <bad> <bad> b
    const r = decodeByteExact(buf);
    expect(r.text).toBe('a??b');
    expect(r.consumed).toBe(4);
    expect(Buffer.byteLength(r.text)).toBe(4);
  });

  it('replaces overlong encodings with per-byte ? (byte length preserved)', () => {
    const buf = Buffer.from([0xc0, 0x80, 0x61]); // overlong NUL + 'a'
    const r = decodeByteExact(buf);
    expect(r.text).toBe('??a');
    expect(Buffer.byteLength(r.text)).toBe(3);
  });

  it('treats a stray continuation byte as invalid, not a held tail', () => {
    const r = decodeByteExact(Buffer.from([0x80, 0x61]));
    expect(r.text).toBe('?a');
    expect(r.consumed).toBe(2);
  });
});

describe('toolOutputSnippet', () => {
  it('returns short output unchanged', () => {
    expect(toolOutputSnippet('one\ntwo\n')).toBe('one\ntwo\n');
  });

  it('keeps only the last 50 lines', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    const snip = toolOutputSnippet(text);
    expect(snip.startsWith('line10')).toBe(true);
    expect(snip.endsWith('line59')).toBe(true);
    expect(snip.split('\n')).toHaveLength(50);
  });

  it('caps at 4096 bytes without splitting a multi-byte char', () => {
    const text = '😀'.repeat(2000); // 8000 bytes, one line
    const snip = toolOutputSnippet(text);
    expect(Buffer.byteLength(snip)).toBeLessThanOrEqual(4096);
    expect(snip.includes('�')).toBe(false);
    expect(Buffer.byteLength(snip)).toBe(4096); // 1024 emoji exactly — cut lands on a boundary
  });

  it('returns empty string for empty/non-string input', () => {
    expect(toolOutputSnippet('')).toBe('');
    expect(toolOutputSnippet(null)).toBe('');
  });
});

describe('createToolStreamPump', () => {
  function setup({ preContent = null, throttleMs = 0, chunkBytes = 65536 } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'tool-stream-pump-'));
    const logPath = path.join(dir, 'matron-cmd-tu1.log');
    if (preContent !== null) writeFileSync(logPath, preContent);
    const sink = makeSink();
    const pump = createToolStreamPump({
      logPath,
      convoId: 'c1',
      messageRef: 'tu1',
      meta: { tool: 'Bash', command: 'npm test' },
      streamAppend: sink,
      throttleMs,
      chunkBytes,
    });
    const cleanup = () => {
      pump.stop();
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, logPath, sink, pump, cleanup };
  }

  it('sends existing content on start, offset 0, with meta', async () => {
    const { sink, pump, cleanup } = setup({ preContent: 'hello\n' });
    try {
      pump.start();
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({
        convoId: 'c1', messageRef: 'tu1', offset: 0, chunk: 'hello\n',
        meta: { tool: 'Bash', command: 'npm test' },
      });
    } finally {
      cleanup();
    }
  });

  it('picks up appended bytes via the watcher, contiguous offsets, no meta after 0', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'aa' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'aa');
      appendFileSync(logPath, 'bb');
      await waitFor(() => sink.content() === 'aabb');
      const second = sink.frames.find((f) => f.offset === 2);
      expect(second.chunk).toBe('bb');
      expect(second.meta).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('starts against a log file that does not exist yet', async () => {
    const { logPath, sink, pump, cleanup } = setup();
    try {
      pump.start();
      await delay(50);
      expect(sink.frames).toHaveLength(0);
      writeFileSync(logPath, 'late\n');
      await waitFor(() => sink.content() === 'late\n');
      expect(sink.frames[0].offset).toBe(0);
      expect(sink.frames[0].meta).toEqual({ tool: 'Bash', command: 'npm test' });
    } finally {
      cleanup();
    }
  });

  it('keeps >=throttleMs between pump passes', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'a', throttleMs: 300 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'a');
      appendFileSync(logPath, 'b');
      await waitFor(() => sink.content() === 'ab', 5000);
      const gap = sink.frames[1].at - sink.frames[0].at;
      expect(gap).toBeGreaterThanOrEqual(290); // small tolerance for timer slop
    } finally {
      cleanup();
    }
  });

  it('slices a large backlog into chunkBytes frames on UTF-8 boundaries', async () => {
    // 3-byte chars with chunkBytes 8: cut would land mid-char at byte 8, so
    // each frame must hold 2 chars (6 bytes), never a torn one.
    const { sink, pump, cleanup } = setup({ preContent: 'ééé'.repeat(2), chunkBytes: 8 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'éééééé');
      expect(sink.frames.length).toBeGreaterThan(1);
      for (const f of sink.frames) {
        expect(f.chunk.includes('�')).toBe(false);
      }
      // Offsets are contiguous in bytes.
      let expected = 0;
      for (const f of [...sink.frames].sort((a, b) => a.offset - b.offset)) {
        expect(f.offset).toBe(expected);
        expected += Buffer.byteLength(f.chunk);
      }
    } finally {
      cleanup();
    }
  });

  it('holds back a torn trailing multi-byte char until completed', async () => {
    const emoji = Buffer.from('😀');
    const { logPath, sink, pump, cleanup } = setup();
    try {
      writeFileSync(logPath, Buffer.concat([Buffer.from('x'), emoji.subarray(0, 2)]));
      pump.start();
      await waitFor(() => sink.content() === 'x');
      appendFileSync(logPath, emoji.subarray(2));
      await waitFor(() => sink.content() === 'x😀');
      for (const f of sink.frames) expect(f.chunk.includes('�')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('resync(have) rewinds and re-sends from that byte, meta again at 0', async () => {
    const { sink, pump, cleanup } = setup({ preContent: 'abcdef' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'abcdef');
      sink.frames.length = 0;
      pump.resync(0);
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({
        offset: 0, chunk: 'abcdef', meta: { tool: 'Bash', command: 'npm test' },
      });
      sink.frames.length = 0;
      pump.resync(3);
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({ offset: 3, chunk: 'def' });
      expect(sink.frames[0].meta).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('sends nothing after stop()', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'a' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'a');
      pump.stop();
      appendFileSync(logPath, 'b');
      pump.resync(0);
      await delay(80);
      expect(sink.content()).toBe('a');
    } finally {
      cleanup();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/tool-stream-pump.test.js`
Expected: FAIL — `Cannot find module '../lib/tool-stream-pump.js'` (or equivalent).

- [ ] **Step 3: Write the implementation**

Create `lib/tool-stream-pump.js`:

```js
import { watch as fsWatch, statSync, openSync, readSync, closeSync } from 'fs';
import path from 'path';

// Per-command tail pump for journal-native tool-output streaming: the code
// viewer's proven fs.watch + offset-read loop (viewer/server.js handleLiveWs)
// lifted into a testable module, in the style of lib/live-output.js — a plain
// factory index.js wires in. One pump per running Bash command; it tails the
// matron-tee log at `logPath` and feeds `streamAppend(convoId, messageRef,
// offset, chunk, meta)` — lib/journal-publisher.js's ephemeral stream_append.
// See docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md
// (matron-journal repo) §5.1/§9 for the wire contract this drives.
//
// Offsets are LOG-FILE BYTE positions, and the server accounts in bytes of
// the chunk it receives — so every chunk this module emits must satisfy
// Buffer.byteLength(chunk) === raw bytes consumed from the file. Command
// output is arbitrary bytes (a `cat` of a binary is legal), and a naive
// buf.toString('utf-8') breaks that invariant: each invalid byte becomes
// U+FFFD (1 byte -> 3), offsets drift, and every later frame trips a
// stream_resync loop. decodeByteExact below is the whole fix.

// Decode a buffer as UTF-8 preserving byte length exactly: every valid
// sequence decodes as itself; every invalid byte becomes one '?' (1 byte);
// a valid-but-incomplete multi-byte sequence at the tail is HELD BACK
// (not consumed) so the next read completes it. Invariant:
// Buffer.byteLength(text) === consumed, always.
export function decodeByteExact(buf) {
  let out = '';
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) {
      // ASCII run fast path — latin1 is byte-identical for < 0x80.
      let j = i + 1;
      while (j < n && buf[j] < 0x80) j++;
      out += buf.toString('latin1', i, j);
      i = j;
      continue;
    }
    let need = 0;
    if ((b & 0xe0) === 0xc0) need = 2;
    else if ((b & 0xf0) === 0xe0) need = 3;
    else if ((b & 0xf8) === 0xf0) need = 4;
    if (!need) { // stray continuation byte or invalid lead
      out += '?';
      i += 1;
      continue;
    }
    if (i + need > n) {
      // Possibly-incomplete tail. Hold it back only if what's present is a
      // valid prefix — otherwise it will never complete, replace and move on.
      let validPrefix = true;
      for (let k = i + 1; k < n; k++) {
        if ((buf[k] & 0xc0) !== 0x80) { validPrefix = false; break; }
      }
      if (validPrefix) return { text: out, consumed: i, held: n - i };
      out += '?';
      i += 1;
      continue;
    }
    let valid = true;
    for (let k = i + 1; k < i + need; k++) {
      if ((buf[k] & 0xc0) !== 0x80) { valid = false; break; }
    }
    if (!valid) {
      out += '?';
      i += 1;
      continue;
    }
    const s = buf.toString('utf-8', i, i + need);
    // Overlong/surrogate/out-of-range sequences decode to U+FFFD and change
    // byte length — replace those with need x '?' to keep the invariant.
    out += Buffer.byteLength(s) === need ? s : '?'.repeat(need);
    i += need;
  }
  return { text: out, consumed: n, held: 0 };
}

// The durable completion event's snippet (spec §5.3): the last <= maxLines
// lines, further capped at maxBytes UTF-8 bytes, never splitting a
// multi-byte character (walk the cut past continuation bytes, the same
// boundary rule as the server's buffer head-drop).
export function toolOutputSnippet(text, { maxLines = 50, maxBytes = 4096 } = {}) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let snip = text.split('\n').slice(-maxLines).join('\n');
  const buf = Buffer.from(snip, 'utf-8');
  if (buf.length > maxBytes) {
    let cut = buf.length - maxBytes;
    while (cut < buf.length && (buf[cut] & 0xc0) === 0x80) cut++;
    snip = buf.toString('utf-8', cut);
  }
  return snip;
}

export function createToolStreamPump({
  logPath,
  convoId,
  messageRef,
  meta,
  streamAppend,
  throttleMs = 250,
  chunkBytes = 65536,
}) {
  let offset = 0; // log bytes confirmed sent (== the logical stream offset)
  let lastPumpAt = 0;
  let timer = null;
  let watcher = null;
  let stopped = false;
  const basename = path.basename(logPath);

  function readFrom(pos) {
    let st;
    try { st = statSync(logPath); } catch { return null; } // not created yet, or GC'd
    if (st.size <= pos) return null;
    try {
      const fd = openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(st.size - pos);
        const n = readSync(fd, buf, 0, buf.length, pos);
        return n === buf.length ? buf : buf.subarray(0, n);
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  function pump() {
    if (stopped) return;
    lastPumpAt = Date.now();
    const raw = readFrom(offset);
    if (!raw || raw.length === 0) return;
    let pos = 0;
    while (pos < raw.length) {
      const slice = raw.subarray(pos, Math.min(pos + chunkBytes, raw.length));
      const { text, consumed } = decodeByteExact(slice);
      if (consumed === 0) break; // torn multi-byte tail — the next write completes it
      const at = offset + pos;
      streamAppend(convoId, messageRef, at, text, at === 0 ? meta : undefined);
      pos += consumed;
    }
    offset += pos;
  }

  function schedulePump() {
    if (stopped || timer) return;
    const wait = throttleMs - (Date.now() - lastPumpAt);
    if (wait <= 0) {
      pump();
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, wait);
    if (typeof timer.unref === 'function') timer.unref();
  }

  return {
    start() {
      if (stopped) return;
      try {
        // Watch the PARENT directory filtered by basename (the viewer's
        // done-sentinel pattern) rather than the file: the tee log usually
        // doesn't exist yet when the tool_use event arrives.
        watcher = fsWatch(path.dirname(logPath), { persistent: false }, (event, filename) => {
          if (filename && filename !== basename) return; // filename can be null on some platforms — pump anyway
          schedulePump();
        });
      } catch {
        watcher = null; // no watcher -> initial content still goes out; resync still works
      }
      pump();
    },
    // Server said "I only have `have` bytes" (stream_resync): rewind to that
    // byte and re-send. Bypasses the throttle — this is the recovery path for
    // bridge reconnects, server restarts, and dropped frames.
    resync(have) {
      if (stopped) return;
      if (Number.isInteger(have) && have >= 0 && have < offset) offset = have;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      pump();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try { watcher?.close(); } catch { /* best effort */ }
      watcher = null;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/tool-stream-pump.test.js`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add lib/tool-stream-pump.js test/tool-stream-pump.test.js
git commit -m "feat: tool-stream pump with byte-exact UTF-8 decoding"
```

---

### Task 2: `lib/journal-publisher.js` — streamAppend, stream_resync dispatch, finalizeToolOutput

**Files:**
- Modify: `lib/journal-publisher.js`
- Test: `test/journal-publisher.test.js` (append a new describe block; the file's existing `startFakeServer`/`waitFor`/`silentLog` helpers are reused)

**Interfaces:**
- Consumes: existing internals — `enqueue`, `warn`, `connected`/`ws`/`closed` state, the `socket.on('message')` handler chain.
- Produces (Task 3/4 rely on these exact signatures):
  - `streamAppend(convoId, messageRef, offset, chunk, meta)` — ephemeral, never queued, fails open; `meta` included in the frame only when not `undefined`.
  - `finalizeToolOutput(convoId, messageRef, payload, blobRef)` — durable, FIFO-queued like `publish`, re-sent on reconnect; frame `{op:'finalize', convo_id, type:'tool_output', message_ref, payload, blob_ref}` with `blob_ref: blobRef ?? null`.
  - Constructor option `onStreamResync(convoId, messageRef, have)` — called for every inbound `{kind:'control', op:'stream_resync'}` frame; a throwing handler is caught and warned, never fatal.

- [ ] **Step 1: Write the failing tests**

Append to `test/journal-publisher.test.js`:

```js
describe('tool-output streaming (streamAppend / stream_resync / finalizeToolOutput)', () => {
  it('streamAppend sends the exact frame, meta only when provided', async () => {
    const server = await startFakeServer();
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20); // let hello_ok land
      pub.streamAppend('c1', 'tu1', 0, '$ make\n', { tool: 'Bash', command: 'make' });
      pub.streamAppend('c1', 'tu1', 7, 'ok\n');
      await waitFor(() => server.received.length === 2);
      expect(server.received[0]).toEqual({
        op: 'stream_append', convo_id: 'c1', message_ref: 'tu1',
        offset: 0, chunk: '$ make\n', meta: { tool: 'Bash', command: 'make' },
      });
      expect(server.received[1]).toEqual({
        op: 'stream_append', convo_id: 'c1', message_ref: 'tu1', offset: 7, chunk: 'ok\n',
      });
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('streamAppend before hello_ok drops silently — never queued, never replayed', async () => {
    // Point the publisher at a free port with no server yet: the ephemeral
    // must drop, while a queued publish sent in the same window survives to
    // the eventual connection.
    const port = await getFreePort();
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${port}/ws`, token: 't', log: silentLog, backoffBaseMs: 30,
    });
    try {
      pub.streamAppend('c1', 'tu1', 0, 'dropped', { tool: 'Bash', command: 'x' });
      pub.publishText('c1', { body: 'after' }); // queued frame DOES arrive
      const server = await startFakeServer({}, port);
      await waitFor(() => server.received.some((f) => f.op === 'publish'));
      expect(server.received.some((f) => f.op === 'stream_append')).toBe(false);
      await server.close();
    } finally {
      pub.close();
    }
  });

  it('dispatches inbound stream_resync control frames to onStreamResync', async () => {
    const resyncs = [];
    const server = await startFakeServer({
      onFrame: (msg) => {
        if (msg.op === 'stream_append') {
          return { kind: 'control', op: 'stream_resync', convo_id: msg.convo_id, message_ref: msg.message_ref, have: 4 };
        }
        return null;
      },
    });
    const pub = createJournalPublisher({
      url: server.url, token: 't', log: silentLog,
      onStreamResync: (convoId, messageRef, have) => resyncs.push({ convoId, messageRef, have }),
    });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20);
      pub.streamAppend('c1', 'tu1', 999, 'gap');
      await waitFor(() => resyncs.length === 1);
      expect(resyncs[0]).toEqual({ convoId: 'c1', messageRef: 'tu1', have: 4 });
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('a throwing onStreamResync handler is contained — later frames still processed', async () => {
    const seen = [];
    const server = await startFakeServer({
      onFrame: (msg) => {
        if (msg.op === 'stream_append' && msg.offset === 999) {
          return { kind: 'control', op: 'stream_resync', convo_id: msg.convo_id, message_ref: msg.message_ref, have: 0 };
        }
        return null;
      },
    });
    const pub = createJournalPublisher({
      url: server.url, token: 't', log: silentLog,
      onStreamResync: () => { throw new Error('boom'); },
      onEvent: (msg) => seen.push(msg),
    });
    try {
      await waitFor(() => server.connections.length === 1);
      await delay(20);
      pub.streamAppend('c1', 'tu1', 999, 'gap');
      await delay(50); // resync arrives, handler throws, must be swallowed
      server.connections[0].ws.send(JSON.stringify({ kind: 'journal', seq: 1, type: 'text', payload: {} }));
      await waitFor(() => seen.length === 1);
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('finalizeToolOutput is durable: exact frame, queued until a server appears', async () => {
    const port = await getFreePort();
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${port}/ws`, token: 't', log: silentLog, backoffBaseMs: 30,
    });
    try {
      pub.finalizeToolOutput('c1', 'tu1', {
        message_ref: 'tu1', command: 'make', exit_code: 0, denied: false,
        truncated: false, snippet: 'ok', blob_ref: 'blob9', live_log: true,
      }, 'blob9');
      const revived = await startFakeServer({}, port);
      await waitFor(() => revived.received.some((f) => f.op === 'finalize'));
      const frame = revived.received.find((f) => f.op === 'finalize');
      expect(frame).toEqual({
        op: 'finalize', convo_id: 'c1', type: 'tool_output', message_ref: 'tu1',
        payload: {
          message_ref: 'tu1', command: 'make', exit_code: 0, denied: false,
          truncated: false, snippet: 'ok', blob_ref: 'blob9', live_log: true,
        },
        blob_ref: 'blob9',
      });
      await revived.close();
    } finally {
      pub.close();
    }
  });

  it('finalizeToolOutput defaults top-level blob_ref to null', async () => {
    const server = await startFakeServer();
    const pub = createJournalPublisher({ url: server.url, token: 't', log: silentLog });
    try {
      pub.finalizeToolOutput('c1', 'tu2', { message_ref: 'tu2', live_log: true });
      await waitFor(() => server.received.some((f) => f.op === 'finalize'));
      expect(server.received.find((f) => f.op === 'finalize').blob_ref).toBeNull();
    } finally {
      pub.close();
      await server.close();
    }
  });

  it('disabled (no url/token) publisher exposes the new methods as no-ops', () => {
    const pub = createJournalPublisher({ log: silentLog });
    expect(() => {
      pub.streamAppend('c1', 'tu1', 0, 'x', { tool: 'Bash', command: 'x' });
      pub.finalizeToolOutput('c1', 'tu1', {}, null);
    }).not.toThrow();
  });
});
```

Note for the implementer: the second test's first two lines create-and-close a fake server purely to reserve a known port — follow the file's existing reconnect tests if they use a different port-reuse idiom, and reuse that idiom instead if so.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/journal-publisher.test.js`
Expected: FAIL — `pub.streamAppend is not a function` (and the resync/finalize tests failing similarly). Pre-existing tests still pass.

- [ ] **Step 3: Implement**

In `lib/journal-publisher.js`:

**(a)** Add `onStreamResync` to the constructor options, right after the `onEvent` option (line ~103), with its own comment:

```js
  // Inbound stream_resync dispatch (tool-output streaming). When set, every
  // inbound `{kind:'control', op:'stream_resync'}` frame is handed to this
  // callback as (convo_id, message_ref, have) — the pump for that stream
  // rewinds to byte `have` and re-sends (lib/tool-stream-pump.js). Unset:
  // the frames are ignored like any other unrecognised control op.
  onStreamResync,
```

**(b)** In the `socket.on('message', ...)` handler, add a branch between the `snapshot_required` branch and the `msg.kind === 'journal'` branch:

```js
      } else if (msg.kind === 'control' && msg.op === 'stream_resync') {
        if (onStreamResync) {
          try {
            onStreamResync(msg.convo_id, msg.message_ref, msg.have);
          } catch (e) {
            warn(`[journal-publisher] onStreamResync handler threw: ${e.message}`);
          }
        }
      } else if (msg.kind === 'journal' && onEvent) {
```

**(c)** Add two methods to the returned object, after `endStream` and before `markRead`:

```js
    // EPHEMERAL — one live tool-output chunk (op stream_append). Same
    // never-queued/never-replayed contract as publishActivity: fires
    // immediately if the socket is live (past hello_ok), otherwise drops
    // silently. A dropped frame self-heals: the server answers the resulting
    // offset gap with stream_resync and the pump re-reads from its log file
    // (see lib/tool-stream-pump.js). NO bridge-side throttle or coalescing
    // here — the pump owns pacing, and appends must never be latest-wins
    // coalesced: unlike replace_text snapshots, a swallowed delta would be a
    // permanent gap. meta rides only on buffer-creating (offset 0) frames.
    streamAppend(convoId, messageRef, offset, chunk, meta) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'stream_append', convo_id: convoId, message_ref: messageRef, offset, chunk };
        if (meta !== undefined) frame.meta = meta;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable stream_append frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] streamAppend failed: ${e.message}`);
      }
    },
    // DURABLE tool-output completion (op finalize, type tool_output) — the
    // event whose payload.message_ref retires the live overlay and whose
    // arrival frees the server-side stream buffer. Queued FIFO and re-sent on
    // reconnect like every publish; safe because the server composes the idem
    // key itself (`agent:<device>:fin:<message_ref>`), so a retry can't
    // double-publish. blob_ref rides at the TOP LEVEL as well as inside the
    // payload: the top-level copy sets the event row's blob_ref COLUMN (what
    // the server's retention TTL scan keys on); the payload copy is the
    // client-visible one. Unlike the assistant-text flow (which uses publish +
    // payload.message_ref — see the wire-contract comment at the top of this
    // file), tool_output completions genuinely need finalize: it is the only
    // op that both frees the stream buffer and carries the blob_ref column.
    finalizeToolOutput(convoId, messageRef, payload, blobRef) {
      try {
        enqueue({
          op: 'finalize', convo_id: convoId, type: 'tool_output',
          message_ref: messageRef, payload, blob_ref: blobRef ?? null,
        });
      } catch (e) {
        warn(`[journal-publisher] finalizeToolOutput failed: ${e.message}`);
      }
    },
```

**(d)** Add the same two method names to `noopPublisher()` (after `endStream() {}`):

```js
    streamAppend() {},
    finalizeToolOutput() {},
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/journal-publisher.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add lib/journal-publisher.js test/journal-publisher.test.js
git commit -m "feat(journal): stream_append, stream_resync dispatch, finalizeToolOutput"
```

---

### Task 3: `index.js` tool_use seam — start pumps, drop viewer-URL generation

`index.js` has no direct unit tests by design — the spec (§11) requires these seams to "stay as thin as today's live-output wiring and [be] exercised by the existing regression suite." Verification for Tasks 3–5 is: `node --check index.js`, `npm run lint`, and the full existing suite staying green.

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `createToolStreamPump` (Task 1), `journalPublisher.streamAppend` + `onStreamResync` option (Task 2).
- Produces: module-level `toolStreamPumps` Map and `toolStreamKey(convoId, messageRef)` — entries `{pump, session, command, logPath, messageRef}` keyed `` `${convoId}\0${messageRef}` ``. Task 4's `stopAndFinalizeToolStream` and Task 5's `killSession` sweep consume these.

- [ ] **Step 1: Add the import**

At the top of `index.js`, alongside the other `./lib/` imports (near line 15), add (only this one name — Task 4 extends it; importing the snippet helpers now would trip lint's no-unused-vars at this task's commit):

```js
import { createToolStreamPump } from './lib/tool-stream-pump.js';
```

and DELETE line 15's now-dead import (verify first that `grep -n "generateSignedUrl" index.js` shows only the import and the tool_use call site being removed in Step 3):

```js
import { generateSignedUrl } from './lib/viewer-tokens.js';
```

- [ ] **Step 2: Pump registry + resync routing**

Immediately BEFORE the `const journalPublisher = createJournalPublisher({` block (line ~226), add:

```js
// Active tool-output stream pumps, keyed `${convoId}\0${messageRef}` — the
// same key the server buffers under. Registered by the Bash tool_use seam,
// drained by stopAndFinalizeToolStream (tool_result) and killSession.
// Module-level rather than per-session so the single onStreamResync
// dispatcher below can route a server resync to its pump directly.
const toolStreamPumps = new Map();
function toolStreamKey(convoId, messageRef) {
  return `${convoId}\0${messageRef}`;
}
```

Inside the `createJournalPublisher({...})` options, after the `onEvent: journalHandleInboundEvent,` line, add:

```js
  onStreamResync: (convoId, messageRef, have) => {
    toolStreamPumps.get(toolStreamKey(convoId, messageRef))?.pump.resync(have);
  },
```

- [ ] **Step 3: Replace the tool_use live-output block**

In the `Bash` branch of the assistant-event handler (lines ~2142–2178), replace this entire block:

```js
            if (session.showBashOutput) {
              liveOutputStore.register(liveToolUseId, {
                logPath: liveLogPath,
                roomId: session.roomId,
              });
              const expiresAt = Math.floor(Date.now() / 1000) + LIVE_OUTPUT_TTL;
              if (HMAC_SECRET && VIEWER_BASE_URL) {
                const viewerUrl = generateSignedUrl(
                  VIEWER_BASE_URL,
                  null,
                  HMAC_SECRET,
                  LIVE_OUTPUT_TTL,
                  { liveCmdId: liveToolUseId, logPath: liveLogPath, doneSentinelPath: `${liveLogPath}.done` }
                );
                const liveUrl = new URL(viewerUrl);
                liveUrl.pathname = liveUrl.pathname.replace(/\/view$/, '/live');
                // Optimistically suppress the synchronous indicator post
                // below; if the async send fails we re-post the regular
                // indicator so the user isn't left looking at nothing.
                const fallbackPlain = indicator;
                const fallbackHtml = indicatorHtml;
                sendLiveOutputEvent(session, {
                  tool_use_id: liveToolUseId,
                  command: displayCommand,
                  viewer_url: liveUrl.toString(),
                  expires_at: expiresAt,
                }).then(ok => {
                  if (ok) return;
                  if (session.sendHtml && fallbackHtml) {
                    session.sendHtml(fallbackPlain, fallbackHtml);
                  } else if (session.sendCallback) {
                    session.sendCallback(fallbackPlain);
                  }
                });
                liveOutputSent = true;
              }
            }
```

with:

```js
            if (session.showBashOutput) {
              liveOutputStore.register(liveToolUseId, {
                logPath: liveLogPath,
                roomId: session.roomId,
              });
              // Live output rides the journal protocol: one pump per running
              // command tails the tee log and feeds stream_append ephemerals
              // (spec §9). Same skip-if-no-session-id rule as journalActivity:
              // ephemerals replayed late would be stale, so a session whose
              // claudeSessionId isn't known yet just doesn't stream.
              if (JOURNAL_ENABLED && session.claudeSessionId) {
                const pump = createToolStreamPump({
                  logPath: liveLogPath,
                  convoId: session.claudeSessionId,
                  messageRef: liveToolUseId,
                  meta: { tool: 'Bash', command: displayCommand },
                  streamAppend: (c, r, off, chunk, meta) =>
                    journalPublisher.streamAppend(c, r, off, chunk, meta),
                });
                toolStreamPumps.set(toolStreamKey(session.claudeSessionId, liveToolUseId), {
                  pump,
                  session,
                  command: displayCommand,
                  logPath: liveLogPath,
                  messageRef: liveToolUseId,
                });
                pump.start();
              }
              // Optimistically suppress the synchronous indicator post below;
              // if the async send fails we re-post the regular indicator so
              // the user isn't left looking at nothing.
              const fallbackPlain = indicator;
              const fallbackHtml = indicatorHtml;
              sendLiveOutputEvent(session, {
                tool_use_id: liveToolUseId,
                command: displayCommand,
              }).then(ok => {
                if (ok) return;
                if (session.sendHtml && fallbackHtml) {
                  session.sendHtml(fallbackPlain, fallbackHtml);
                } else if (session.sendCallback) {
                  session.sendCallback(fallbackPlain);
                }
              });
              liveOutputSent = true;
            }
```

(Behavior change to note in review: the `chat.matron.live_output` Matrix event now posts whenever `showBashOutput` is on — it no longer depends on `HMAC_SECRET`/`VIEWER_BASE_URL`.)

- [ ] **Step 4: Rewrite `sendLiveOutputEvent`**

Replace the whole function (lines ~3181–3215) with:

```js
async function sendLiveOutputEvent(session, { tool_use_id, command }) {
  // 'tool' activity, detail = the command — this is the one place index.js
  // knows the command string at tool-start time. The DURABLE tool_output
  // journal event is now published at COMPLETION (stopAndFinalizeToolStream),
  // not here: live viewers get the command from the stream meta frames, and
  // history gets it from the finalize payload (spec §5.3). No viewer_url /
  // expires_at anywhere — live output rides the journal protocol.
  journalActivity(session, 'tool', truncateActivityDetail(command));
  // Matrix room UX: the same custom event as before minus the viewer link.
  // matron-web's live tile goes dark for new commands until it implements
  // the journal client contract (accepted, spec §10) — every other Matrix
  // client keeps rendering the body/formatted_body fallback below.
  const truncated = command.length > 100 ? command.slice(0, 100) + '…' : command;
  const body = `🔧 \`${truncated}\``;
  const formatted_body = `🔧 <code>${escapeHtml(truncated)}</code>`;
  const content = {
    msgtype: 'm.text',
    body,
    format: 'org.matrix.custom.html',
    formatted_body,
    [`${MATRIX_EVENT_NAMESPACE}.live_output`]: { tool_use_id, command },
  };
  try {
    await client.sendMessage(session.roomId, content);
    return true;
  } catch (e) {
    console.error('Failed to send live_output event:', e.message);
    return false;
  }
}
```

- [ ] **Step 5: Update the boot warning**

Replace (lines ~182–184):

```js
if (!HMAC_SECRET || !VIEWER_BASE_URL) {
  console.warn('[live-output] HMAC_SECRET or VIEWER_BASE_URL unset — live-output tiles disabled');
}
```

with:

```js
if (!HMAC_SECRET || !VIEWER_BASE_URL) {
  console.warn('[viewer] HMAC_SECRET or VIEWER_BASE_URL unset — file links and secure secret/sensitive-data links disabled');
}
```

- [ ] **Step 6: Verify**

Run: `node --check index.js && npm run lint && npx vitest run`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add index.js
git commit -m "feat: stream Bash output via journal pumps; drop live viewer URLs"
```

---

### Task 4: `index.js` tool_result seam — stop pump, upload log, finalize

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `toolStreamPumps`/`toolStreamKey` (Task 3), `toolOutputSnippet`/`decodeByteExact` (Task 1), `journalPublisher.uploadMedia` (existing), `journalPublisher.finalizeToolOutput` (Task 2).
- Produces: `stopAndFinalizeToolStream(session, toolUseId, {exitCode, denied, truncated})` — Task 5 reuses it for teardown.

- [ ] **Step 1: Extend the import**

Change Task 3's import line at the top of `index.js` to:

```js
import { createToolStreamPump, toolOutputSnippet, decodeByteExact } from './lib/tool-stream-pump.js';
```

- [ ] **Step 2: Add the helper**

Directly AFTER the rewritten `sendLiveOutputEvent` function, add:

```js
// Completion seam for a journal-streamed Bash command: stop the pump, read
// the full tee log, upload it as a media blob (tail-capped), and publish the
// durable tool_output completion (spec §5.3) whose payload.message_ref
// retires the live overlay on viewing clients and frees the server-side
// buffer. Called from the tool_result handler (normal end, denied included)
// and killSession (exit_code: null) — every stream ends in exactly one
// finalize; a second call for the same ref is a no-op (the registry entry is
// gone). Fire-and-forget async: the upload is HTTP, and journal problems
// must never touch the Matrix hot path (uploadMedia and finalizeToolOutput
// both already fail open).
const TOOL_LOG_UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // well under the server's 50 MB media cap
const TOOL_SNIPPET_READ_BYTES = 64 * 1024; // decode only the tail we snippet from

function stopAndFinalizeToolStream(session, toolUseId, { exitCode = null, denied = false, truncated = false } = {}) {
  if (!JOURNAL_ENABLED || !session.claudeSessionId) return;
  const key = toolStreamKey(session.claudeSessionId, toolUseId);
  const entry = toolStreamPumps.get(key);
  if (!entry) return; // not a streamed command, or already finalized
  toolStreamPumps.delete(key);
  entry.pump.stop();
  (async () => {
    try {
      let logBuf = null;
      try {
        logBuf = await fs.promises.readFile(entry.logPath);
      } catch { /* denied / tee disabled at spawn: no log file — finalize anyway */ }
      let blobRef = null;
      if (logBuf && logBuf.length > 0) {
        // Tail-cap the upload: the end of a long log (the failure, the
        // summary) is worth more than its head.
        const capped = logBuf.length > TOOL_LOG_UPLOAD_MAX_BYTES
          ? logBuf.subarray(logBuf.length - TOOL_LOG_UPLOAD_MAX_BYTES)
          : logBuf;
        const media = await journalPublisher.uploadMedia({
          bytes: capped,
          contentType: 'text/plain; charset=utf-8',
          name: `tool-output-${toolUseId}.log`,
        });
        if (media) blobRef = media.media_id;
      }
      // Snippet from the decoded tail only. An arbitrary tail cut can start
      // mid-character; decodeByteExact turns those leading continuation
      // bytes into '?', which a snippet tolerates.
      const tail = logBuf && logBuf.length > 0
        ? logBuf.subarray(Math.max(0, logBuf.length - TOOL_SNIPPET_READ_BYTES))
        : null;
      const text = tail ? decodeByteExact(tail).text : '';
      journalPublisher.finalizeToolOutput(session.claudeSessionId, toolUseId, {
        message_ref: toolUseId,
        command: entry.command,
        exit_code: exitCode,
        denied,
        truncated,
        snippet: toolOutputSnippet(text),
        blob_ref: blobRef,
        live_log: true,
      }, blobRef);
    } catch (e) {
      try { console.warn(`[journal] tool-output finalize failed: ${e.message}`); } catch { /* logging must never throw */ }
    }
  })();
}
```

- [ ] **Step 3: Call it from the tool_result handler**

In the `case 'user':` handler (line ~2493), directly after:

```js
              liveOutputStore.markComplete(block.tool_use_id, { exitCode, denied, truncated });
```

add:

```js
              stopAndFinalizeToolStream(session, block.tool_use_id, { exitCode, denied, truncated });
```

- [ ] **Step 4: Verify**

Run: `node --check index.js && npm run lint && npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: finalize journal tool_output with snippet + capped log blob"
```

---

### Task 5: `index.js` session teardown — finalize orphaned streams

**Files:**
- Modify: `index.js`

**Interfaces:**
- Consumes: `toolStreamPumps` (Task 3), `stopAndFinalizeToolStream` (Task 4).
- Produces: nothing new — `recreateSession` already calls `killSession`, so both teardown paths (spec §9) are covered by this one edit.

- [ ] **Step 1: Sweep pumps in `killSession`**

In `killSession` (line ~6166), after the subagent-watcher block and BEFORE the `if (!session.alive) return;` line, add:

```js
  // Stop and finalize any still-open tool-output streams for this session
  // (exit_code: null — the command's real exit will never be observed) so the
  // server frees their buffers now; the idle sweep is the backstop, not the
  // mechanism (spec §9). Before the alive check, like the watcher above: a
  // process that died without delivering tool_result leaves pumps dangling.
  // Deleting entries mid-iteration is safe (Map iterators tolerate deletes),
  // and stopAndFinalizeToolStream no-ops when JOURNAL_ENABLED is off.
  for (const entry of toolStreamPumps.values()) {
    if (entry.session === session) {
      stopAndFinalizeToolStream(session, entry.messageRef, { exitCode: null });
    }
  }
```

- [ ] **Step 2: Verify**

Run: `node --check index.js && npm run lint && npx vitest run`
Expected: all green.

- [ ] **Step 3: Commit**

```bash
git add index.js
git commit -m "feat: finalize open tool-output streams on session teardown"
```

---

### Task 6: End-to-end tests against the real matron-journal server

**Files:**
- Test: `test/journal-publisher.integration.test.js` (append a describe block)

**Interfaces:**
- Consumes: the file's existing harness (`describeIfMatron`, server spawn in `beforeAll`, `connectClient()`, `waitFor`, `delay`, `MATRON_DIR`, `agentToken`, `serverPort`) plus `createToolStreamPump` (Task 1) and the publisher methods (Task 2). Read the existing `beforeAll` before writing — reuse its spawned server and tokens; do NOT spawn a second server.

These tests need the sibling matron-journal checkout to include tool-stream support (PR #11). Guard exactly like `HAS_MATRON`:

```js
const HAS_TOOL_STREAM = HAS_MATRON && existsSync(path.join(MATRON_DIR, 'src/tool-stream.js'));
const describeIfToolStream = HAS_TOOL_STREAM ? describe : describe.skip;
```

- [ ] **Step 1: Write the tests**

Append (inside the file, top-level — a sibling of the existing `describeIfMatron` block, reusing its `beforeAll` state via shared closure variables; if the existing block's variables are block-scoped, nest this describe INSIDE it after the last existing test instead):

```js
  describeIfToolStream('tool-output streaming end-to-end', () => {
    it('pump -> stream_append -> viewing client sees live scrollback; dropped frame self-heals via resync', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'tool-stream-e2e-'));
      const logPath = path.join(dir, 'matron-cmd-e2e1.log');
      writeFileSync(logPath, 'aaaa');

      const resyncs = [];
      let pump; // assigned below; the resync dispatcher closes over it
      const pub = createJournalPublisher({
        url: `ws://127.0.0.1:${serverPort}/ws`,
        token: agentToken,
        log: silentLogLike,
        onStreamResync: (convoId, messageRef, have) => {
          resyncs.push(have);
          pump.resync(have);
        },
      });
      const client = await connectClient();
      const toolFrames = [];
      client.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.kind === 'ephemeral' && msg.tool_stream) toolFrames.push(msg);
      });
      try {
        pub.upsertConvo('e2e-stream-convo', { title: 'stream e2e' });
        client.send({ op: 'viewing', convo_id: 'e2e-stream-convo' });
        await delay(300); // hello_ok + viewing settle

        // Drop exactly one frame (the 'bbbb' append) to force the self-heal.
        let dropNext = false;
        pump = createToolStreamPump({
          logPath,
          convoId: 'e2e-stream-convo',
          messageRef: 'tu-e2e-1',
          meta: { tool: 'Bash', command: 'make e2e' },
          streamAppend: (c, r, off, chunk, meta) => {
            if (dropNext) { dropNext = false; return; }
            pub.streamAppend(c, r, off, chunk, meta);
          },
          throttleMs: 0,
        });
        pump.start();
        await waitFor(() => toolFrames.some((f) =>
          f.message_ref === 'tu-e2e-1' && f.tool_stream.event === 'append' && f.tool_stream.offset === 0));

        dropNext = true;
        appendFileSync(logPath, 'bbbb'); // this frame is swallowed bridge-side
        await delay(300); // give the (dropped) pump pass time to run
        appendFileSync(logPath, 'cccc'); // offset 8 > server end 4 -> stream_resync have:4

        await waitFor(() => resyncs.length >= 1, 10000);
        expect(resyncs[0]).toBe(4);

        // After resync the pump re-sends from byte 4; the client's reassembled
        // stream converges on the full content.
        await waitFor(() => {
          let content = Buffer.alloc(0);
          for (const f of toolFrames.filter((x) => x.message_ref === 'tu-e2e-1' && x.tool_stream.event === 'append')) {
            const chunk = Buffer.from(f.tool_stream.chunk);
            if (f.tool_stream.offset <= content.length) {
              content = Buffer.concat([content.subarray(0, f.tool_stream.offset), chunk]);
            }
          }
          return content.toString('utf-8') === 'aaaabbbbcccc';
        }, 10000);
      } finally {
        pump?.stop();
        client.close();
        pub.close();
        rmSync(dir, { recursive: true, force: true });
      }
    }, 20000);

    it('finalizeToolOutput lands the durable event, retires the stream, and dedupes retries', async () => {
      const pub = createJournalPublisher({
        url: `ws://127.0.0.1:${serverPort}/ws`,
        token: agentToken,
        log: silentLogLike,
      });
      const client = await connectClient();
      const journalFrames = [];
      client.ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.kind === 'journal' && msg.type === 'tool_output') journalFrames.push(msg);
      });
      try {
        pub.upsertConvo('e2e-fin-convo', { title: 'finalize e2e' });
        await delay(300);
        pub.streamAppend('e2e-fin-convo', 'tu-e2e-2', 0, '$ ls\n', { tool: 'Bash', command: 'ls' });
        const payload = {
          message_ref: 'tu-e2e-2', command: 'ls', exit_code: 0, denied: false,
          truncated: false, snippet: '$ ls\n', blob_ref: null, live_log: true,
        };
        pub.finalizeToolOutput('e2e-fin-convo', 'tu-e2e-2', payload, null);
        pub.finalizeToolOutput('e2e-fin-convo', 'tu-e2e-2', payload, null); // idem retry — must dedupe
        await waitFor(() => journalFrames.length >= 1, 10000);
        await delay(500);
        expect(journalFrames).toHaveLength(1); // server idem key fin:<ref> absorbed the retry
        expect(journalFrames[0].payload).toMatchObject({
          message_ref: 'tu-e2e-2', command: 'ls', exit_code: 0, live_log: true,
        });

        // Buffer is freed: a fresh viewing of the convo gets no sync frame.
        const late = await connectClient();
        const lateTool = [];
        late.ws.on('message', (data) => {
          let msg;
          try { msg = JSON.parse(data.toString()); } catch { return; }
          if (msg.kind === 'ephemeral' && msg.tool_stream) lateTool.push(msg);
        });
        late.send({ op: 'viewing', convo_id: 'e2e-fin-convo' });
        await delay(500);
        expect(lateTool).toHaveLength(0);
        late.close();
      } finally {
        client.close();
        pub.close();
      }
    }, 20000);
  });
```

Implementer notes: extend the file's top `fs` import (currently `existsSync, mkdtempSync, rmSync, readFileSync`) with `writeFileSync, appendFileSync`, and add `import { createToolStreamPump } from '../lib/tool-stream-pump.js';`. Define `const silentLogLike = { warn: () => {}, error: () => {} };` near the top of the new block (this file has no `silentLog` helper). The `viewing` op and client frame shapes match the existing tests in this file — follow their idioms if any differ from the above.

- [ ] **Step 2: Run**

Run: `npx vitest run test/journal-publisher.integration.test.js`
Expected: PASS on dev-2 with the matron-journal sibling checkout on a tool-stream-capable branch (`git -C /home/danbarker/matron-journal branch --show-current` — `feat/tool-output-streaming` or master after PR #11 merges); auto-skipped elsewhere.

- [ ] **Step 3: Commit**

```bash
git add test/journal-publisher.integration.test.js
git commit -m "test: end-to-end tool-output streaming against real matron-journal"
```

---

### Task 7: Docs, check script, full CI

**Files:**
- Modify: `package.json`, `README.md`, `docs/superpowers/specs/2026-06-12-matron-events-protocol.md`

- [ ] **Step 1: `package.json` check script**

In the `check` script, after `node --check lib/journal-stream.js`, insert:

```
&& node --check lib/tool-stream-pump.js
```

- [ ] **Step 2: README — retire the live-output reverse-proxy section**

Replace the section starting `### Reverse proxies: the live-output tile needs WebSocket upgrades` (line ~103) and its one-paragraph body with:

```markdown
### Live command output rides the journal protocol

Live Bash output streams to Matron clients over the authenticated
matron-journal WebSocket (`stream_append` frames — see the design spec
`docs/superpowers/specs/2026-07-13-tool-output-streaming-design.md` in the
matron-journal repo). It no longer uses `VIEWER_BASE_URL` or the viewer's
`/live/ws` endpoint, and new `chat.matron.live_output` events carry no
`viewer_url`. The viewer service is still required for file links, secure
secret requests, and one-time sensitive-data links.
```

- [ ] **Step 3: Events-protocol doc — update the live_output row**

In `docs/superpowers/specs/2026-06-12-matron-events-protocol.md`, replace the table row:

```
| `chat.matron.live_output` | bridge → client | Existing live-output viewer-link event (see 2026-05-13 spec) |
```

with:

```
| `chat.matron.live_output` | bridge → client | Bash tool-start event `{tool_use_id, command}`; `viewer_url`/`expires_at` removed 2026-07 — live output now streams over the journal protocol |
```

- [ ] **Step 4: Full CI**

Run: `npm run ci`
Expected: lint, `node --check` (including the new file), full vitest suite, and audit all green.

- [ ] **Step 5: Commit**

```bash
git add package.json README.md docs/superpowers/specs/2026-06-12-matron-events-protocol.md
git commit -m "docs: live output via journal protocol; check tool-stream-pump"
```

---

## Deliberately out of scope (spec non-goals — do not add)

- Removing the viewer's `/live/ws` endpoint or any other `viewer/server.js` change.
- Streaming tools other than Bash (the protocol is tool-agnostic; the bridge wires Bash only).
- Touching `liveOutputStore`, the `.done` sentinel, or log GC — the pump rides that existing lifecycle unchanged.
- matron-apple / matron-web client work.
