import { describe, it, expect, vi } from 'vitest';
import { createRoomDelivery } from '../lib/room-delivery.js';

function makeDelivery({ injectResult = true } = {}) {
  const injectTurn = vi.fn(() => injectResult);
  const delivery = createRoomDelivery({
    isBusy: (session) => !!session.busy,
    injectTurn,
    log: { warn: () => {} },
  });
  return { delivery, injectTurn };
}

const msg = (over = {}) => ({
  roomId: 'room-1', roomTitle: 'CI triage', from: '«matron-dev-2» (agent)',
  body: 'build is red', at: 1000, ...over,
});

describe('createRoomDelivery', () => {
  it('idle session: one immediate injected turn per message, [room "title"] from: body shape', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: false };
    expect(delivery.deliver(session, 'k1', msg())).toBe(true);
    expect(delivery.deliver(session, 'k1', msg({ body: 'now green' }))).toBe(true);
    expect(injectTurn).toHaveBeenCalledTimes(2);
    expect(injectTurn).toHaveBeenNthCalledWith(1, session, '[room "CI triage"] «matron-dev-2» (agent): build is red');
    expect(injectTurn).toHaveBeenNthCalledWith(2, session, '[room "CI triage"] «matron-dev-2» (agent): now green');
    expect(delivery.pendingCount('k1')).toBe(0);
  });

  it('idle session with no room title falls back to roomId', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: false };
    delivery.deliver(session, 'k1', msg({ roomTitle: null }));
    expect(injectTurn).toHaveBeenCalledWith(session, '[room "room-1"] «matron-dev-2» (agent): build is red');
  });

  it('busy session: accumulates pending, injectTurn NOT called', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    expect(delivery.deliver(session, 'k1', msg())).toBe(true);
    expect(delivery.deliver(session, 'k1', msg({ body: 'second' }))).toBe(true);
    expect(injectTurn).not.toHaveBeenCalled();
    expect(delivery.pendingCount('k1')).toBe(2);
  });

  it('flush after busy: exactly one coalesced turn, multi-room sections, pending cleared', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'k1', msg());
    delivery.deliver(session, 'k1', msg({ body: 'and logs attached' }));
    delivery.deliver(session, 'k1', msg({ roomId: 'room-2', roomTitle: 'deploy window', from: '«dan»', body: 'ship at 5?' }));
    session.busy = false;
    expect(delivery.flush(session, 'k1')).toBe(true);
    expect(injectTurn).toHaveBeenCalledTimes(1);
    expect(injectTurn).toHaveBeenCalledWith(session, [
      '[room "CI triage"] 2 messages while you were working:',
      '  «matron-dev-2» (agent): build is red',
      '  «matron-dev-2» (agent): and logs attached',
      '',
      '[room "deploy window"] 1 message while you were working:',
      '  «dan»: ship at 5?',
    ].join('\n'));
    expect(delivery.pendingCount('k1')).toBe(0);
  });

  it('flush uses singular "message" for one pending message and roomId fallback', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'k1', msg({ roomTitle: undefined }));
    session.busy = false;
    expect(delivery.flush(session, 'k1')).toBe(true);
    expect(injectTurn).toHaveBeenCalledWith(session, [
      '[room "room-1"] 1 message while you were working:',
      '  «matron-dev-2» (agent): build is red',
    ].join('\n'));
  });

  it('flush with nothing pending returns false without injecting', () => {
    const { delivery, injectTurn } = makeDelivery();
    expect(delivery.flush({ alive: true, busy: false }, 'k1')).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
  });

  it('flush with dead session: pending dropped, no inject', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'k1', msg());
    session.alive = false;
    expect(delivery.flush(session, 'k1')).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
    expect(delivery.pendingCount('k1')).toBe(0);
  });

  it('flush with null session: pending dropped, no inject', () => {
    const { delivery, injectTurn } = makeDelivery();
    delivery.deliver({ alive: true, busy: true }, 'k1', msg());
    expect(delivery.flush(null, 'k1')).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
    expect(delivery.pendingCount('k1')).toBe(0);
  });

  it('deliver to dead or missing session returns false and queues nothing', () => {
    const { delivery, injectTurn } = makeDelivery();
    expect(delivery.deliver({ alive: false, busy: false }, 'k1', msg())).toBe(false);
    expect(delivery.deliver(null, 'k1', msg())).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
    expect(delivery.pendingCount('k1')).toBe(0);
  });

  it('idle deliver propagates injectTurn refusal', () => {
    const { delivery, injectTurn } = makeDelivery({ injectResult: false });
    expect(delivery.deliver({ alive: true, busy: false }, 'k1', msg())).toBe(false);
    expect(injectTurn).toHaveBeenCalledTimes(1);
  });

  it('injectTurn refusal on flush reports false and does NOT re-queue', () => {
    const { delivery, injectTurn } = makeDelivery({ injectResult: false });
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'k1', msg());
    session.busy = false;
    expect(delivery.flush(session, 'k1')).toBe(false);
    expect(injectTurn).toHaveBeenCalledTimes(1);
    // one delivery attempt only — journal is the durable copy
    expect(delivery.pendingCount('k1')).toBe(0);
    expect(delivery.flush(session, 'k1')).toBe(false);
    expect(injectTurn).toHaveBeenCalledTimes(1);
  });

  it('carryForward moves pending to the new key', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'old', msg());
    delivery.deliver(session, 'old', msg({ body: 'second' }));
    delivery.carryForward('old', 'new');
    expect(delivery.pendingCount('old')).toBe(0);
    expect(delivery.pendingCount('new')).toBe(2);
    session.busy = false;
    expect(delivery.flush(session, 'old')).toBe(false);
    expect(delivery.flush(session, 'new')).toBe(true);
    expect(injectTurn).toHaveBeenCalledTimes(1);
  });

  it('carryForward with nothing pending is a no-op', () => {
    const { delivery } = makeDelivery();
    delivery.carryForward('ghost', 'new');
    expect(delivery.pendingCount('new')).toBe(0);
  });

  it('dropSession clears pending without delivery', () => {
    const { delivery, injectTurn } = makeDelivery();
    const session = { alive: true, busy: true };
    delivery.deliver(session, 'k1', msg());
    delivery.dropSession('k1');
    expect(delivery.pendingCount('k1')).toBe(0);
    session.busy = false;
    expect(delivery.flush(session, 'k1')).toBe(false);
    expect(injectTurn).not.toHaveBeenCalled();
  });

  it('pending inboxes are isolated per session key', () => {
    const { delivery, injectTurn } = makeDelivery();
    const a = { alive: true, busy: true };
    const b = { alive: true, busy: true };
    delivery.deliver(a, 'ka', msg());
    delivery.deliver(b, 'kb', msg({ body: 'for b' }));
    expect(delivery.pendingCount('ka')).toBe(1);
    expect(delivery.pendingCount('kb')).toBe(1);
    a.busy = false;
    expect(delivery.flush(a, 'ka')).toBe(true);
    expect(delivery.pendingCount('kb')).toBe(1);
    expect(injectTurn).toHaveBeenCalledTimes(1);
  });
});
