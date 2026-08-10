import { describe, it, expect, vi } from 'vitest';
import { createAgentSpawnHandlers } from '../lib/agent-spawn.js';

// Fake publisher + recording rooms/notifyParent, modeled on agent-chat.test.js's
// fake-publisher style. `sent` records every sendRoomOp frame in order so
// arm-before-send sequencing is assertable.
function mk(overrides = {}) {
  const sent = [];
  const notices = [];
  const publisher = {
    identity: overrides.identity ?? (() => ({ device_id: 7 })),
    sendRoomOp: overrides.sendRoomOp ?? ((frame) => { sent.push(frame); return true; }),
  };
  const roomsCalls = [];
  const rooms = {
    record: (roomId, fields) => { roomsCalls.push({ roomId, fields }); },
    isActive: () => true,
    calls: roomsCalls,
  };
  const sessions = new Map([['sess-1', { roomId: 'sess-1' }]]);
  const notifyParent = vi.fn((args) => notices.push(args));
  const handlers = createAgentSpawnHandlers({
    sessions,
    publisher,
    rooms,
    journalConvoIdFor: overrides.journalConvoIdFor ?? (() => 'convo-1'),
    notifyParent,
    targetsTimeoutMs: overrides.targetsTimeoutMs ?? 20,
    pendingTimeoutMs: overrides.pendingTimeoutMs ?? 20,
    handledTtlMs: overrides.handledTtlMs,
    sweepIntervalMs: overrides.sweepIntervalMs,
    log: { warn: () => {} },
  });
  return { handlers, sent, notices, rooms, sessions, notifyParent };
}

describe('createAgentSpawnHandlers', () => {
  describe('boxes', () => {
    it('happy path — sends spawn_targets, resolves boxes on targets frame', async () => {
      const { handlers, sent } = mk();
      const p = handlers.boxes({ roomId: 'sess-1' });
      // Frame sent synchronously by sendRoomOp before we can inspect it here
      // because handlers.boxes armed the waiter first — assert the send.
      expect(sent).toHaveLength(1);
      expect(sent[0].op).toBe('spawn_targets');
      expect(typeof sent[0].request_id).toBe('string');
      const boxesPayload = [{ device_id: 2, name: 'eric', online: true, folders: [], activity: { live_sessions: 0, last_hour: [] } }];
      handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: sent[0].request_id, boxes: boxesPayload });
      const res = await p;
      expect(res).toEqual({ status: 200, body: { boxes: boxesPayload } });
    });

    it('identity unknown -> 409, fails closed, no frame sent', async () => {
      const { handlers, sent } = mk({ identity: () => null });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/journal identity/i);
      expect(sent).toHaveLength(0);
    });

    it('sendRoomOp returns false -> 502 journal_unreachable, waiter cleaned up', async () => {
      let capturedRid = null;
      const { handlers } = mk({ sendRoomOp: (frame) => { capturedRid = frame.request_id; return false; } });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/journal unreachable/i);
      // Waiter cleanup proven behaviourally: a frame arriving late for the
      // now-abandoned request_id must not be able to resolve anything (it
      // was already settled/removed when the send failed) — no throw either.
      expect(capturedRid).toBeTruthy();
      expect(() => handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: capturedRid, boxes: [] })).not.toThrow();
    });

    it('timeout -> 504, waiters map ends up empty', async () => {
      const { handlers, sent } = mk({ targetsTimeoutMs: 20 });
      const res = await handlers.boxes({ roomId: 'sess-1' });
      expect(res.status).toBe(504);
      expect(sent).toHaveLength(1);
      // Waiter cleanup proven indirectly: a late frame for the same
      // request_id now settles nothing (no throw, no crash) because the
      // timeout already deleted the waiter.
      expect(() => handlers.onSpawnFrame({ kind: 'spawn', event: 'targets', request_id: sent[0].request_id, boxes: [] })).not.toThrow();
    });

    it('unknown caller session -> 404', async () => {
      const { handlers } = mk();
      const res = await handlers.boxes({ roomId: 'nope' });
      expect(res.status).toBe(404);
    });
  });

  describe('sessionStart', () => {
    const good = { roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T' };

    it('happy path — sends spawn_request, resolves pending status on ack', async () => {
      const { handlers, sent } = mk();
      const p = handlers.sessionStart(good);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        op: 'spawn_request',
        request_id: sent[0].request_id,
        from_convo_id: 'convo-1',
        target_device_id: 2,
        workdir: '/w',
        task: 'do the thing',
        topic: 'T',
      });
      handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: sent[0].request_id, spawn_id: 'row-1' });
      const res = await p;
      expect(res).toEqual({ status: 200, body: { status: 'pending', spawn_id: 'row-1' } });
    });

    it('validates task / topic / device_id / workdir before sending any frame', async () => {
      const { handlers, sent } = mk();
      const cases = [
        { ...good, task: undefined },
        { ...good, task: 'x'.repeat(2001) },
        { ...good, topic: 'x'.repeat(201) },
        { ...good, device_id: '2' },
        { ...good, device_id: 2.5 },
        { ...good, workdir: undefined },
        { ...good, workdir: '' },
      ];
      for (const c of cases) {
        const res = await handlers.sessionStart(c);
        expect(res.status).toBe(400);
      }
      expect(sent).toHaveLength(0);
    });

    it('journal op error: conflict maps to 409 with detail; unknown ref returns false', async () => {
      const { handlers, sent } = mk();
      const p = handlers.sessionStart(good);
      expect(sent).toHaveLength(1);
      const rid = sent[0].request_id;
      expect(handlers.onOpError({ code: 'not-a-ref', ref: 'nonexistent-ref-xyz', detail: 'x' })).toBe(false);
      const consumed = handlers.onOpError({ code: 'conflict', ref: rid, detail: 'too many requests awaiting user approval' });
      expect(consumed).toBe(true);
      const res = await p;
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('too many requests awaiting user approval');
    });

    it('agent_unreachable -> 502 target box is offline; not_found -> 404', async () => {
      const { handlers: h1, sent: s1 } = mk();
      const p1 = h1.sessionStart(good);
      h1.onOpError({ code: 'agent_unreachable', ref: s1[0].request_id, detail: 'offline' });
      const r1 = await p1;
      expect(r1.status).toBe(502);
      expect(r1.body.error).toMatch(/offline/i);

      const { handlers: h2, sent: s2 } = mk();
      const p2 = h2.sessionStart(good);
      h2.onOpError({ code: 'not_found', ref: s2[0].request_id, detail: 'no such box' });
      const r2 = await p2;
      expect(r2.status).toBe(404);
    });

    it('session with no journal convo id -> 409', async () => {
      const { handlers, sent } = mk({ journalConvoIdFor: () => null });
      const res = await handlers.sessionStart(good);
      expect(res.status).toBe(409);
      expect(sent).toHaveLength(0);
    });

    it('timeout -> 504', async () => {
      const { handlers } = mk({ pendingTimeoutMs: 20 });
      const res = await handlers.sessionStart(good);
      expect(res.status).toBe(504);
    });
  });

  describe('outcomes', () => {
    async function armStarted(overrides = {}) {
      const ctx = mk(overrides);
      const p = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'do the thing', topic: 'T' });
      const rid = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: 'row-1' });
      await p;
      return ctx;
    }

    it('started — rooms.record called, notifyParent once, text mentions started + room id', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.rooms.calls).toHaveLength(1);
      expect(ctx.rooms.calls[0].roomId).toBe('room-9');
      expect(ctx.rooms.calls[0].fields).toMatchObject({ role: 'owner', state: 'joined', sessionRoomId: 'sess-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      const text = ctx.notices[0].text;
      expect(text).toMatch(/started/);
      expect(text).toMatch(/room-9/);
    });

    it('declined — notifyParent text contains declined; rooms.record NOT called', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'declined' });
      expect(ctx.rooms.calls).toHaveLength(0);
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      expect(ctx.notices[0].text).toMatch(/declined/);
    });

    it('outcome with no pending context — notifyParent still called, session null, no throw', async () => {
      const ctx = mk();
      expect(() => ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'unknown-row', outcome: 'expired' })).not.toThrow();
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      expect(ctx.notices[0].session).toBeNull();
      expect(ctx.notices[0].text).toMatch(/expired/);
    });

    it('duplicate outcome for the same spawn id — second call produces no second notifyParent', async () => {
      const ctx = await armStarted();
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-1', outcome: 'started', room_id: 'room-9', child_convo_id: 'child-1' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);
    });

    it('a task with an embedded newline and quotes is flattened and escaped in the notice, and carries no raw newline into the room title', async () => {
      const ctx = mk();
      const task = 'run "rm -rf /"\nand then reboot';
      const p = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task });
      const rid = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: 'row-2' });
      await p;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-2', outcome: 'started', room_id: 'room-2', child_convo_id: 'child-2' });

      const text = ctx.notices[0].text;
      // No raw newline anywhere in the published notice.
      expect(text).not.toMatch(/\n/);
      // The embedded quotes are escaped (quotedField), not left free to close
      // the wrapping "…" segment early — the forgery quotedField exists to
      // stop (lib/peer-text.js:22-39).
      expect(text).toContain('\\"rm -rf /\\"');
      // Exactly two UNESCAPED double quotes remain: the prefix's own
      // delimiters (same invariant formatInviteRequestNotice relies on).
      const unescapedQuotes = text.replace(/\\"/g, '').match(/"/g) || [];
      expect(unescapedQuotes).toHaveLength(2);

      // rooms.record's title (sourced from the same ctx.task, sanitized at
      // capture in sessionStart) must not carry the raw newline through to
      // a downstream room-title renderer either.
      const title = ctx.rooms.calls[0].fields.title;
      expect(title).not.toMatch(/\n/);
      expect(title).toContain('run "rm -rf /"');
    });
  });

  describe('frame hygiene', () => {
    it('malformed frames -> no throw, no effect', () => {
      const { handlers, notifyParent } = mk();
      const bad = [
        null,
        undefined,
        {},
        { kind: 'spawn' },
        { kind: 'spawn', event: 42 },
        { kind: 'invite', event: 'targets', request_id: 'x' },
        { kind: 'spawn', event: 'unknown-event', request_id: 'x' },
      ];
      for (const f of bad) {
        expect(() => handlers.onSpawnFrame(f)).not.toThrow();
      }
      expect(notifyParent).not.toHaveBeenCalled();
    });
  });

  describe('pendingSpawns tombstone sweep', () => {
    it('prunes a resolved (tombstoned) spawn after handledTtlMs, but a still-pending context survives the same sweep untouched', async () => {
      const ctx = mk({ handledTtlMs: 5, sweepIntervalMs: 5 });

      // Spawn "live": acked but never given an outcome — a genuinely
      // in-flight context that must survive any amount of sweeping (the
      // sweep only ever touches tombstoned/HANDLED entries).
      const pLive = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'long-running task' });
      const ridLive = ctx.sent[0].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: ridLive, spawn_id: 'row-live' });
      await pLive;

      // Spawn "tomb": acked and resolved right away — its context tombstones.
      const pTomb = ctx.handlers.sessionStart({ roomId: 'sess-1', device_id: 2, workdir: '/w', task: 'quick task' });
      const ridTomb = ctx.sent[1].request_id;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'pending', request_id: ridTomb, spawn_id: 'row-tomb' });
      await pTomb;
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-tomb', outcome: 'declined' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(1);

      // Let the unref'd sweep interval fire at least once past the TTL.
      await new Promise((resolve) => setTimeout(resolve, 60));

      // The tombstone for row-tomb is gone: a second 'declined' frame for
      // the same spawn id now reads as "never tracked" (same as a
      // bridge-restart case) and produces ANOTHER notifyParent — proving
      // the entry was actually pruned rather than deduped forever.
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-tomb', outcome: 'declined' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(2);
      expect(ctx.notices[1].session).toBeNull();

      // row-live was NEVER tombstoned, so the sweep must never have touched
      // it — resolving it now must still find its real context (session
      // non-null, rooms.record called), proving a genuinely pending spawn
      // is immune to the sweep regardless of elapsed time.
      ctx.handlers.onSpawnFrame({ kind: 'spawn', event: 'outcome', request_id: 'row-live', outcome: 'started', room_id: 'room-live', child_convo_id: 'child-live' });
      expect(ctx.notifyParent).toHaveBeenCalledTimes(3);
      expect(ctx.notices[2].session).not.toBeNull();
      expect(ctx.notices[2].text).toContain('long-running task');
      expect(ctx.rooms.calls.some((c) => c.roomId === 'room-live')).toBe(true);
    });
  });
});
