import { randomUUID } from 'crypto';
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
// uncaught exception in the bridge's hot path.

const DEFAULT_QUEUE_LIMIT = 5000;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_CAP_MS = 30000;

function noopPublisher() {
  return {
    upsertConvo() {},
    publishText() {},
    publishPrompt() {},
    publishToolOutput() {},
    close() {},
  };
}

export function createJournalPublisher({
  url,
  token,
  log = console,
  queueLimit = DEFAULT_QUEUE_LIMIT,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffCapMs = DEFAULT_BACKOFF_CAP_MS,
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

  function warn(msg) {
    try { log.warn(msg); } catch { /* never let logging throw */ }
  }

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
        socket.send(JSON.stringify({ op: 'hello', token, cursor: null }));
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
        pump();
      } else if (msg.op === 'error') {
        warn(`[journal-publisher] server error frame: ${JSON.stringify(msg)}`);
      }
      // All other inbound frames (the server fanning the user's own journal
      // traffic back) are intentionally ignored — this module only publishes.
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

  return {
    upsertConvo(convoId, { title, sessionState } = {}) {
      try {
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
    close() {
      try {
        closed = true;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (ws) {
          const socket = ws;
          ws = null;
          try { socket.removeAllListeners(); } catch { /* best effort */ }
          try { socket.terminate(); } catch { /* best effort */ }
        }
      } catch { /* close() must never throw */ }
    },
  };
}
