import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createNoteDelivery, NOTE_FIRST_DELAY_MS, NOTE_RETRY_MS, NOTE_MAX_ATTEMPTS,
} from '../lib/restart-note-delivery.js';
import { createRestartNotes, takeNoteDeliveries } from '../lib/restart-notes.js';

const NOW = 1_800_000_000_000;

// A manual scheduler: timers run when the test says so, in due order.
function clock() {
  const state = { t: 0, timers: [] };
  const schedule = (fn, ms) => { state.timers.push({ at: state.t + ms, fn }); };
  const advance = async (ms) => {
    const end = state.t + ms;
    for (;;) {
      state.timers.sort((a, b) => a.at - b.at);
      const next = state.timers[0];
      if (!next || next.at > end) break;
      state.timers.shift();
      state.t = next.at;
      next.fn();
      // Let the async attempt settle before the next timer.
      for (let i = 0; i < 5; i++) await Promise.resolve();
    }
    state.t = end;
  };
  return { state, schedule, advance, now: () => NOW + state.t };
}

const note = (convoId, extra = {}) => ({ convoId, text: `note for ${convoId}`, ageMs: 0, interrupted: false, ...extra });

function setup(deliverResults, opts = {}) {
  const c = clock();
  const calls = [];
  const cards = [];
  const discards = [];
  const logs = [];
  const results = [...deliverResults];
  const delivery = createNoteDelivery({
    deliver: async (n) => { calls.push({ ...n, at: c.state.t }); const r = results.shift(); if (r instanceof Error) throw r; return r; },
    recover: (n) => { cards.push(n.convoId); if (opts.recoverThrows) throw new Error('card failed'); },
    discard: (taken) => { discards.push(taken); if (opts.discardThrows) throw new Error('EACCES'); },
    schedule: c.schedule, now: c.now, log: (m) => logs.push(m),
  });
  return { c, calls, cards, discards, logs, delivery };
}

describe('resume note delivery', () => {
  it('delivers once after the first delay and then removes the notes', async () => {
    const t = setup([true]);
    const taken = [{ convoId: 'a', writtenAt: 1 }];
    t.delivery.start([note('a')], taken);
    expect(t.calls).toHaveLength(0);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.cards).toEqual([]);
    expect(t.discards).toEqual([taken]);
    await t.c.advance(10 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(1);
  });

  it('retries a failed delivery after the backoff and does not remove the notes until it works', async () => {
    const t = setup([false, true]);
    t.delivery.start([note('a')], [{ convoId: 'a', writtenAt: 1 }]);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls).toHaveLength(1);
    expect(t.discards).toEqual([]);
    await t.c.advance(NOTE_RETRY_MS - 1);
    expect(t.calls).toHaveLength(1);
    await t.c.advance(1);
    expect(t.calls).toHaveLength(2);
    expect(t.discards).toHaveLength(1);
    expect(t.cards).toEqual([]);
  });

  it('counts a throw and a non-true result as failures', async () => {
    const t = setup([new Error('boom'), undefined, true]);
    t.delivery.start([note('a')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS + 2 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(3);
    expect(t.cards).toEqual([]);
    expect(t.discards).toHaveLength(1);
  });

  it('publishes the Carry on card after the last attempt and then removes the notes', async () => {
    const t = setup([false, false, false]);
    t.delivery.start([note('a')], [{ convoId: 'a', writtenAt: 1 }]);
    await t.c.advance(NOTE_FIRST_DELAY_MS + (NOTE_MAX_ATTEMPTS - 1) * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(NOTE_MAX_ATTEMPTS);
    expect(t.cards).toEqual(['a']);
    expect(t.discards).toHaveLength(1);
    await t.c.advance(10 * NOTE_RETRY_MS);
    expect(t.calls).toHaveLength(NOTE_MAX_ATTEMPTS);
  });

  it('a failing card does not stop the notes being removed', async () => {
    const t = setup([false, false, false], { recoverThrows: true });
    t.delivery.start([note('a')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS + 2 * NOTE_RETRY_MS);
    expect(t.discards).toHaveLength(1);
    expect(t.logs.join('\n')).toMatch(/recovery card failed for convo=a/);
  });

  it('removes the notes only after every conversation has settled', async () => {
    const t = setup([true, false, true]);
    t.delivery.start([note('a'), note('b')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.calls.map(c => c.convoId)).toEqual(['a', 'b']);
    expect(t.discards).toEqual([]);
    await t.c.advance(NOTE_RETRY_MS);
    expect(t.discards).toHaveLength(1);
  });

  it('measures the note age at the time of each attempt', async () => {
    const t = setup([false, true]);
    t.delivery.start([note('a', { ageMs: 5_000 })], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS + NOTE_RETRY_MS);
    expect(t.calls[0].ageMs).toBe(5_000 + NOTE_FIRST_DELAY_MS);
    expect(t.calls[1].ageMs).toBe(5_000 + NOTE_FIRST_DELAY_MS + NOTE_RETRY_MS);
  });

  it('with nothing to deliver it still removes what was taken (dropped notes)', () => {
    const t = setup([]);
    const taken = [{ convoId: 'gone', writtenAt: 1 }];
    t.delivery.start([], taken);
    expect(t.discards).toEqual([taken]);
  });

  it('a failed removal is logged, not thrown', async () => {
    const t = setup([true], { discardThrows: true });
    t.delivery.start([note('a')], []);
    await t.c.advance(NOTE_FIRST_DELAY_MS);
    expect(t.logs.join('\n')).toMatch(/could not remove the delivered notes: EACCES/);
  });
});

describe('resume note delivery against the real note store', () => {
  function tmpStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'note-delivery-'));
    const file = path.join(dir, 'notes.json');
    return { file, store: createRestartNotes({ file, now: () => NOW }) };
  }

  // One boot: peek the notes, choose deliveries, deliver with `results`.
  async function boot(store, results, { crashAfterDelivery = false } = {}) {
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } },
      stale: [], resumable: new Set(['c1']), now: () => NOW,
    });
    const delivered = [];
    const cards = [];
    const delivery = createNoteDelivery({
      deliver: async (n) => { delivered.push(n.convoId); return results.shift(); },
      recover: (n) => cards.push(n.convoId),
      discard: crashAfterDelivery ? () => { throw new Error('crashed before the notes were removed'); } : (entries) => store.discard(entries),
      schedule: c.schedule, now: c.now,
    });
    delivery.start(deliveries, taken);
    await c.advance(NOTE_FIRST_DELAY_MS + NOTE_MAX_ATTEMPTS * NOTE_RETRY_MS);
    return { delivered, cards };
  }

  it('a crash before delivery delivers the note exactly once at the next boot', async () => {
    const { store } = tmpStore();
    store.put('c1', 'carry on with the migration');
    // First boot dies before any timer fires: nothing was delivered or removed.
    takeNoteDeliveries({ store: { take: () => store.peek() }, stale: [], resumable: new Set(['c1']), now: () => NOW });
    const second = await boot(store, [true]);
    expect(second.delivered).toEqual(['c1']);
    const third = await boot(store, [true]);
    expect(third.delivered).toEqual([]);
  });

  it('a crash after a successful delivery but before the removal delivers it once more (at-least-once)', async () => {
    const { store } = tmpStore();
    store.put('c1', 'carry on with the migration');
    const first = await boot(store, [true], { crashAfterDelivery: true });
    expect(first.delivered).toEqual(['c1']);
    const second = await boot(store, [true]);
    expect(second.delivered).toEqual(['c1']);
    const third = await boot(store, [true]);
    expect(third.delivered).toEqual([]);
  });

  it('a note written for the next restart while retrying survives the removal', async () => {
    const { store } = tmpStore();
    store.put('c1', 'old');
    const c = clock();
    let taken = [];
    const { deliveries } = takeNoteDeliveries({
      store: { take: () => { taken = store.peek(); return taken; } }, stale: [], resumable: new Set(['c1', 'c2']), now: () => NOW,
    });
    const delivery = createNoteDelivery({ deliver: async () => true, discard: (e) => store.discard(e), schedule: c.schedule, now: c.now });
    delivery.start(deliveries, taken);
    store.put('c2', 'for the next restart');
    await c.advance(NOTE_FIRST_DELAY_MS);
    expect(store.peek().map(n => n.convoId)).toEqual(['c2']);
  });
});

describe('resume note delivery wiring', () => {
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  it('reads the notes with peek and removes them only through the delivery', () => {
    expect(index).toMatch(/store: \{ take: \(\) => \{ taken = restartNotes\.peek\(\)/);
    expect(index).toMatch(/discard: \(entries\) => restartNotes\.discard\(entries\)/);
    expect(index).not.toMatch(/restartNotes\.take\(/);
  });
  it('delivers through a function that reports failure, with the carry-on cause', () => {
    const fn = index.slice(index.indexOf('async function deliverRestartNote'), index.indexOf('function publishNoteRecoveryCard'));
    expect(fn).toMatch(/journalRouteTextToSession\(target,/);
    expect(fn).toMatch(/causes: \[carryOnCause\(\)\]/);
    expect(fn).toMatch(/return false;/);
  });
});
