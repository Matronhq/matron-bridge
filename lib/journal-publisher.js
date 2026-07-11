import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { readFileSync, writeFileSync } from 'fs';
import WebSocket from 'ws';

// Injectable journal dual-post publisher, in the style of lib/live-output.js:
// a plain factory that the bridge wires in and everything else stays ignorant
// of. See docs/superpowers/specs/2026-07-10-matron-protocol-design.md in
// matron-journal for the wire protocol this speaks.
//
// Contract with callers (index.js): every method here MUST fail open. A
// journal outage, a bad token, a network partition, a malformed frame from
// the server — none of it may ever throw, reject, block, or otherwise touch
// Matrix behavior. Every public method below is wrapped so a bug in this
// module degrades to "journal mirroring silently stops" rather than an
// uncaught exception in the bridge's hot path. publishFile/publishImage and
// markRead follow the same contract as the original text/prompt/tool_output
// trio; uploadMedia is the one method that isn't queued (see its own
// comment). publishActivity is the one method that is EPHEMERAL rather than
// durable: unlike every method above, it is never enqueued, never retried,
// and never replayed on reconnect — see its own comment for why.

const DEFAULT_QUEUE_LIMIT = 5000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;
const DEFAULT_CURSOR_DEBOUNCE_MS = 1000;

function noopPublisher() {
  return {
    upsertConvo() {},
    publishText() {},
    publishPrompt() {},
    publishToolOutput() {},
    publishFile() {},
    publishImage() {},
    publishActivity() {},
    markRead() {},
    uploadMedia() { return null; },
    flushCursor() {},
    close() {},
  };
}

// Media HTTP base URL is derived from the WS URL per the fixed contract:
// ws:// -> http://, wss:// -> https://, strip a trailing /ws path segment.
// Exported for direct unit coverage; index.js never needs to call this
// itself since uploadMedia does the derivation internally.
export function deriveMediaHttpBaseUrl(wsUrl) {
  if (!wsUrl) return null;
  return wsUrl
    .replace(/^ws:\/\//, 'http://')
    .replace(/^wss:\/\//, 'https://')
    .replace(/\/ws\/?$/, '');
}

export function createJournalPublisher({
  url,
  token,
  log = console,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
  // Inbound-event delivery (Matron -> bridge input). When set, every inbound
  // `{kind:'journal'}` frame — replayed AND live, from every sender
  // (agent-echoes included: loop-prevention filtering is the caller's job,
  // not this module's) — is handed to onEvent, at most once per seq. Left
  // unset, this module behaves exactly as it always has: publish-only, every
  // inbound frame other than hello_ok/error silently ignored.
  onEvent,
  // Where the highest seq seen is persisted (debounced) so a restart resumes
  // input from where it left off instead of reconnecting live-only forever.
  // Only meaningful when onEvent is set.
  cursorFile,
  cursorDebounceMs = DEFAULT_CURSOR_DEBOUNCE_MS,
  // Transport injection point for tests only (e.g. to deterministically
  // simulate a dropped/unconfirmed send). index.js never passes this — the
  // real bridge always talks to the actual `ws` WebSocket implementation.
  WebSocketImpl = WebSocket,
} = {}) {
  if (!url || !token) {
    // Matches the disabled-if-unset pattern for HMAC_SECRET/VIEWER_BASE_URL
    // (index.js:162-164): one warning at construction, then a cheap no-op.
    try { log.warn('[journal-publisher] JOURNAL_WS_URL or journal token unset — journal dual-post disabled'); } catch { /* logging must never throw */ }
    return noopPublisher();
  }

  // Derived once at construction; uploadMedia POSTs here. Never re-derived
  // per call — index.js only ever constructs this once at boot.
  const mediaHttpBaseUrl = deriveMediaHttpBaseUrl(url);

  // FIFO queue of not-yet-confirmed frames. Each entry stays in the queue
  // until ws.send(data, cb) confirms the write; frames still present when the
  // socket dies are re-sent, in the same order, on the next connection.
  const queue = [];
  let ws = null;
  let connected = false;
  let closed = false;
  let reconnectTimer = null;
  let reconnectAttempts = 0;
  let overflowActive = false;
  // Inbound `error` control frames are logged once per distinct code PER
  // CONNECTION EPOCH (the set is cleared on every hello_ok), not once per
  // occurrence. A read_marker sent to a server that hasn't yet landed agent
  // read_marker support (matron-journal PR #2) rejects every single one with
  // the same 'forbidden' code, and markRead is called after every
  // user-mirrored publish — without this dedup that's an unbounded stream of
  // identical warnings for a condition the first warning already fully
  // describes. Resetting per epoch keeps the anti-spam property within a
  // connection while restoring observability across reconnects: a later,
  // unrelated problem that happens to reuse a previously-seen code (e.g. a
  // real bad_request days after a first one) still gets logged on the next
  // connection instead of staying permanently invisible.
  const warnedErrorCodes = new Set();

  function warn(msg) {
    try { log.warn(msg); } catch { /* never let logging throw */ }
  }

  // --- Inbound cursor tracking (only meaningful when onEvent is set) ---
  //
  // `lastSeq` is the high-water mark of every journal frame seen THIS
  // process lifetime (set even for frames onEvent-delivery skips for other
  // reasons — there are none today, but the field's job is "what's the
  // highest seq I've observed", not "what did onEvent see"). It seeds the
  // cursor sent on every hello (so a reconnect resumes rather than
  // re-replaying from disk), and is the dedupe boundary: a replayed frame
  // with seq <= lastSeq was already delivered and must not be delivered
  // again. It is never reset except by snapshot_required (back to null,
  // live-only) — reconnects do NOT reset it, which is exactly what makes the
  // dedupe work across the replay-overlap window (persisted cursor can lag
  // behind lastSeq by up to cursorDebounceMs of traffic).
  let lastSeq = null;
  let cursorDirty = false;
  let cursorTimer = null;

  function loadPersistedCursor() {
    if (!cursorFile) return null;
    try {
      const raw = readFileSync(cursorFile, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Number.isInteger(parsed?.cursor) && parsed.cursor >= 0) return parsed.cursor;
      return null;
    } catch {
      // Missing file, unreadable, or malformed JSON — all treated the same:
      // no cursor. This is the "first boot" case (spec: hello with null,
      // live-only — never replay history as input).
      return null;
    }
  }

  function persistCursorNow() {
    if (!cursorFile) return;
    try {
      writeFileSync(cursorFile, JSON.stringify({ cursor: lastSeq }));
      cursorDirty = false;
    } catch (e) {
      warn(`[journal-publisher] failed to persist cursor file: ${e.message}`);
    }
  }

  function scheduleCursorPersist() {
    if (!cursorFile) return;
    cursorDirty = true;
    if (cursorTimer) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (cursorDirty) persistCursorNow();
    }, cursorDebounceMs);
    if (typeof cursorTimer.unref === 'function') cursorTimer.unref();
  }

  if (onEvent) lastSeq = loadPersistedCursor();

  function enqueue(frame) {
    queue.push({ frame, sending: false });
    if (queue.length > queueLimit) {
      queue.shift();
      if (!overflowActive) {
        overflowActive = true;
        warn(`[journal-publisher] queue overflow (>${queueLimit} frames) — dropping oldest`);
      }
    } else if (overflowActive) {
      overflowActive = false;
    }
    pump();
  }

  function pump() {
    if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
    // Snapshot the array before iterating: sent entries splice themselves out
    // of `queue` from inside the send callback, which can fire synchronously
    // or interleaved with this loop.
    for (const entry of queue.slice()) {
      if (entry.sending) continue;
      entry.sending = true;
      let data;
      try {
        data = JSON.stringify(entry.frame);
      } catch (e) {
        // Unserializable payload: drop this one frame rather than wedge the
        // whole queue behind it forever.
        warn(`[journal-publisher] dropping unserializable frame: ${e.message}`);
        const idx = queue.indexOf(entry);
        if (idx !== -1) queue.splice(idx, 1);
        continue;
      }
      const socket = ws;
      try {
        socket.send(data, (err) => {
          if (err) {
            // Unconfirmed — leave it in the queue, retried on next connect.
            entry.sending = false;
            return;
          }
          const idx = queue.indexOf(entry);
          if (idx !== -1) queue.splice(idx, 1);
        });
      } catch {
        entry.sending = false;
      }
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    const delay = Math.min(backoffBaseMs * (2 ** reconnectAttempts), backoffCapMs);
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function markDown(socket) {
    if (socket !== ws) return; // stale handler from a socket we've already replaced
    connected = false;
    ws = null;
    for (const entry of queue) entry.sending = false;
    scheduleReconnect();
  }

  function connect() {
    if (closed) return;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (e) {
      warn(`[journal-publisher] connect failed: ${e.message}`);
      scheduleReconnect();
      return;
    }
    ws = socket;
    connected = false;

    socket.on('open', () => {
      if (socket !== ws) return;
      try {
        // onEvent unset -> always live-only (cursor:null), matching this
        // module's original publish-only behavior exactly. onEvent set -> the
        // in-memory high-water mark (null until the first frame is ever seen,
        // e.g. no cursor file on first boot — live-only by construction).
        const cursor = onEvent ? lastSeq : null;
        socket.send(JSON.stringify({ op: 'hello', token, cursor }));
      } catch (e) {
        warn(`[journal-publisher] failed to send hello: ${e.message}`);
      }
    });

    socket.on('message', (data) => {
      if (socket !== ws) return;
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello_ok') {
        connected = true;
        reconnectAttempts = 0;
        // New connection epoch: reset the per-code error-warning dedup so a
        // recurring (or recurring-looking) problem is logged once per
        // connection rather than once per publisher lifetime.
        warnedErrorCodes.clear();
        pump();
      } else if (msg.op === 'error') {
        const code = msg.code || 'unknown';
        if (!warnedErrorCodes.has(code)) {
          warnedErrorCodes.add(code);
          warn(`[journal-publisher] server error frame: ${JSON.stringify(msg)}`);
        }
      } else if (msg.op === 'snapshot_required') {
        // The replay gap from our persisted cursor is too large. Efficiency
        // valve, not a data-loss boundary (spec §6) — but we have no snapshot
        // consumer here, only a live-input stream, so the correct response is
        // to give up on replay and go live-only: reset the in-memory
        // high-water mark and rewrite the cursor file, so the NEXT hello (the
        // server also closes this socket with 4009 right after this frame,
        // which triggers the normal reconnect-with-backoff path) asks for
        // live traffic only rather than tripping the same valve forever.
        // Anything sent by the user during the now-abandoned gap is lost from
        // the input side — the journal itself still has it forever, just not
        // as a bridge input replay.
        warn('[journal-publisher] snapshot_required — input replay gap too large, resetting to live-only (client inputs sent during the gap were skipped)');
        lastSeq = null;
        cursorDirty = false;
        if (cursorTimer) { clearTimeout(cursorTimer); cursorTimer = null; }
        persistCursorNow();
      } else if (msg.kind === 'journal' && onEvent) {
        const seq = msg.seq;
        if (typeof seq === 'number' && lastSeq != null && seq <= lastSeq) {
          return; // already delivered — replay overlap after a reconnect.
        }
        if (typeof seq === 'number') {
          lastSeq = seq;
          scheduleCursorPersist();
        }
        try {
          onEvent(msg);
        } catch (e) {
          warn(`[journal-publisher] onEvent handler threw: ${e.message}`);
        }
      }
      // All other inbound frames (ephemeral deltas, unrecognised control ops)
      // are intentionally ignored.
    });

    socket.on('close', () => markDown(socket));
    socket.on('error', (e) => {
      warn(`[journal-publisher] socket error: ${e.message}`);
      try { socket.terminate(); } catch { /* already going down */ }
    });
  }

  connect();

  function safePublish(convoId, type, payload) {
    try {
      enqueue({ op: 'publish', convo_id: convoId, type, payload, idem_key: randomUUID() });
    } catch (e) {
      warn(`[journal-publisher] publish${type} failed: ${e.message}`);
    }
  }

  // Not queued, unlike everything else here: a media blob has to actually
  // reach the journal server's blob store before the file/image publish that
  // references it means anything, so this is best-effort HTTP work done at
  // call time (POST /media, Bearer <agent token>, raw bytes). Every failure
  // mode — no base URL, missing bytes, network error, non-2xx response, a
  // response body that isn't the JSON we expect — resolves to null rather
  // than rejecting; callers are expected to skip the event publish when this
  // returns null (a file/image event without a blob is useless).
  async function uploadMedia({ bytes, filePath, contentType, name } = {}) {
    if (!mediaHttpBaseUrl) return null;
    try {
      let body = bytes;
      if (body == null && filePath) {
        body = await readFile(filePath);
      }
      if (body == null) {
        warn(`[journal-publisher] uploadMedia called with neither bytes nor filePath (name=${name || '(unnamed)'})`);
        return null;
      }
      const res = await fetch(`${mediaHttpBaseUrl}/media`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': contentType || 'application/octet-stream',
        },
        body,
      });
      if (!res.ok) {
        warn(`[journal-publisher] uploadMedia failed: HTTP ${res.status} (name=${name || '(unnamed)'})`);
        return null;
      }
      const data = await res.json();
      // A 2xx status alone doesn't guarantee a usable body — guard against a
      // response missing (or with a non-string) media_id, which would
      // otherwise flow into publishFile/publishImage as blob_ref: undefined.
      // Treat that the same as any other upload failure: null + one warn, so
      // the caller skips the event publish (see this function's own comment).
      if (typeof data.media_id !== 'string' || data.media_id.length === 0) {
        warn(`[journal-publisher] uploadMedia failed: response missing media_id (name=${name || '(unnamed)'})`);
        return null;
      }
      return {
        media_id: data.media_id,
        size: data.size,
        content_type: data.content_type,
        sha256: data.sha256,
      };
    } catch (e) {
      warn(`[journal-publisher] uploadMedia failed: ${e.message} (name=${name || '(unnamed)'})`);
      return null;
    }
  }

  return {
    upsertConvo(convoId, opts) {
      // Destructuring happens inside the try, not in the parameter list: a
      // caller passing `null` (as opposed to omitting the arg / passing
      // undefined) would otherwise throw before fail-open protection kicks in.
      try {
        const { title, sessionState } = opts || {};
        const frame = { op: 'convo_upsert', convo_id: convoId };
        if (title !== undefined) frame.title = title;
        if (sessionState !== undefined) frame.session_state = sessionState;
        enqueue(frame);
      } catch (e) {
        warn(`[journal-publisher] upsertConvo failed: ${e.message}`);
      }
    },
    publishText(convoId, payload) {
      safePublish(convoId, 'text', payload);
    },
    publishPrompt(convoId, payload) {
      safePublish(convoId, 'prompt', payload);
    },
    publishToolOutput(convoId, payload) {
      safePublish(convoId, 'tool_output', payload);
    },
    publishFile(convoId, payload) {
      safePublish(convoId, 'file', payload);
    },
    publishImage(convoId, payload) {
      safePublish(convoId, 'image', payload);
    },
    // EPHEMERAL — the opposite of every method above. A typing/activity
    // indicator ('thinking' | 'tool' | 'idle') is only meaningful live: a
    // dropped one is harmless (the next state change repaints it), but a
    // queued one replayed minutes later after a reconnect would show the
    // user a stale "Claude is thinking…" long after the turn actually
    // ended — worse than not sending it at all. So, unlike safePublish
    // above: no enqueue (bypasses `queue`/`pump` entirely), no idem_key (an
    // ephemeral has no identity to dedupe by), no resend on reconnect. Fires
    // the frame immediately if the socket is connected (i.e. past hello_ok);
    // otherwise drops it silently. Still fails open like everything else
    // here — a throw here must never reach index.js's hot path.
    publishActivity(convoId, state, detail) {
      try {
        if (closed || !connected || !ws || ws.readyState !== WebSocket.OPEN) return;
        const frame = { op: 'activity', convo_id: convoId, state };
        if (detail !== undefined) frame.detail = detail;
        let data;
        try {
          data = JSON.stringify(frame);
        } catch (e) {
          warn(`[journal-publisher] dropping unserializable activity frame: ${e.message}`);
          return;
        }
        ws.send(data);
      } catch (e) {
        warn(`[journal-publisher] publishActivity failed: ${e.message}`);
      }
    },
    // No idem_key: re-sending after a reconnect is a harmless re-mark (the
    // server just advances the same read marker again), so this doesn't need
    // the dedup that idem_key gives publishes. Otherwise identical to every
    // other frame here — enqueued FIFO, confirmed on ws.send's callback,
    // re-sent on reconnect if it was never confirmed.
    markRead(convoId) {
      try {
        enqueue({ op: 'read_marker', convo_id: convoId, up_to_seq: null });
      } catch (e) {
        warn(`[journal-publisher] markRead failed: ${e.message}`);
      }
    },
    uploadMedia,
    // Force the inbound cursor to disk NOW, bypassing the debounce. Called by
    // index.js right after dispatching a control-convo command or a
    // prompt_reply: those inputs have side effects (a session spawned, a
    // prompt answered), so an ungraceful crash inside the ~1s debounce window
    // must not replay them on restart as if they never happened. Same
    // fails-open contract as everything else here.
    flushCursor() {
      try {
        if (cursorTimer) {
          clearTimeout(cursorTimer);
          cursorTimer = null;
        }
        if (cursorDirty) persistCursorNow();
      } catch { /* flushCursor() must never throw */ }
    },
    close() {
      try {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (cursorTimer) {
          clearTimeout(cursorTimer);
          cursorTimer = null;
        }
        if (cursorDirty) persistCursorNow();
        if (ws) {
          const socket = ws;
          ws = null;
          try { socket.removeAllListeners(); } catch { /* best effort */ }
          // terminate() on a still-CONNECTING socket makes `ws` emit 'error'
          // ("closed before the connection was established") — with all
          // listeners just removed that would be an uncaught exception, so
          // re-attach a swallow-all handler first.
          try { socket.on('error', () => {}); } catch { /* best effort */ }
          try { socket.terminate(); } catch { /* best effort */ }
        }
      } catch { /* close() must never throw */ }
    },
  };
}
