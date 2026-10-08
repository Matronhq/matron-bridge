import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createJournalPublisher } from '../lib/journal-publisher.js';

class ControlledWebSocket extends EventEmitter {
  static instances = [];

  constructor() {
    super();
    this.readyState = WebSocket.OPEN;
    this.sent = [];
    ControlledWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(data, callback) {
    this.sent.push(JSON.parse(data));
    callback?.();
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise(resolve => setTimeout(resolve, 1));
  }
}

describe('journal publisher onSettings', () => {
  it('hands on hello_ok settings (null when absent) and every control settings frame', async () => {
    ControlledWebSocket.instances.length = 0;
    const calls = [];
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {} },
      backoffBaseMs: 1,
      backoffCapMs: 1,
      keepaliveIntervalMs: 0,
      WebSocketImpl: ControlledWebSocket,
      onSettings: (settings, meta) => calls.push([settings, meta]),
    });

    await waitFor(() => ControlledWebSocket.instances[0]?.sent.some(frame => frame.op === 'hello'));
    const ws = ControlledWebSocket.instances[0];
    ws.emit('message', JSON.stringify({ op: 'hello_ok', settings: { notices: false } }));
    ws.emit('message', JSON.stringify({ kind: 'control', op: 'settings', settings: { notices: true } }));
    // A settings frame with nothing in it carries no news.
    ws.emit('message', JSON.stringify({ kind: 'control', op: 'settings' }));
    ws.emit('message', JSON.stringify({ op: 'hello_ok' }));
    expect(calls).toEqual([
      [{ notices: false }, { hello: true }],
      [{ notices: true }, { hello: false }],
      [null, { hello: true }],
    ]);

    publisher.close();
  });

  it('a throwing handler never stops hello_ok from completing', async () => {
    ControlledWebSocket.instances.length = 0;
    const reconnects = [];
    const publisher = createJournalPublisher({
      url: 'ws://journal.test/ws',
      token: 'test-token',
      log: { warn() {} },
      backoffBaseMs: 1,
      backoffCapMs: 1,
      keepaliveIntervalMs: 0,
      WebSocketImpl: ControlledWebSocket,
      onSettings: () => { throw new Error('boom'); },
      onReconnect: () => reconnects.push(1),
    });
    await waitFor(() => ControlledWebSocket.instances[0]?.sent.some(frame => frame.op === 'hello'));
    ControlledWebSocket.instances[0].emit('message', JSON.stringify({ op: 'hello_ok', settings: { notices: true } }));
    expect(reconnects).toEqual([1]);
    publisher.close();
  });
});
