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

describe('journal publisher hello extras', () => {
  const make = (extra) => createJournalPublisher({
    url: 'ws://journal.test/ws', token: 'test-token', log: { warn() {} },
    backoffBaseMs: 1, backoffCapMs: 1, keepaliveIntervalMs: 0, WebSocketImpl: ControlledWebSocket, ...extra,
  });
  const hello = async (i = 0) => {
    await waitFor(() => ControlledWebSocket.instances[i]?.sent.some((frame) => frame.op === 'hello'));
    return ControlledWebSocket.instances[i].sent.find((frame) => frame.op === 'hello');
  };

  it('without extras the hello is exactly what it was', async () => {
    ControlledWebSocket.instances.length = 0;
    const publisher = make({});
    expect(await hello()).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    publisher.close();
  });

  it('adds what helloExtras returns, read afresh on every connect, and never lets it replace the token', async () => {
    ControlledWebSocket.instances.length = 0;
    let locked = { on: true, until: null };
    const publisher = make({ helloExtras: () => ({ locked, token: 'other', op: 'nope' }) });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null, locked: { on: true, until: null } });
    locked = { on: false, until: 123 };
    ControlledWebSocket.instances[0].close();
    expect((await hello(1)).locked).toEqual({ on: false, until: 123 });
    publisher.close();
  });

  it('a helloExtras that throws or returns nothing leaves the hello as it was', async () => {
    ControlledWebSocket.instances.length = 0;
    const a = make({ helloExtras: () => { throw new Error('boom'); } });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    a.close();
    ControlledWebSocket.instances.length = 0;
    const b = make({ helloExtras: () => null });
    expect(await hello(0)).toEqual({ op: 'hello', token: 'test-token', cursor: null });
    b.close();
  });
});
