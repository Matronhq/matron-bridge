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

  it('the disabled no-op publisher has a respondRpc stub', () => {
    const noop = createJournalPublisher({ url: null, token: null, log: silentLog });
    expect(typeof noop.respondRpc).toBe('function');
    expect(() => noop.respondRpc({ requestId: 'r', toDeviceId: 1, ok: true })).not.toThrow();
  });
});
