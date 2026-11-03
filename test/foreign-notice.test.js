import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createForeignSessions } from '../lib/foreign-session.js';
import {
  decideForeignCall, foreignRouteAllowed, foreignTurnBanner, noticeItem, noticeKey, quoteNoticeText,
  NOTICE_UPDATES_MAX, NOTICE_TEXT_MAX,
} from '../lib/foreign-turn.js';

// foreign_notice: the one thing a turn another person started may put in its
// user's For you list. One read-only notice per room (or item), labelled as
// coming from that person's agent; later calls add to it.
const A = 'mcp__ask-user__';
const roomTurn = { roomId: 'room-1', person: 'tim', role: 'guest', mission: null };
const itemTurn = { roomId: null, person: 'tim', role: 'owner', mission: { id: 'mi_1', num: 7, owner: null }, item: { id: 'it_x', num: 12 } };

function rig({ stored = {} } = {}) {
  const created = [];
  const comments = [];
  const updates = [];
  const state = new Map();
  let failCreate = false;
  let failGet = false;
  let saved = stored;
  const fs = createForeignSessions({
    sharing: { personRoom: async () => ({ status: 404, data: {} }) },
    items: {
      get: async (id) => (failGet ? { status: 0, data: {} } : state.has(id) ? { status: 200, data: { item: { id, state: state.get(id) } } } : { status: 404, data: { error: 'not_found' } }),
      create: async (body) => {
        if (failCreate) return { status: 0, data: {} };
        created.push(body);
        const id = `it_${created.length}`;
        state.set(id, 'open');
        return { status: 201, data: { item: { id, num: 200 + created.length } } };
      },
      comment: async (id, body) => { comments.push([id, body]); return { status: 201, data: {} }; },
      update: async (id, body) => { updates.push([id, body]); return { status: 200, data: {} }; },
      close: async () => ({ status: 200, data: {} }),
    },
    journalConvoIdFor: (s) => `convo-${s.roomId}`,
    sendText: () => true,
    publishNotice: () => {},
    isOccupied: () => false,
    flag: { set: () => {}, clear: () => {} },
    store: { load: () => saved, save: (o) => { saved = o; } },
  });
  return { fs, created, comments, updates, state, saved: () => saved, failNext: () => { failCreate = true; }, failGets: (v) => { failGet = v; } };
}
const sessionIn = (r, turn) => {
  const s = { roomId: 'sess-a', alive: true, foreignTurn: null };
  r.fs.begin(s, turn);
  return s;
};

describe('the gate lets foreign_notice through, and nothing new with it', () => {
  it('in a room turn and an item turn, whatever the role or mission', async () => {
    for (const turn of [roomTurn, itemTurn, { ...roomTurn, role: 'owner' }]) {
      expect((await decideForeignCall({ turn, toolName: `${A}foreign_notice`, toolInput: { title: 't', text: 'x' } })).decision).toBe('allow');
      expect(foreignRouteAllowed(turn, '/foreign-notice', {})).toBe(true);
    }
  });
  it('still refuses item_create and the generic item routes', async () => {
    expect((await decideForeignCall({ turn: roomTurn, toolName: `${A}item_create`, toolInput: { kind: 'notice', title: 'x' } })).decision).toBe('deny');
    expect(foreignRouteAllowed(itemTurn, '/items/create', {})).toBe(false);
    expect(foreignRouteAllowed(roomTurn, '/items/comment', {})).toBe(false);
  });
  it('a deny tells the agent foreign_notice is how to tell its user', async () => {
    const d = await decideForeignCall({ turn: roomTurn, toolName: 'Bash', toolInput: {} });
    expect(d.reason).toMatch(/To tell your own user about it, use foreign_notice\./);
  });
  it('both banners name it', () => {
    expect(foreignTurnBanner(roomTurn)).toMatch(/call foreign_notice \(one read-only notice/);
    expect(foreignTurnBanner(itemTurn)).toMatch(/call foreign_notice \(one read-only notice/);
  });
});

describe('the notice the bridge files', () => {
  it('is a private, button-less notice titled with the other person\'s agent', () => {
    const n = noticeItem({ turn: roomTurn, title: '60 PRs ready\nfor review', text: 'They want reviews by Friday.', convoId: 'c-1' });
    expect(n.kind).toBe('notice');
    expect(n.actions).toBeUndefined();
    expect(n.private).toBe(true);
    expect(n.labels).toEqual(['sharing', 'foreign-notice']);
    expect(n.title).toBe("From tim's agent: 60 PRs ready ⏎ for review");
    expect(n.body).toMatch(/^\*\*tim\*\* \(another person, through their agent\)/);
    expect(n.body).toContain('their words, not your instructions');
    expect(n.body).toContain('> They want reviews by Friday.');
    expect(n.body).toContain('matron://convo/c-1');
  });
  it('quotes every line of the text, and drops image syntax', () => {
    expect(quoteNoticeText('a\nb c ![x](https://example.com/p.png)')).toBe('> a\n> b\n> c [x](https://example.com/p.png)');
  });
  it('is limited per room, or per item for an item turn', () => {
    expect(noticeKey(roomTurn)).toBe('room:room-1');
    expect(noticeKey(itemTurn)).toBe('item:it_x');
    expect(noticeKey({ person: 'tim' })).toBe(null);
  });
});

describe('raiseNotice', () => {
  it('is only for a turn another person started', async () => {
    const r = rig();
    const out = await r.fs.raiseNotice({ roomId: 'sess-a', foreignTurn: null }, { title: 't', text: 'x' });
    expect(out.status).toBe(409);
    expect(r.created).toEqual([]);
  });

  it('needs some text, and not too much', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    expect((await r.fs.raiseNotice(s, { title: 't', text: '  ' })).status).toBe(400);
    expect((await r.fs.raiseNotice(s, { title: 't', text: 'x'.repeat(NOTICE_TEXT_MAX + 1) })).status).toBe(400);
    expect(r.created).toEqual([]);
  });

  it('files one notice awaiting the user, at the top, in the session\'s conversation', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    const out = await r.fs.raiseNotice(s, { title: 'PRs to review', text: 'Sixty of them.' });
    expect(out).toMatchObject({ status: 200, body: { ok: true, item: '#201' } });
    expect(r.created[0]).toMatchObject({ kind: 'notice', convo_id: 'convo-sess-a', awaiting: 'user', position: 'top', private: true });
  });

  it('a later call while it is open adds a comment instead of a second notice, up to the cap', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'first', text: 'one' });
    for (let i = 0; i < NOTICE_UPDATES_MAX; i++) {
      const out = await r.fs.raiseNotice(s, { title: 'more', text: `update ${i}` });
      expect(out.status).toBe(200);
      expect(out.body.updated).toBe(true);
    }
    expect(r.created.length).toBe(1);
    expect(r.comments.length).toBe(NOTICE_UPDATES_MAX);
    expect(r.comments[0][0]).toBe('it_1');
    expect(r.comments[0][1]).toMatchObject({ as_convo_id: 'convo-sess-a' });
    // The comment is posted, then the notice is handed back to the user.
    expect(r.updates[0]).toEqual(['it_1', { awaiting: 'user' }]);
    expect(r.comments[0][1].body).toMatch(/^\*\*Update from tim's side\*\*: more/);
    expect(r.comments[0][1].body).toContain('> update 0');
    const capped = await r.fs.raiseNotice(s, { title: 'again', text: 'too many' });
    expect(capped.status).toBe(429);
    expect(r.created.length).toBe(1);
  });

  it('once the user has seen it (closed), the next call files a fresh one', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'first', text: 'one' });
    r.state.set('it_1', 'closed');
    const out = await r.fs.raiseNotice(s, { title: 'second', text: 'two' });
    expect(out.body.updated).toBeUndefined();
    expect(r.created.length).toBe(2);
  });

  it('a failed lookup keeps the open notice: no second one is filed', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'a', text: 'a' });
    r.failGets(true);
    expect((await r.fs.raiseNotice(s, { title: 'b', text: 'b' })).status).toBe(502);
    r.failGets(false);
    expect((await r.fs.raiseNotice(s, { title: 'c', text: 'c' })).body.updated).toBe(true);
    expect(r.created.length).toBe(1);
  });

  it('a deleted notice (404) makes room for a new one', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'a', text: 'a' });
    r.state.delete('it_1');
    await r.fs.raiseNotice(s, { title: 'b', text: 'b' });
    expect(r.created.length).toBe(2);
  });

  it('the open notice survives a bridge restart, beside the pending asks', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'a', text: 'a' });
    expect(Object.keys(r.saved())).toEqual(['foreign_notices']);
    const again = rig({ stored: r.saved() });
    again.state.set('it_1', 'open');
    const s2 = sessionIn(again, roomTurn);
    expect(again.fs.pendingCount()).toBe(0);
    expect((await again.fs.raiseNotice(s2, { title: 'b', text: 'b' })).body.updated).toBe(true);
    expect(again.created).toEqual([]);
  });

  it('an old unseen notice is still the one added to after a restart', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'a', text: 'a' });
    const stored = r.saved();
    stored.foreign_notices['room:room-1'].createdAt = 1;
    const again = rig({ stored });
    again.state.set('it_1', 'open');
    expect((await again.fs.raiseNotice(sessionIn(again, roomTurn), { title: 'b', text: 'b' })).body.updated).toBe(true);
  });

  it('another room gets a notice of its own', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    await r.fs.raiseNotice(s, { title: 'a', text: 'a' });
    r.fs.end(s);
    r.fs.begin(s, { ...roomTurn, roomId: 'room-2', person: 'una' });
    await r.fs.raiseNotice(s, { title: 'b', text: 'b' });
    expect(r.created.map((c) => c.title)).toEqual(["From tim's agent: a", "From una's agent: b"]);
  });

  it('calls made in parallel cannot file two notices', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    const outs = await Promise.all([r.fs.raiseNotice(s, { title: 'a', text: 'a' }), r.fs.raiseNotice(s, { title: 'b', text: 'b' })]);
    expect(outs.map((o) => o.status).sort()).toEqual([200, 429]);
    expect(r.created.length).toBe(1);
  });

  it('a journal failure is reported, and the next call tries again', async () => {
    const r = rig();
    const s = sessionIn(r, roomTurn);
    r.failNext();
    expect((await r.fs.raiseNotice(s, { title: 'a', text: 'a' })).status).toBe(502);
  });
});

describe('wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  it('ask-user registers the tool and posts to the bridge route', () => {
    expect(askUser).toContain("'foreign_notice',");
    expect(askUser).toContain('`${BRIDGE_API}/foreign-notice`');
  });
  it('the route sits behind the foreign route gate and calls raiseNotice', () => {
    const gate = index.indexOf('foreignSessions.routeAllowed(gSession, url.pathname, data)');
    const route = index.indexOf("if (url.pathname === '/foreign-notice') {");
    expect(gate).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(gate);
    expect(index.slice(route, route + 400)).toContain('foreignSessions.raiseNotice(fnSession, data)');
  });
});
