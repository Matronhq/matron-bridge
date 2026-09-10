import { describe, it, expect, vi } from 'vitest';
import { createMissionsHandlers } from '../lib/missions-tools.js';

function fixture(clientOverrides = {}) {
  const session = { roomId: '!r:s', workdir: '/w', journalConvoId: 'c1' };
  const sessions = new Map([['!r:s', session]]);
  const mission = { id: 'ms_1', num: 61, title: 'M', origin_convo_id: 'c1', state: 'open' };
  const client = {
    start: vi.fn(async () => ({ status: 201, data: { mission } })),
    list: vi.fn(async () => ({ status: 200, data: { missions: [] } })),
    get: vi.fn(async () => ({ status: 200, data: { mission, milestones: [], items: [], conversations: [{ id: 'c1' }] } })),
    update: vi.fn(async () => ({ status: 200, data: { mission } })),
    join: vi.fn(async () => ({ status: 200, data: { mission } })),
    close: vi.fn(async () => ({ status: 200, data: { mission: { ...mission, state: 'closed' } } })),
    postMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { id: 'ml_1', num: 63 }, mission } })),
    listMilestones: vi.fn(async () => ({ status: 200, data: { milestones: [] } })),
    ...clientOverrides,
  };
  const h = createMissionsHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client });
  return { h, client, session, mission };
}

describe('missions handlers', () => {
  it('start: validates title/body, fills convo_id, passes idem key, caches the mission on the session', async () => {
    const { h, client, session } = fixture();
    expect((await h.start({ roomId: '!r:s', title: '' })).status).toBe(400);
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
    expect(client.list).toHaveBeenCalledWith({ state: 'open' });
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
    expect((await h.update({ roomId: '!r:s', title: 'New' })).status).toBe(200);
    expect(client.update.mock.calls[0]).toEqual(['ms_1', { title: 'New' }]);
    expect((await h.close({ roomId: '!r:s' })).status).toBe(400);
    expect((await h.close({ roomId: '!r:s', summary: 'done' })).status).toBe(200);
    expect(client.close.mock.calls[0]).toEqual(['ms_1', { summary: 'done' }]);
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
});
