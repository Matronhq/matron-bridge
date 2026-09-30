import { describe, it, expect, vi } from 'vitest';
import { createMissionsHandlers } from '../lib/missions-tools.js';

function fixture(clientOverrides = {}, handlerOptions = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const mission = { id: 'ms_1', num: 61, title: 'M', origin_convo_id: 'c1', state: 'open' };
  const client = {
    start: vi.fn(async () => ({ status: 201, data: { mission } })),
    create: vi.fn(async () => ({ status: 201, data: { mission: { ...mission, id: 'ms_2', num: 62, origin_convo_id: 'c1' } } })),
    list: vi.fn(async () => ({ status: 200, data: { missions: [] } })),
    get: vi.fn(async () => ({ status: 200, data: { mission, milestones: [], items: [], conversations: [{ id: 'c1' }] } })),
    update: vi.fn(async () => ({ status: 200, data: { mission } })),
    join: vi.fn(async () => ({ status: 200, data: { mission } })),
    close: vi.fn(async () => ({ status: 200, data: { mission: { ...mission, state: 'closed' } } })),
    postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { id: 'ml_1', num: 63 }, mission } })),
    listMilestones: vi.fn(async () => ({ status: 200, data: { milestones: [] } })),
    // Default: a journal from before mission links (404), so every existing
    // cold-resolve test keeps exercising the old scan.
    conversationMissions: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })),
    leave: vi.fn(async () => ({ status: 200, data: { mission, current_mission: null } })),
    ...clientOverrides,
  };
  const h = createMissionsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, ...handlerOptions });
  return { h, client, session, mission };
}

describe('missions handlers', () => {
  it('start: validates title/body, fills convo_id, passes idem key, caches the mission on the session', async () => {
    const { h, client, session } = fixture();
    const emptyTitle = await h.start({ roomId: '!r:s', title: '' });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body.error).toBe('title must be a non-empty string of at most 200 characters');
    expect((await h.start({ roomId: '!r:s', title: 'x'.repeat(201) })).status).toBe(400);
    expect((await h.start({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.start({ roomId: '!r:s', title: ' M ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.start.mock.calls[0]).toEqual([{ title: 'M', body: 'goal', convo_id: 'c1' }, { idemKey: 'k' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it('session guards: 400 no roomId, 404 unknown session, 409 no convo yet', async () => {
    const { h, session } = fixture();
    expect((await h.get({})).status).toBe(400);
    expect((await h.get({ roomId: '!other:s' })).status).toBe(404);
    session.journalConvoId = null;
    expect((await h.get({ roomId: '!r:s' })).status).toBe(409);
  });

  it('post: validates kind and title; passes convo_id; 409 bodies pass through; status 0 → 502', async () => {
    const { h, client } = fixture();
    expect((await h.post({ roomId: '!r:s', kind: 'nope', title: 't' })).status).toBe(400);
    expect((await h.post({ roomId: '!r:s', kind: 'progress', title: '' })).status).toBe(400);
    const r = await h.post({ roomId: '!r:s', kind: 'user_input', title: 'Dan asked', body: 'b', idem_key: 'm' });
    expect(r.status).toBe(201);
    expect(client.postMilestone.mock.calls[0]).toEqual([{ convo_id: 'c1', kind: 'user_input', title: 'Dan asked', body: 'b' }, { idemKey: 'm' }]);
    const blocked = fixture({ postMilestone: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'no_mission' } })) });
    const b = await blocked.h.post({ roomId: '!r:s', kind: 'progress', title: 't' });
    expect(b.status).toBe(409); expect(b.body.blocked_by).toBe('no_mission');
    const down = fixture({ postMilestone: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.post({ roomId: '!r:s', kind: 'progress', title: 't' })).status).toBe(502);
  });

  it('get: explicit num goes straight through; no num resolves the conversation mission from GET /missions and caches it', async () => {
    const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [{ ...mission, id: 'ms_9', num: 9 }] } })) });
    await h.get({ roomId: '!r:s', num: 5 });
    expect(client.get.mock.calls[0][0]).toBe(5);
    client.get.mockResolvedValueOnce({ status: 200, data: { mission: { id: 'ms_9', num: 9 }, milestones: [], items: [], conversations: [{ id: 'c1' }] } });
    const r = await h.get({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(session.missionId).toBe('ms_9');
  });

  it('get / update / close with no resolvable mission answer 404 with a helpful error', async () => {
    const { h, client } = fixture();
    const r = await h.update({ roomId: '!r:s', title: 'x' });
    expect(r.status).toBe(404); expect(r.body.error).toMatch(/no mission/);
    expect(client.update).not.toHaveBeenCalled();
  });

  it('update: requires title or body; close: requires summary; join: requires num — each uses the resolved/explicit mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    expect((await h.update({ roomId: '!r:s' })).status).toBe(400);
    const emptyTitle = await h.update({ roomId: '!r:s', title: '' });
    expect(emptyTitle.status).toBe(400);
    expect(emptyTitle.body.error).toBe('title must be a non-empty string of at most 200 characters');
    expect((await h.update({ roomId: '!r:s', title: 'New' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { title: 'New' }]);
    expect((await h.close({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.close({ roomId: '!r:s', summary: 'done' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['ms_1', { summary: 'done', convo_id: 'c1' }]);
    expect((await h.join({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.join({ roomId: '!r:s', num: 61 })).status).toBe(200);
    expect(client.join.mock.calls[0]).toEqual([61, { convo_id: 'c1' }]);
  });

  it('close 409 carries blocked_by and the items list unchanged', async () => {
    const { h, session } = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] } })) });
    session.missionId = 'ms_1';
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409); expect(r.body.items).toEqual([{ num: 64, title: 'Q?' }]);
  });

  it('get: explicit num 404 passes through the journal error, not the NO_ROUTES sentence', async () => {
    const { h } = fixture({ get: vi.fn(async () => ({ status: 404, data: { error: 'no such mission' } })) });
    const r = await h.get({ roomId: '!r:s', num: 999 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'no such mission' });
  });

  it('update: a 404 for the cached mission id clears the cache so the next call re-resolves cold', async () => {
    const otherMission = { id: 'ms_9', num: 9, title: 'M', origin_convo_id: 'c1', state: 'open' };
    const { h, client, session } = fixture({
      update: vi.fn()
        .mockResolvedValueOnce({ status: 404, data: { error: 'no such mission' } })
        .mockResolvedValueOnce({ status: 200, data: { mission: otherMission } }),
      list: vi.fn(async () => ({ status: 200, data: { missions: [otherMission] } })),
    });
    session.missionId = 'ms_1';
    const r1 = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r1.status).toBe(404);
    expect(session.missionId).toBeUndefined();
    expect(client.list).not.toHaveBeenCalled();
    const r2 = await h.update({ roomId: '!r:s', title: 'New2' });
    expect(r2.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.update.mock.calls[1][0]).toBe('ms_9');
    expect(session.missionId).toBe('ms_9');
  });

  it('close: a 409 (closed / other_mission) for the cached id does not clear the cache — the mission still exists', async () => {
    const { h, session } = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })) });
    session.missionId = 'ms_1';
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409);
    expect(session.missionId).toBe('ms_1');
  });

  it('status 0 (journal unreachable) becomes 502 for start, update, join, get and close', async () => {
    const down = { status: 0, data: { error: 'journal unreachable' } };

    const { h: h1 } = fixture({ start: vi.fn(async () => down) });
    expect((await h1.start({ roomId: '!r:s', title: 't' })).status).toBe(502);

    const { h: h2, session: s2 } = fixture({ update: vi.fn(async () => down) });
    s2.missionId = 'ms_1';
    expect((await h2.update({ roomId: '!r:s', title: 't' })).status).toBe(502);

    const { h: h3 } = fixture({ join: vi.fn(async () => down) });
    expect((await h3.join({ roomId: '!r:s', num: 61 })).status).toBe(502);

    const { h: h4, session: s4 } = fixture({ get: vi.fn(async () => down) });
    s4.missionId = 'ms_1';
    expect((await h4.get({ roomId: '!r:s' })).status).toBe(502);
    const { h: h4b } = fixture({ get: vi.fn(async () => down) });
    expect((await h4b.get({ roomId: '!r:s', num: 5 })).status).toBe(502);

    const { h: h5, session: s5 } = fixture({ close: vi.fn(async () => down) });
    s5.missionId = 'ms_1';
    expect((await h5.close({ roomId: '!r:s', summary: 's' })).status).toBe(502);
  });

  it('cold resolve lists missions in EVERY state and finds a CLOSED one by origin', async () => {
    // After a bridge restart, a conversation whose mission is closed must
    // still resolve to it — otherwise the model is told "call mission_start",
    // POST /missions answers 200 existing:true with that same closed mission,
    // and the loop never ends. Resolving it lets the journal say 409 closed.
    const closed = { id: 'ms_c', num: 6, title: 'Done', origin_convo_id: 'c1', state: 'closed' };
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions: [closed] } })),
      update: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })),
    });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.list.mock.calls[0][0]?.state).toBeUndefined();
    expect(session.missionId).toBe('ms_c');
    expect(r.status).toBe(409);
    expect(r.body.blocked_by).toBe('closed');
  });

  it('cold resolve finds a CLOSED mission this conversation merely JOINED, and caches it', async () => {
    const closed = { id: 'ms_c', num: 6, title: 'Done', origin_convo_id: 'cOther', state: 'closed' };
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions: [closed] } })),
      get: vi.fn(async () => ({ status: 200, data: { mission: closed, milestones: [], items: [], conversations: [{ id: 'cOther' }, { id: 'c1' }] } })),
      close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })),
    });
    const r = await h.close({ roomId: '!r:s', summary: 's' });
    expect(r.status).toBe(409);
    expect(client.get.mock.calls[0][0]).toBe('ms_c');
    expect(session.missionId).toBe('ms_c');
    // Cached: a second call re-uses it without scanning again.
    await h.close({ roomId: '!r:s', summary: 's' });
    expect(client.list).toHaveBeenCalledTimes(1);
  });

  it('cold resolve picks the ONE matching mission out of several and stops scanning there', async () => {
    const missions = [
      { id: 'ms_a', num: 1, origin_convo_id: 'cA', state: 'open' },
      { id: 'ms_b', num: 2, origin_convo_id: 'cB', state: 'closed' },
      { id: 'ms_c', num: 3, origin_convo_id: 'cC', state: 'open' },
    ];
    const detail = (id, convos) => ({ status: 200, data: { mission: { id }, milestones: [], items: [], conversations: convos } });
    const { h, client, session } = fixture({
      list: vi.fn(async () => ({ status: 200, data: { missions } })),
      get: vi.fn(async (id) => detail(id, id === 'ms_b' ? [{ id: 'cB' }, { id: 'c1' }] : [{ id: `c${id.slice(-1).toUpperCase()}` }])),
    });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r.status).toBe(200);
    expect(session.missionId).toBe('ms_b');
    expect(client.update.mock.calls[0][0]).toBe('ms_b');
    // ms_a then ms_b — the scan stops on the match, never reaching ms_c.
    expect(client.get.mock.calls.map((c) => c[0])).toEqual(['ms_a', 'ms_b']);
  });

  it('cold resolve against an unreachable or failing journal reports the outage, never "no mission"', async () => {
    for (const listResult of [{ status: 0, data: { error: 'journal unreachable' } }, { status: 500, data: { error: 'boom' } }]) {
      const { h, client, session } = fixture({ list: vi.fn(async () => listResult) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(listResult.status === 0 ? 502 : 500);
      expect(r.body.error).not.toContain('mission_start');
      expect(session.missionId).toBeUndefined();
      expect(client.update).not.toHaveBeenCalled();
    }
  });

  it('cold resolve treats a 200 with an unreadable list as a 502, never as a mission', async () => {
    for (const body of [{}, { missions: null }, { missions: 'nope' }]) {
      const { h, client, session } = fixture({ list: vi.fn(async () => ({ status: 200, data: body })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe('the journal returned an unreadable mission list');
      expect(session.missionId).toBeUndefined();
      expect(client.update).not.toHaveBeenCalled();
    }
  });

  it('start / post 404 says the conversation was refused, NOT that the routes are missing', async () => {
    const notFound = { status: 404, data: { error: 'not_found' } };
    const convoText = 'the journal did not accept this conversation — it may have no journal row yet, or its mission is not visible to this session';

    const { h: h1 } = fixture({ start: vi.fn(async () => notFound) });
    const r1 = await h1.start({ roomId: '!r:s', title: 'M' });
    expect(r1.status).toBe(404);
    expect(r1.body.error).toBe(convoText);

    const { h: h2 } = fixture({ postMilestone: vi.fn(async () => notFound) });
    const r2 = await h2.post({ roomId: '!r:s', kind: 'progress', title: 't' });
    expect(r2.status).toBe(404);
    expect(r2.body.error).toBe(convoText);
  });

  it('the NO_ROUTES sentence is reserved for a 404 from GET /missions, the collection route', async () => {
    const { h } = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    const r = await h.update({ roomId: '!r:s', title: 'New' });
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/does not have the \/missions routes yet/);
  });

  it('create: attach:false, convo_id for provenance, idem key; does NOT join (no missionId cached)', async () => {
    // The new mission's detail does not list this conversation: unassigned.
    const { h, client, session } = fixture({ get: vi.fn(async (id) => ({ status: 200, data: { mission: { id }, milestones: [], items: [], conversations: [] } })) });
    expect((await h.create({ roomId: '!r:s', title: '' })).status).toBe(400);
    expect((await h.create({ roomId: '!r:s', title: 'ok', body: 'y'.repeat(32769) })).status).toBe(400);
    const r = await h.create({ roomId: '!r:s', title: ' Fix login ', body: 'goal', idem_key: 'k' });
    expect(r.status).toBe(201);
    expect(client.create.mock.calls[0]).toEqual([{ title: 'Fix login', body: 'goal', convo_id: 'c1', attach: false }, { idemKey: 'k' }]);
    expect(client.start).not.toHaveBeenCalled();
    expect(session.missionId).toBeUndefined();
  });

  it('create: a journal that ignored attach:false (existing:true) is an error, never "created"', async () => {
    const { h, session } = fixture({ create: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 }, existing: true } })) });
    const r = await h.create({ roomId: '!r:s', title: 'X' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/does not support unassigned missions/);
    expect(session.missionId).toBeUndefined();
  });

  // The attach:false guard (Bugbot follow-up on PR #300): after a create or
  // an idempotent replay, the mission's own detail says whether THIS
  // conversation is on it — exact, where a conversation count could not
  // tell a replayed mission since assigned to someone else from an attach.
  const detailWith = (convos) => vi.fn(async (id) => ({ status: 200, data: { mission: { id }, milestones: [], items: [], conversations: convos } }));

  it('create: 201 and the creating convo is on the new mission (old journal attached it) → error naming the mission', async () => {
    const get = detailWith([{ id: 'c1' }]);
    const { h, session } = fixture({ create: vi.fn(async () => ({ status: 201, data: { mission: { id: 'ms_2', num: 62 } } })), get });
    const r = await h.create({ roomId: '!r:s', title: 'X' });
    expect(get).toHaveBeenCalledWith('ms_2');
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/does not support unassigned missions/);
    expect(r.body.error).toMatch(/#62/);
    expect(session.missionId).toBeUndefined();
  });

  it('create: a 200 idempotent replay where the creating convo is on the mission → the same error', async () => {
    const get = detailWith([{ id: 'c1' }]);
    const { h } = fixture({ create: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_2', num: 62 } } })), get });
    const r = await h.create({ roomId: '!r:s', title: 'X', idem_key: 'k' });
    expect(r.status).toBe(502);
    expect(r.body.error).toMatch(/does not support unassigned missions/);
  });

  it('create: a 200 replay of a mission since assigned to someone else (convo not on it) → success', async () => {
    const get = detailWith([{ id: 'c-worker' }]);
    const { h } = fixture({ create: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_2', num: 62, conversations: 1 } } })), get });
    const r = await h.create({ roomId: '!r:s', title: 'X', idem_key: 'k' });
    expect(r.status).toBe(200);
    expect(r.body.mission.num).toBe(62);
  });

  it('create: the membership lookup failing (unreachable, 404, unreadable) → success, logged', async () => {
    for (const get of [
      vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })),
      vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })),
      vi.fn(async () => ({ status: 200, data: {} })),
    ]) {
      const warns = [];
      const { h } = fixture({ create: vi.fn(async () => ({ status: 201, data: { mission: { id: 'ms_2', num: 62 } } })), get }, { log: { warn: (m) => warns.push(m) } });
      const r = await h.create({ roomId: '!r:s', title: 'X' });
      expect(r.status).toBe(201);
      expect(warns.some((w) => /could not confirm mission #62/.test(w))).toBe(true);
    }
  });

  it('create: unreachable → 502; 404 on the convo → the convo sentence', async () => {
    const down = fixture({ create: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.create({ roomId: '!r:s', title: 'X' })).status).toBe(502);
    const noConvo = fixture({ create: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await noConvo.h.create({ roomId: '!r:s', title: 'X' })).body.error).toMatch(/did not accept this conversation/);
  });

  it('status: own mission — trims, carries convo_id, PATCHes the cached mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: '  PR #12 open, waiting on review.  ' });
    expect(r.status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { status: 'PR #12 open, waiting on review.', convo_id: 'c1' }]);
  });

  it('status: cold resolve finds the conversation mission, PATCHes it and caches it', async () => {
    const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [mission] } })) });
    const r = await h.status({ roomId: '!r:s', status: 'Diagnosed; fixing next.' });
    expect(r.status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([]);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { status: 'Diagnosed; fixing next.', convo_id: 'c1' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it('status: explicit mission goes by number, never resolves or touches the cache, still carries convo_id', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: 'Blocked on #64', mission: 7 });
    expect(r.status).toBe(200);
    expect(client.list).not.toHaveBeenCalled();
    expect(client.update.mock.calls[0]).toEqual([7, { status: 'Blocked on #64', convo_id: 'c1' }]);
    expect(session.missionId).toBe('ms_1');
  });

  it("status: explicit mission 404 passes through and leaves this conversation's cache alone", async () => {
    const { h, session } = fixture({ update: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    session.missionId = 'ms_1';
    const r = await h.status({ roomId: '!r:s', status: 'x', mission: 99 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not_found' });
    expect(session.missionId).toBe('ms_1');
  });

  it('status: no mission and no mission argument → 404 naming mission_start AND the mission argument', async () => {
    const { h, client } = fixture();
    const r = await h.status({ roomId: '!r:s', status: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.error).toBe("this conversation has no mission yet — call mission_start(title, body) first, or pass mission: N to set another mission's status");
    expect(client.update).not.toHaveBeenCalled();
  });

  it('status: validates status (non-empty after trim, ≤600 UTF-16 units, as the journal counts) and mission', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    for (const bad of [undefined, '', '   \n ', 42, 'x'.repeat(601)]) {
      const r = await h.status({ roomId: '!r:s', status: bad });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('status must be a non-empty string of at most 600 characters');
    }
    // 600 after trimming passes even with surrounding whitespace.
    expect((await h.status({ roomId: '!r:s', status: ` ${'x'.repeat(600)} ` })).status).toBe(200);
    // Each emoji is 2 UTF-16 units: 300 = 600 passes, 301 = 602 is refused.
    expect((await h.status({ roomId: '!r:s', status: '😀'.repeat(300) })).status).toBe(200);
    expect((await h.status({ roomId: '!r:s', status: '😀'.repeat(301) })).status).toBe(400);
    for (const m of [0, -1, 1.5, '7', null]) {
      const r = await h.status({ roomId: '!r:s', status: 'ok', mission: m });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe('mission must be a positive integer');
    }
    expect(client.update).toHaveBeenCalledTimes(2);
  });

  it('status: folds CRLF to LF before counting and trimming, and sends the folded text', async () => {
    const { h, client, session } = fixture();
    session.missionId = 'ms_1';
    // 50 "x\r\n" pairs (150 raw chars) plus 499 "y"s: 649 raw chars — over
    // 600 unfolded, and would be refused if CRLF counted as two chars each.
    // Folded to "x\n" pairs it is 599 chars, under the limit — the journal
    // folds CRLF the same way before it counts, so this must be accepted.
    const raw = 'x\r\n'.repeat(50) + 'y'.repeat(499);
    const folded = 'x\n'.repeat(50) + 'y'.repeat(499);
    expect(folded.length).toBe(599);
    const r = await h.status({ roomId: '!r:s', status: raw });
    expect(r.status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { status: folded, convo_id: 'c1' }]);
  });

  it('status: 409 closed passes through with blocked_by; unreachable → 502; session guards apply', async () => {
    const closed = fixture({ update: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'closed' } })) });
    closed.session.missionId = 'ms_1';
    const r = await closed.h.status({ roomId: '!r:s', status: 'x' });
    expect(r.status).toBe(409);
    expect(r.body.blocked_by).toBe('closed');
    expect(closed.session.missionId).toBe('ms_1');
    const down = fixture({ update: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.status({ roomId: '!r:s', status: 'x', mission: 3 })).status).toBe(502);
    expect((await down.h.status({ status: 'x' })).status).toBe(400);
    expect((await down.h.status({ roomId: '!other:s', status: 'x' })).status).toBe(404);
  });

  it('list: open by default, closed on request, bad state 400, a 404 is the missing-routes sentence', async () => {
    const { h, client } = fixture();
    expect((await h.list({ roomId: '!r:s' })).status).toBe(200);
    expect(client.list.mock.calls[0]).toEqual([{ state: 'open' }]);
    expect((await h.list({ roomId: '!r:s', state: 'closed' })).status).toBe(200);
    expect(client.list.mock.calls[1]).toEqual([{ state: 'closed' }]);
    const bad = await h.list({ roomId: '!r:s', state: 'all' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("state must be 'open' or 'closed'");
    expect((await h.list({})).status).toBe(400);
    const old = fixture({ list: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
    expect((await old.h.list({ roomId: '!r:s' })).body.error).toMatch(/does not have the \/missions routes/);
    const down = fixture({ list: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
    expect((await down.h.list({ roomId: '!r:s' })).status).toBe(502);
  });

  describe('cold resolve through GET /conversations/:id/missions (spec 2026-09-30 §5)', () => {
    const link = (id, num, extra = {}) => ({ id, num, title: `M${num}`, state: 'open', current: false, active: true, joined_at: 1, ended_at: null, how: 'joined', ...extra });

    it('one call, caches the CURRENT link, never scans', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_7', 7, { current: true }), link('ms_3', 3)] } })),
      });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(200);
      expect(client.conversationMissions.mock.calls[0]).toEqual(['c1']);
      expect(client.update.mock.calls[0][0]).toBe('ms_7');
      expect(session.missionId).toBe('ms_7');
      expect(client.list).not.toHaveBeenCalled();
      expect(client.get).not.toHaveBeenCalled();
    });

    it('picks the current link wherever it sits; an active-not-current or ended link is never the default', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_3', 3), link('ms_2', 2, { active: false, ended_at: 5 }), link('ms_9', 9, { current: true })] } })),
      });
      await h.update({ roomId: '!r:s', title: 'New' });
      expect(client.update.mock.calls[0][0]).toBe('ms_9');
      expect(session.missionId).toBe('ms_9');
    });

    it('links but none current → the no-mission 404, no scan, nothing cached', async () => {
      const { h, client, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_3', 3, { active: false, ended_at: 5 })] } })),
      });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(404);
      expect(r.body.error).toMatch(/call mission_start/);
      expect(session.missionId).toBeUndefined();
      expect(client.list).not.toHaveBeenCalled();
      expect(client.update).not.toHaveBeenCalled();
    });

    it('an outage on the links route is reported — never a scan, never "no mission"', async () => {
      for (const res of [{ status: 0, data: { error: 'journal unreachable' } }, { status: 500, data: { error: 'boom' } }]) {
        const { h, client, session } = fixture({ conversationMissions: vi.fn(async () => res) });
        const r = await h.update({ roomId: '!r:s', title: 'New' });
        expect(r.status).toBe(res.status === 0 ? 502 : 500);
        expect(r.body.error).not.toContain('mission_start');
        expect(client.list).not.toHaveBeenCalled();
        expect(session.missionId).toBeUndefined();
      }
    });

    it('a 200 with an unreadable link list is a 502', async () => {
      const { h, client } = fixture({ conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: 'nope' } })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("the journal returned an unreadable list of this conversation's missions");
      expect(client.update).not.toHaveBeenCalled();
    });

    it('a 404 on the links route (old journal) falls back to the GET /missions scan', async () => {
      const { h, client, session, mission } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [mission] } })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(200);
      expect(client.conversationMissions).toHaveBeenCalledTimes(1);
      expect(client.list).toHaveBeenCalledTimes(1);
      expect(session.missionId).toBe('ms_1');
    });

    it('a 404 on the links route from a NEW journal (rows carry project_id) is "no mission" without the per-mission sweep', async () => {
      const { h, client } = fixture({ list: vi.fn(async () => ({ status: 200, data: { missions: [{ id: 'ms_5', num: 5, origin_convo_id: 'other', project_id: null }] } })) });
      const r = await h.update({ roomId: '!r:s', title: 'New' });
      expect(r.status).toBe(404);
      expect(client.get).not.toHaveBeenCalled();
    });

    it('resolveMission is exposed for the projects handlers and shares the cache', async () => {
      const { h, session } = fixture({
        conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: [link('ms_7', 7, { current: true })] } })),
      });
      expect(await h.resolveMission(session, 'c1')).toEqual({ id: 'ms_7' });
      expect(session.missionId).toBe('ms_7');
    });

    it("get with no num attaches this conversation's missions; with num it does not", async () => {
      const links = [link('ms_1', 61, { current: true }), link('ms_3', 3)];
      const { h, client, session } = fixture({ conversationMissions: vi.fn(async () => ({ status: 200, data: { missions: links } })) });
      session.missionId = 'ms_1';
      const own = await h.get({ roomId: '!r:s' });
      expect(own.status).toBe(200);
      expect(own.body.conversation_missions).toEqual(links);
      const other = await h.get({ roomId: '!r:s', num: 5 });
      expect(other.body.conversation_missions).toBeUndefined();
      expect(client.conversationMissions).toHaveBeenCalledTimes(1);
      expect(client.get.mock.calls.every((c) => c[1]?.history === true)).toBe(true);
    });

    it('get with no num still answers when the links route is missing (old journal)', async () => {
      const { h, session } = fixture();
      session.missionId = 'ms_1';
      const r = await h.get({ roomId: '!r:s' });
      expect(r.status).toBe(200);
      expect(r.body.conversation_missions).toBeUndefined();
    });
  });

  describe('several missions per conversation (spec 2026-09-30 §3)', () => {
    it('join makes the joined mission current in the cache, replacing the old one', async () => {
      const joined = { id: 'ms_9', num: 9, title: 'Next', state: 'open' };
      const { h, client, session } = fixture({ join: vi.fn(async () => ({ status: 200, data: { mission: joined } })) });
      session.missionId = 'ms_1';
      const r = await h.join({ roomId: '!r:s', num: 9 });
      expect(r.status).toBe(200);
      expect(client.join.mock.calls[0]).toEqual([9, { convo_id: 'c1' }]);
      expect(session.missionId).toBe('ms_9');
    });

    it('leave: validates num, posts convo_id, drops the cache and reports the new current mission', async () => {
      const next = { id: 'ms_3', num: 3, title: 'Other', current: true, active: true };
      const { h, client, session } = fixture({
        leave: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 }, current_mission: next } })),
      });
      session.missionId = 'ms_1';
      expect((await h.leave({ roomId: '!r:s' })).status).toBe(400);
      expect((await h.leave({ roomId: '!r:s', num: 0 })).status).toBe(400);
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.status).toBe(200);
      expect(client.leave.mock.calls[0]).toEqual([61, { convo_id: 'c1' }]);
      expect(r.body.left).toBe(61);
      expect(r.body.current).toEqual(next);
      expect(session.missionId).toBe('ms_3');
    });

    it('leave: no current mission left → current null and nothing cached', async () => {
      const { h, session } = fixture();
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.status).toBe(200);
      expect(r.body.current).toBeNull();
      expect(session.missionId).toBeUndefined();
    });

    it('leave: a leave body without current_mission reports current unknown', async () => {
      const { h, session } = fixture({ leave: vi.fn(async () => ({ status: 200, data: { mission: { id: 'ms_1', num: 61 } } })) });
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 61 });
      expect(r.status).toBe(200);
      expect(r.body.current).toBeUndefined();
      expect(session.missionId).toBeUndefined();
    });

    it('leave: 404 is "not on that mission" (or an old journal) in a sentence; the cache is kept; 502 when unreachable', async () => {
      const { h, session } = fixture({ leave: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      session.missionId = 'ms_1';
      const r = await h.leave({ roomId: '!r:s', num: 5 });
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('this conversation is not on mission #5 — nothing to leave (a journal older than mission history cannot leave either: deploy the journal update)');
      expect(session.missionId).toBe('ms_1');
      const down = fixture({ leave: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      expect((await down.h.leave({ roomId: '!r:s', num: 5 })).status).toBe(502);
    });

    it('post with mission: validates it, sends it, and never caches the named mission', async () => {
      const named = { id: 'ms_3', num: 3, title: 'Other', state: 'open' };
      const { h, client, session } = fixture({ postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { num: 80 }, mission: named } })) });
      session.missionId = 'ms_1';
      expect((await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 0 })).status).toBe(400);
      expect((await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: '3' })).status).toBe(400);
      const r = await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3, idem_key: 'k' });
      expect(r.status).toBe(201);
      expect(client.postMilestone.mock.calls[0]).toEqual([{ convo_id: 'c1', kind: 'progress', title: 't', mission: 3 }, { idemKey: 'k' }]);
      expect(session.missionId).toBe('ms_1');
    });

    it('post: a journal that ignores mission (posted to another number) is an error naming both', async () => {
      const { h } = fixture({ postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { num: 80 }, mission: { id: 'ms_1', num: 61 } } })) });
      const r = await h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(r.status).toBe(502);
      expect(r.body.error).toBe("this journal does not support posting to a named mission yet — the milestone went to this conversation's current mission #61 instead of #3; deploy the journal update (mission links)");
    });

    it('post with mission: 404 is the conversation sentence; 409 not_linked passes through', async () => {
      const gone = fixture({ postMilestone: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      const g = await gone.h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(g.status).toBe(404);
      expect(g.body.error).toBe('the journal did not accept this conversation — it may have no journal row yet, or its mission is not visible to this session');
      const unlinked = fixture({ postMilestone: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'not_linked' } })) });
      const u = await unlinked.h.post({ roomId: '!r:s', kind: 'progress', title: 't', mission: 3 });
      expect(u.status).toBe(409);
      expect(u.body.blocked_by).toBe('not_linked');
    });
  });

  // Coordinator mission close (#4901, spec 2026-09-29 coordinator session
  // control "Coordinator mission close"): `mission: N` closes ANOTHER
  // mission by number, Coordinator only, never cached, both item tiers
  // still block. The journal gates it too (403 not_coordinator on
  // convo_id); the bridge refuses first with the clearer sentence.
  describe('close with mission: N (the Coordinator)', () => {
    it('refuses a non-Coordinator session before any journal call', async () => {
      const { h, client } = fixture();
      const r = await h.close({ roomId: '!r:s', summary: 's', mission: 61 });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("only the Coordinator may close another session's mission — this conversation is not the Coordinator");
      expect(client.close).not.toHaveBeenCalled();
      expect(client.list).not.toHaveBeenCalled();
    });

    it('validates mission and summary, then posts by number with convo_id and does not touch the cached own-mission id', async () => {
      const { h, client, session } = fixture();
      session.coordinator = true;
      expect((await h.close({ roomId: '!r:s', summary: 's', mission: 0 })).status).toBe(400);
      expect((await h.close({ roomId: '!r:s', summary: 's', mission: '61' })).status).toBe(400);
      expect((await h.close({ roomId: '!r:s', summary: '', mission: 61 })).status).toBe(400);
      const r = await h.close({ roomId: '!r:s', summary: 'done by the Coordinator', mission: 61 });
      expect(r.status).toBe(200);
      expect(client.close.mock.calls[0]).toEqual([61, { summary: 'done by the Coordinator', convo_id: 'c1' }]);
      expect(session.missionId).toBeUndefined();
      expect(client.list).not.toHaveBeenCalled();
    });

    it('passes the journal 409s through (user_items with the list, agent_items, closed) and maps not_found', async () => {
      const blocked = fixture({ close: vi.fn(async () => ({ status: 409, data: { error: 'conflict', blocked_by: 'user_items', items: [{ num: 64, title: 'Q?' }] } })) });
      blocked.session.coordinator = true;
      const r = await blocked.h.close({ roomId: '!r:s', summary: 's', mission: 61 });
      expect(r.status).toBe(409); expect(r.body.blocked_by).toBe('user_items'); expect(r.body.items).toEqual([{ num: 64, title: 'Q?' }]);
      const gone = fixture({ close: vi.fn(async () => ({ status: 404, data: { error: 'not_found' } })) });
      gone.session.coordinator = true;
      const g = await gone.h.close({ roomId: '!r:s', summary: 's', mission: 61 });
      expect(g.status).toBe(404); expect(g.body.error).toBe('not_found');
    });

    it('a journal that does not list this conversation as the Coordinator answers 403 in a sentence; an unreachable journal is 502', async () => {
      const refused = fixture({ close: vi.fn(async () => ({ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } })) });
      refused.session.coordinator = true;
      const r = await refused.h.close({ roomId: '!r:s', summary: 's', mission: 61 });
      expect(r.status).toBe(403);
      expect(r.body.error).toBe('the journal does not list this conversation as the Coordinator');
      const down = fixture({ close: vi.fn(async () => ({ status: 0, data: { error: 'journal unreachable' } })) });
      down.session.coordinator = true;
      expect((await down.h.close({ roomId: '!r:s', summary: 's', mission: 61 })).status).toBe(502);
    });
  });
});
