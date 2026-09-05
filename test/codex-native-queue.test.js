import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { planQueueFlush } from '../lib/queue-flush.js';
import { hasQueuedCompact } from '../lib/compact-priority.js';
const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}
const settle = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  let ack;
  const session = { agent: 'codex', alive: true, busy: true, roomId: 'room', queuedMessages: [], queueNotifications: [], codex: { transport: 'app-server', steer: vi.fn(() => new Promise(resolve => { ack = resolve; })), interrupt: vi.fn() } };
  const context = vm.createContext({ AGENT_CODEX: 'codex', hasQueuedCompact, planQueueFlush, console,
    sessions: new Map([['room', session]]), pendingMediaMirror: () => [], journalMirrorUserMedia: vi.fn(),
    commitDispatchedUserTurn: vi.fn(), journalPublishUserItem: vi.fn(), finalizeSentQueue: vi.fn(),
    journalPublishNotice: vi.fn(), dispatchDeferredCommand: vi.fn(), flushPendingSessionQueue: vi.fn(), maybeFlushRoomDelivery: vi.fn(),
  });
  vm.runInContext(['restoreQueuedBatch', 'flushQueue'].map(sourceOf).join('\n'), context);
  const batch = [[{ type: 'text', text: 'Also check the test' }]];
  const snapshot = { convoId: 'convo', entries: [{ itemId: 'msg-1' }] };
  return { session, context, batch, snapshot, ack: value => ack(value), flush: () => context.flushQueue(session, batch, snapshot) };
}
describe('bridge send-now steering', () => {
  it('does not interrupt or retire queued cards until Codex acknowledges input', async () => {
    const h = setup(); expect(h.flush()).toBe('deferred');
    expect(h.session.codex.interrupt).not.toHaveBeenCalled(); expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
    h.ack(true); await settle();
    expect(h.context.commitDispatchedUserTurn).toHaveBeenCalledTimes(1);
    expect(h.context.finalizeSentQueue).toHaveBeenCalledWith('convo', h.snapshot.entries);
    expect(h.session.busy).toBe(true); expect(h.session._codexSteerPending).toBe(false);
  });
  it('retains definitely rejected messages for turn end', async () => {
    const h = setup(); h.flush(); h.ack(false); await settle();
    expect(h.session.queuedMessages).toEqual(h.batch); expect(h.context.finalizeSentQueue).not.toHaveBeenCalled();
    expect(h.session._codexUncertainSteer).toBe(false);
  });
  it('holds unconfirmed messages even if the turn finishes before acknowledgement', async () => {
    const h = setup(); h.flush(); h.session.busy = false; h.session.codex.steerUncertain = true;
    h.ack(false); await settle();
    expect(h.session.queuedMessages).toEqual(h.batch); expect(h.session._codexUncertainSteer).toBe(true);
    expect(h.context.flushPendingSessionQueue).not.toHaveBeenCalled(); expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
  });
  it('ignores an acknowledgement from a replaced session', async () => {
    const h = setup(); h.flush(); h.context.sessions.set('room', { alive: true }); h.ack(true); await settle();
    expect(h.context.finalizeSentQueue).not.toHaveBeenCalled(); expect(h.context.commitDispatchedUserTurn).not.toHaveBeenCalled();
  });
});
