import { describe, it, expect } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import net from 'net';
import http from 'node:http';
import { createJournalPublisher } from '../lib/journal-publisher.js';

// Quiet logger for tests that don't care about warnings.
const silentLog = { warn: () => {}, error: () => {} };

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await delay(intervalMs);
  }
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

// Minimal in-process fake journal server: accepts `hello`, replies `hello_ok`,
// and records every other frame it receives (in arrival order). `onFrame`,
// when given, is called with each non-hello frame and may return a reply
// frame to send back (e.g. a control error frame), or a falsy value to send
// nothing — used to simulate a server that rejects an op (e.g. read_marker
// from an agent connection) after having already accepted the socket.
function startFakeServer({ onHello, onFrame } = {}, port = 0) {
  const wss = new WebSocketServer({ port });
  const received = [];
  const connections = [];
  wss.on('connection', (ws) => {
    const conn = { ws, frames: [] };
    connections.push(conn);
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!msg || typeof msg !== 'object') return;
      if (msg.op === 'hello') {
        const reply = (onHello && onHello(msg, conn, connections.length - 1)) || { seq: 0 };
        ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: reply.seq ?? 0 }));
        return;
      }
      conn.frames.push(msg);
      received.push(msg);
      if (onFrame) {
        const reply = onFrame(msg, conn);
        if (reply) ws.send(JSON.stringify(reply));
      }
    });
  });
  return new Promise((resolve, reject) => {
    wss.on('listening', () => {
      const boundPort = wss.address().port;
      resolve({
        port: boundPort,
        url: `ws://127.0.0.1:${boundPort}/ws`,
        received,
        connections,
        close: () => new Promise((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close(r);
        }),
      });
    });
    wss.on('error', reject);
  });
}

// Minimal in-process fake HTTP server for uploadMedia tests. Records every
// request (method, url, headers, raw body bytes) and replies with whatever
// `handler` returns, or a default 200 media-upload response if omitted.
function startFakeHttpServer(handler) {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const entry = { method: req.method, url: req.url, headers: req.headers, body };
      received.push(entry);
      if (handler) {
        handler(entry, res);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          media_id: 'fake-media-id',
          size: body.length,
          content_type: req.headers['content-type'] || 'application/octet-stream',
          sha256: 'fakesha256',
        }));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(r)),
      });
    });
    server.on('error', reject);
  });
}

const FAST_BACKOFF = { backoffBaseMs: 15, backoffCapMs: 60 };

describe('createJournalPublisher', () => {
  it('handshake then publish: convo_upsert precedes the first publish', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-1', { title: 'Room A', sessionState: 'running' });
    pub.publishText('convo-1', { body: 'hi', from: 'user' });

    await waitFor(() => fake.received.length >= 2);

    expect(fake.received[0]).toMatchObject({
      op: 'convo_upsert', convo_id: 'convo-1', title: 'Room A', session_state: 'running',
    });
    expect(fake.received[0].idem_key).toBeUndefined();

    expect(fake.received[1]).toMatchObject({
      op: 'publish', convo_id: 'convo-1', type: 'text', payload: { body: 'hi', from: 'user' },
    });
    expect(typeof fake.received[1].idem_key).toBe('string');
    expect(fake.received[1].idem_key.length).toBeGreaterThan(0);

    pub.close();
    await fake.close();
  });

  it('covers publishPrompt and publishToolOutput with the right types', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-2', {});
    pub.publishPrompt('convo-2', { question: 'Continue?', options: ['yes', 'no'], mode: 'pick_one' });
    pub.publishToolOutput('convo-2', { tool_use_id: 't1', command: 'ls -la', viewer_url: 'https://x', expires_at: 123 });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 2);
    const [prompt, toolOutput] = fake.received.filter(f => f.op === 'publish');
    expect(prompt.type).toBe('prompt');
    expect(prompt.payload).toEqual({ question: 'Continue?', options: ['yes', 'no'], mode: 'pick_one' });
    expect(toolOutput.type).toBe('tool_output');
    expect(toolOutput.payload).toEqual({ tool_use_id: 't1', command: 'ls -la', viewer_url: 'https://x', expires_at: 123 });

    pub.close();
    await fake.close();
  });

  it('flushes frames enqueued while disconnected, in FIFO order, after hello_ok', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    // Enqueued while the socket can't even connect.
    pub.upsertConvo('c1', { title: 'A' });
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.publishText('c1', { body: 'two', from: 'assistant' });
    pub.publishText('c1', { body: 'three', from: 'user' });

    await delay(80); // let a couple of failed connection attempts happen

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 4);

    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'publish', 'publish', 'publish']);
    expect(fake.received.slice(1).map(f => f.payload.body)).toEqual(['one', 'two', 'three']);

    pub.close();
    await fake.close();
  });

  it('reconnects after a mid-stream drop and resends unconfirmed frames with the same idem_key', async () => {
    // A real network drop makes it a coin flip whether ws.send's local callback
    // fires (i.e. the frame becomes "confirmed" and leaves the queue) before the
    // remote actually goes away — that race would make this test flaky either
    // way. So we control the drop precisely at the transport boundary: a
    // WebSocket subclass whose first instance forwards frames onto the real
    // wire (so the fake server genuinely sees them — this is a mid-stream drop,
    // not a pre-send failure) but deliberately never confirms the send callback
    // before killing the connection. Every later instance (i.e. the reconnect)
    // behaves like a normal WebSocket.
    let firstInstanceUsed = false;
    class DropFirstConfirmWebSocket extends WebSocket {
      constructor(...args) {
        super(...args);
        this._isFirst = !firstInstanceUsed;
        firstInstanceUsed = true;
      }
      send(data, cb) {
        if (!this._isFirst) return super.send(data, cb);
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = null; }
        if (!parsed || parsed.op !== 'publish') return super.send(data, cb);
        // Put the bytes on the wire for real, but never confirm locally, then
        // tear the connection down shortly after — an unconfirmed mid-stream drop.
        super.send(data);
        setTimeout(() => {
          try { cb(new Error('simulated drop')); } catch { /* test-only */ }
          try { this.terminate(); } catch { /* already going down */ }
        }, 10);
      }
    }

    const fake = await startFakeServer();
    const pub = createJournalPublisher({
      url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF,
      WebSocketImpl: DropFirstConfirmWebSocket,
    });

    pub.upsertConvo('c1', { title: 'A' });
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.publishText('c1', { body: 'two', from: 'user' });
    pub.publishText('c1', { body: 'three', from: 'user' });

    await waitFor(() => fake.connections.length >= 2
      && fake.connections[1].frames.filter(f => f.op === 'publish').length >= 3, 4000);

    pub.close();
    await fake.close();

    // Connection 1 (the doomed one) really did carry the frames on the wire —
    // sanity check that this was a mid-stream drop, not a pre-send failure.
    const conn1ByBody = new Map(
      fake.connections[0].frames.filter(f => f.op === 'publish').map(f => [f.payload.body, f.idem_key])
    );
    expect(conn1ByBody.size).toBeGreaterThan(0);

    // Connection 2 (the reconnect) received the full set again, in order.
    const conn2Publishes = fake.connections[1].frames.filter(f => f.op === 'publish');
    expect(conn2Publishes.map(f => f.payload.body)).toEqual(['one', 'two', 'three']);

    // Every frame observed on BOTH connections carries the identical idem_key —
    // proof the key is assigned once at enqueue time, not regenerated on resend.
    for (const f of conn2Publishes) {
      if (conn1ByBody.has(f.payload.body)) {
        expect(f.idem_key).toBe(conn1ByBody.get(f.payload.body));
      }
    }
  });

  it('bounds the queue: drops the oldest frame on overflow and warns once per episode', async () => {
    const port = await getFreePort(); // stays disconnected for the whole enqueue burst
    const url = `ws://127.0.0.1:${port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url, token: 'tok', log, queueLimit: 5, ...FAST_BACKOFF });

    for (let i = 0; i < 12; i++) pub.publishText('c1', { body: `m${i}`, from: 'user' });

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 5);
    await delay(100); // confirm nothing extra trickles in beyond the surviving 5

    expect(fake.received.length).toBe(5);
    expect(fake.received.map(f => f.payload.body)).toEqual(['m7', 'm8', 'm9', 'm10', 'm11']);
    expect(warnings.filter(w => /overflow/i.test(w)).length).toBe(1);

    pub.close();
    await fake.close();
  });

  it('disabled mode (no url/token): every method is a safe no-op, nothing throws', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: '', token: '', log });

    expect(() => {
      pub.upsertConvo('c1', { title: 'x', sessionState: 'running' });
      pub.publishText('c1', { body: 'hi', from: 'user' });
      pub.publishPrompt('c1', { question: 'q?', options: [] });
      pub.publishToolOutput('c1', { command: 'ls' });
      pub.publishFile('c1', { blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 1, from: 'user' });
      pub.publishImage('c1', { blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 1, from: 'user' });
      pub.markRead('c1');
      pub.close();
      pub.close(); // idempotent
    }).not.toThrow();

    const uploadResult = await pub.uploadMedia({ bytes: Buffer.from('x'), contentType: 'text/plain', name: 'f.txt' });
    expect(uploadResult == null).toBe(true);

    expect(warnings.length).toBe(1);
  });

  it('upsertConvo never throws even for malformed opts (null, missing, non-object)', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    expect(() => {
      pub.upsertConvo('c1');
      pub.upsertConvo('c1', null);
      pub.upsertConvo('c1', undefined);
      pub.upsertConvo('c1', 'not-an-object');
      pub.upsertConvo('c1', { title: 'ok' });
    }).not.toThrow();

    await waitFor(() => fake.received.filter(f => f.op === 'convo_upsert').length >= 1);
    pub.close();
    await fake.close();
  });

  it('disabled mode when only the token is missing', () => {
    const log = { warn: () => {}, error: () => {} };
    expect(() => {
      const pub = createJournalPublisher({ url: 'ws://127.0.0.1:1/ws', token: '', log });
      pub.publishText('c1', { body: 'hi', from: 'user' });
      pub.close();
    }).not.toThrow();
  });

  it('never assigns an idem_key with the fin: prefix reserved by finalize', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    for (let i = 0; i < 25; i++) pub.publishText('c1', { body: `m${i}`, from: 'user' });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 25);
    const idemKeys = fake.received.filter(f => f.op === 'publish').map(f => f.idem_key);
    expect(idemKeys.length).toBe(25);
    expect(new Set(idemKeys).size).toBe(25); // all unique
    for (const k of idemKeys) {
      expect(k.startsWith('fin:')).toBe(false);
      expect(k).toMatch(/^[0-9a-f-]{36}$/i);
    }

    pub.close();
    await fake.close();
  });

  it('sends the hello frame with cursor:null (live-only, no replay)', async () => {
    let helloMsg = null;
    const fake = await startFakeServer({ onHello: (msg) => { helloMsg = msg; return { seq: 0 }; } });
    const pub = createJournalPublisher({ url: fake.url, token: 'secret-tok', log: silentLog, ...FAST_BACKOFF });
    pub.publishText('c1', { body: 'x', from: 'user' });
    await waitFor(() => helloMsg !== null);
    expect(helloMsg).toMatchObject({ op: 'hello', token: 'secret-tok', cursor: null });
    pub.close();
    await fake.close();
  });

  it('publishFile and publishImage send the right publish type, with payload passthrough and idem keys', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-3', {});
    pub.publishFile('convo-3', { blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 42, from: 'user' });
    pub.publishImage('convo-3', { blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 99, from: 'assistant', dims: { w: 10, h: 20 } });

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 2);
    const [file, image] = fake.received.filter(f => f.op === 'publish');

    expect(file.type).toBe('file');
    expect(file.payload).toEqual({ blob_ref: 'm1', content_type: 'application/pdf', name: 'doc.pdf', size: 42, from: 'user' });
    expect(typeof file.idem_key).toBe('string');

    expect(image.type).toBe('image');
    expect(image.payload).toEqual({ blob_ref: 'm2', content_type: 'image/png', name: 'pic.png', size: 99, from: 'assistant', dims: { w: 10, h: 20 } });
    expect(typeof image.idem_key).toBe('string');

    pub.close();
    await fake.close();
  });

  it('markRead enqueues a read_marker frame with no idem_key, FIFO right after the preceding publish', async () => {
    const fake = await startFakeServer();
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('convo-4', {});
    pub.publishText('convo-4', { body: 'hi', from: 'user' });
    pub.markRead('convo-4');

    await waitFor(() => fake.received.length >= 3);
    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'publish', 'read_marker']);

    const marker = fake.received[2];
    expect(marker).toEqual({ op: 'read_marker', convo_id: 'convo-4', up_to_seq: null });
    expect(marker.idem_key).toBeUndefined();

    pub.close();
    await fake.close();
  });

  it('markRead is re-sent after a reconnect, same as any other frame', async () => {
    const port = await getFreePort(); // nothing listening yet
    const url = `ws://127.0.0.1:${port}/ws`;
    const pub = createJournalPublisher({ url, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    pub.upsertConvo('c1', { title: 'A' });
    pub.markRead('c1');

    await delay(80); // let a couple of failed connection attempts happen

    const fake = await startFakeServer({}, port);
    await waitFor(() => fake.received.length >= 2);

    expect(fake.received.map(f => f.op)).toEqual(['convo_upsert', 'read_marker']);

    pub.close();
    await fake.close();
  });

  it('an error frame from the server (e.g. forbidden for read_marker against an old server) is logged once per code and never wedges the queue', async () => {
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    // Simulates today's matron-journal, which rejects agent read_marker with
    // a 'forbidden' control error frame — every single time, since it isn't
    // stateful. The publisher calls markRead after every user-mirrored
    // publish, so without per-code dedup this would warn once per user
    // message forever.
    const fake = await startFakeServer({
      onFrame: (msg) => (msg.op === 'read_marker' ? { kind: 'control', op: 'error', code: 'forbidden', ref: 'read_marker' } : null),
    });
    const pub = createJournalPublisher({ url: fake.url, token: 'tok', log, ...FAST_BACKOFF });

    pub.upsertConvo('c1', {});
    pub.publishText('c1', { body: 'one', from: 'user' });
    pub.markRead('c1');
    pub.publishText('c1', { body: 'two', from: 'user' });
    pub.markRead('c1');
    pub.publishText('c1', { body: 'three', from: 'user' });
    pub.markRead('c1');

    await waitFor(() => fake.received.filter(f => f.op === 'publish').length >= 3);
    await delay(80); // let the rejected read_marker error frames round-trip back

    // Every publish still flowed despite every read_marker being rejected —
    // the queue never wedged.
    expect(fake.received.filter(f => f.op === 'publish').map(f => f.payload.body)).toEqual(['one', 'two', 'three']);
    expect(fake.received.filter(f => f.op === 'read_marker').length).toBe(3);

    // Only one warning for the repeated 'forbidden' code, not one per frame.
    const forbiddenWarnings = warnings.filter(w => /forbidden/.test(w));
    expect(forbiddenWarnings.length).toBe(1);

    pub.close();
    await fake.close();
  });

  it('uploadMedia: happy path POSTs raw bytes to the derived HTTP base URL with Bearer auth and Content-Type', async () => {
    const httpServer = await startFakeHttpServer();
    // ws:// -> http://, strip trailing /ws, per the fixed contract.
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok-123', log: silentLog, ...FAST_BACKOFF });

    const bytes = Buffer.from('hello media bytes');
    const result = await pub.uploadMedia({ bytes, contentType: 'image/png', name: 'photo.png' });

    expect(result).toEqual({
      media_id: 'fake-media-id',
      size: bytes.length,
      content_type: 'image/png',
      sha256: 'fakesha256',
    });

    // The publisher's own WS connection attempt also lands on this HTTP
    // server (it's a plain http.createServer, so the WS upgrade request
    // just arrives as an ordinary GET /ws) — filter down to the actual
    // /media POST rather than asserting on every request this server saw.
    const mediaRequests = httpServer.received.filter(r => r.url === '/media');
    expect(mediaRequests.length).toBe(1);
    const req = mediaRequests[0];
    expect(req.method).toBe('POST');
    expect(req.headers['authorization']).toBe('Bearer tok-123');
    expect(req.headers['content-type']).toBe('image/png');
    expect(req.body.equals(bytes)).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a non-2xx HTTP response resolves null, never throws', async () => {
    const httpServer = await startFakeHttpServer((_entry, res) => {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'too_large' }));
    });
    const wsUrl = `ws://127.0.0.1:${httpServer.port}/ws`;
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log: silentLog, ...FAST_BACKOFF });

    const result = await pub.uploadMedia({ bytes: Buffer.alloc(10), contentType: 'application/octet-stream', name: 'big.bin' });
    expect(result == null).toBe(true);

    pub.close();
    await httpServer.close();
  });

  it('uploadMedia: a network failure (nothing listening) resolves null, never throws, and warns exactly once', async () => {
    const port = await getFreePort(); // nothing listening
    const wsUrl = `ws://127.0.0.1:${port}/ws`;
    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({ url: wsUrl, token: 'tok', log, ...FAST_BACKOFF });

    warnings.length = 0; // drop any reconnect-attempt warnings from the WS side
    const result = await pub.uploadMedia({ bytes: Buffer.from('x'), contentType: 'text/plain', name: 'f.txt' });
    expect(result == null).toBe(true);

    const uploadWarnings = warnings.filter(w => /uploadMedia/.test(w));
    expect(uploadWarnings.length).toBe(1);

    pub.close();
  });
});
