import { describe, it, expect, vi } from 'vitest';
import { createSharingHandlers } from '../lib/sharing-tools.js';
import { createSharingClient } from '../lib/sharing-client.js';
import { formatShareAck, formatGrantList, formatSharedMissionDetail, formatSharingError, formatContribAck } from '../lib/sharing-format.js';

// Sharing phase 3: the contribute and owner (hand-over) levels of
// mission_share, and a contributor's writes on another person's mission.
const ok = (data) => ({ status: 200, data });
const R = '!r:s';

function fixture(over = {}) {
  const session = { roomId: R, journalConvoId: 'c-1' };
  const sessions = new Map([[R, session]]);
  const theirs = { id: 'ms_9', num: 4, title: 'Fair', owner: { user_id: 2, name: 'alice' }, grant: { id: 'gr_9', level: 'contribute' } };
  const client = {
    share: vi.fn(async (m, body) => ({ status: 202, data: { grant: { id: 'gr_1', level: body.level, grantee: { address: 'bob' }, mission: { num: 3, title: 'Launch' } }, pending: 'owner' } })),
    shareProject: vi.fn(async () => ({ status: 202, data: { grant: { id: 'gr_2', level: 'owner', subject_kind: 'project', grantee: { address: 'bob' }, project: { num: 2, title: 'Spring' } }, pending: 'owner' } })),
    lookup: vi.fn(async (user, num) => (num === 12 ? ok({ kind: 'item', id: 'it_12' }) : ok({ kind: 'mission', id: 'ms_9', owner: { name: user } }))),
    mission: vi.fn(async () => ok({ mission: theirs })),
    contribMilestone: vi.fn(async () => ({ status: 201, data: { milestone: { num: 5 }, mission: theirs } })),
    contribItem: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_new', num: 13, owner: { name: 'alice' } } } })),
    contribStatus: vi.fn(async () => ok({ mission: theirs })),
    itemComment: vi.fn(async () => ({ status: 201, data: { comment: { id: 'cm_1' } } })),
    itemClose: vi.fn(async () => ok({ item: { id: 'it_12' } })),
    itemReopen: vi.fn(async () => ok({ item: { id: 'it_12' } })),
    ...over.client,
  };
  const resolveMission = vi.fn(async () => ({ id: 'ms_1' }));
  const h = createSharingHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client, resolveMission });
  return { h, client, theirs };
}

describe('mission_share levels', () => {
  it('passes read and contribute through, and refuses an unknown level', async () => {
    const { h, client } = fixture();
    await h.share({ roomId: R, contact: 'bob', level: 'contribute' });
    expect(client.share).toHaveBeenLastCalledWith('ms_1', { contact: 'bob', level: 'contribute', convo_id: 'c-1' });
    expect((await h.share({ roomId: R, contact: 'bob', level: 'admin' })).status).toBe(400);
  });

  it('a hand-over needs a brief; a brief goes with a hand-over only', async () => {
    const { h, client } = fixture();
    const none = await h.share({ roomId: R, contact: 'bob', level: 'owner' });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/needs a brief/);
    expect(none.body.error).toMatch(/No secrets, file paths, box names/);
    expect((await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: '   ' })).status).toBe(400);
    expect((await h.share({ roomId: R, contact: 'bob', level: 'read', brief: 'x' })).status).toBe(400);
    expect((await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: 'x'.repeat(16001) })).status).toBe(400);
    expect(client.share).not.toHaveBeenCalled();
    await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: ' Where it stands. ', mission: 3 });
    expect(client.share).toHaveBeenLastCalledWith(3, { contact: 'bob', level: 'owner', brief: 'Where it stands.', convo_id: 'c-1' });
  });

  it('project: N hands over a whole project, owner level only', async () => {
    const { h, client } = fixture();
    expect((await h.share({ roomId: R, contact: 'bob', project: 2 })).status).toBe(400);
    expect((await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: 'b', project: 2, mission: 3 })).status).toBe(400);
    expect((await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: 'b', project: 0 })).status).toBe(400);
    const r = await h.share({ roomId: R, contact: 'bob', level: 'owner', brief: 'b', project: 2 });
    expect(r.status).toBe(202);
    expect(client.shareProject).toHaveBeenCalledWith(2, { contact: 'bob', level: 'owner', brief: 'b', convo_id: 'c-1' });
    expect(client.share).not.toHaveBeenCalled();
    expect(formatShareAck(r.body)).toMatch(/project #2 "Spring"/);
  });
});

describe('contributor writes', () => {
  it('milestone_post shared_by resolves their number and posts to the mission id', async () => {
    const { h, client } = fixture();
    expect((await h.shared_post({ roomId: R, shared_by: 'alice', kind: 'progress', title: 't' })).status).toBe(400);
    expect((await h.shared_post({ roomId: R, shared_by: 'not a name', mission: 4, kind: 'progress', title: 't' })).status).toBe(400);
    expect((await h.shared_post({ roomId: R, shared_by: 'alice', mission: 4, kind: 'note', title: 't' })).status).toBe(400);
    const r = await h.shared_post({ roomId: R, shared_by: 'alice', mission: 4, kind: 'progress', title: ' Hall booked ', body: 'b' });
    expect(r.status).toBe(201);
    expect(client.lookup).toHaveBeenCalledWith('alice', 4);
    expect(client.contribMilestone).toHaveBeenCalledWith('ms_9', { kind: 'progress', title: 'Hall booked', body: 'b', convo_id: 'c-1' });
    expect(formatContribAck('Posted the milestone')(r.body)).toMatch(/their #5\) on alice's mission/);
  });

  it('refuses a read-only share and the user\'s own mission before writing', async () => {
    const ro = fixture({ client: { mission: vi.fn(async () => ok({ mission: { id: 'ms_9', num: 4, owner: { name: 'alice' }, grant: { level: 'read' } } })) } });
    const r = await ro.h.shared_status({ roomId: R, shared_by: 'alice', mission: 4, status: 'ok' });
    expect(r.status).toBe(403);
    expect(formatSharingError('shared_status', r.body)).toMatch(/read-only/);
    expect(ro.client.contribStatus).not.toHaveBeenCalled();
    const own = fixture({ client: { mission: vi.fn(async () => ok({ mission: { id: 'ms_9', num: 4 } })) } });
    const o = await own.h.shared_post({ roomId: R, shared_by: 'carol', mission: 4, kind: 'progress', title: 't' });
    expect(o.status).toBe(400);
    expect(formatSharingError('shared_post', o.body)).toMatch(/without shared_by/);
    // The journal's own 403 reads the same way.
    expect(formatSharingError('shared_item_comment', { error: 'forbidden' })).toMatch(/read-only/);
  });

  it('mission_status and item_create go to the mission id; no files, no buttons', async () => {
    const { h, client } = fixture();
    await h.shared_status({ roomId: R, shared_by: 'alice', mission: 4, status: 'On track' });
    expect(client.contribStatus).toHaveBeenCalledWith('ms_9', { status: 'On track', convo_id: 'c-1' });
    expect((await h.shared_status({ roomId: R, shared_by: 'alice', mission: 4, status: 'x'.repeat(601) })).status).toBe(400);
    expect((await h.shared_item_create({ roomId: R, shared_by: 'alice', mission: 4, kind: 'task', title: 't', attachments: ['a.png'] })).body.error).toMatch(/files do not cross/);
    expect((await h.shared_item_create({ roomId: R, shared_by: 'alice', mission: 4, kind: 'question', title: 't', actions: ['Go'] })).body.error).toMatch(/buttons/);
    await h.shared_item_create({ roomId: R, shared_by: 'alice', mission: 4, kind: 'task', title: 'Book the band', labels: ['music'] });
    expect(client.contribItem).toHaveBeenCalledWith('ms_9', { kind: 'task', title: 'Book the band', convo_id: 'c-1', labels: ['music'] });
  });

  it('item comment, close and reopen take an id or their number', async () => {
    const { h, client } = fixture();
    expect((await h.shared_item_comment({ roomId: R, shared_by: 'alice', id: '#12' })).status).toBe(400);
    expect((await h.shared_item_comment({ roomId: R, shared_by: 'alice', id: '#12', body: 'x', attachments: ['f'] })).status).toBe(400);
    await h.shared_item_comment({ roomId: R, shared_by: 'alice', id: '#12', body: 'Done on our side' });
    expect(client.lookup).toHaveBeenCalledWith('alice', 12);
    expect(client.itemComment).toHaveBeenCalledWith('it_12', { body: 'Done on our side', as_convo_id: 'c-1' });
    await h.shared_item_close({ roomId: R, shared_by: 'alice', id: 'it_77', resolution: 'done', comment: 'shipped' });
    expect(client.itemClose).toHaveBeenCalledWith('it_77', { resolution: 'done', as_convo_id: 'c-1', comment: 'shipped' });
    expect((await h.shared_item_close({ roomId: R, shared_by: 'alice', id: 'it_77', resolution: 'gone' })).status).toBe(400);
    await h.shared_item_reopen({ roomId: R, shared_by: 'alice', id: 12 });
    expect(client.itemReopen).toHaveBeenCalledWith('it_12', { as_convo_id: 'c-1' });
    // Their number resolving to something that is not an item: not found.
    expect((await h.shared_item_reopen({ roomId: R, shared_by: 'alice', id: '#4' })).status).toBe(404);
    expect((await h.shared_item_reopen({ roomId: R, shared_by: 'alice', id: 'nonsense' })).status).toBe(400);
  });
});

describe('sharing client, phase 3 routes', () => {
  it('hits the hand-over and contributor routes', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push([init.method, url, init.body ? JSON.parse(init.body) : null]); return { ok: true, status: 200, json: async () => ({}) }; });
    const c = createSharingClient({ baseUrl: 'https://j.example', token: 'tok', fetchImpl });
    await c.shareProject(2, { contact: 'bob', level: 'owner', brief: 'b' });
    await c.contribMilestone('ms_9', { kind: 'progress', title: 't' });
    await c.contribItem('ms_9', { kind: 'task', title: 't' });
    await c.contribStatus('ms_9', { status: 's' });
    await c.itemComment('it_1', { body: 'b' });
    await c.itemClose('it_1', { resolution: 'done' });
    await c.itemReopen('it_1', {});
    expect(calls.map(([m, u]) => `${m} ${u}`)).toEqual([
      'POST https://j.example/projects/2/shares',
      'POST https://j.example/milestones',
      'POST https://j.example/items',
      'PATCH https://j.example/missions/ms_9',
      'POST https://j.example/items/it_1/comments',
      'POST https://j.example/items/it_1/close',
      'POST https://j.example/items/it_1/reopen',
    ]);
    expect(calls[1][2]).toEqual({ kind: 'progress', title: 't', mission: 'ms_9' });
    expect(calls[2][2]).toEqual({ kind: 'task', title: 't', mission: 'ms_9' });
  });
});

describe('phase 3 renderers', () => {
  it('say what each level means once accepted', () => {
    const ack = (level) => formatShareAck({ grant: { level, grantee: { address: 'bob' }, mission: { num: 3, title: 'Launch' } }, pending: 'owner' });
    expect(ack('read')).toMatch(/read-only and live/);
    expect(ack('contribute')).toMatch(/post milestones, comment, file and close items/);
    expect(ack('owner')).toMatch(/copy of mission #3 "Launch" in their own tracker, with your brief as its first milestone/);
    expect(ack('owner')).toMatch(/would receive/);
  });

  it('list levels in words and tell a contributor how to write', () => {
    const g = formatGrantList({ grants: [{ id: 'gr_1', direction: 'out', level: 'contribute', state: 'active', grantee: { address: 'bob' }, mission: { num: 3, title: 'Launch' } }] });
    expect(g).toContain('(can contribute)');
    const d = formatSharedMissionDetail({ mission: { num: 4, title: 'Fair', owner: { name: 'alice' }, grant: { level: 'contribute' } }, milestones: [], items: [] });
    expect(d).toMatch(/Shared by alice \(can contribute\)/);
    expect(d).toMatch(/milestone_post, mission_status and item_create with shared_by: "alice" and mission: 4/);
    expect(d).not.toMatch(/You cannot change this mission/);
  });

  it('turn the hand-over refusals into sentences', () => {
    for (const [code, re] of [['handed_over', /already been handed over/], ['mission_closed', /closed/], ['empty_project', /no open missions/], ['level_unavailable', /does not offer that level/]]) {
      expect(formatSharingError('share', { error: 'conflict', blocked_by: code })).toMatch(re);
    }
  });
});
