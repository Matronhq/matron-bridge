import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { createAgentChatHandlers } from '../lib/agent-chat.js';
import { createAgentRooms } from '../lib/agent-rooms.js';

const SELF = { deviceId: 1, name: 'mac' };
const ROSTER = {
  agents: [
    { device_id: 1, name: 'mac' },
    { device_id: 7, name: 'dev-2' },
  ],
  conversations: [
    { id: 'convo-remote', title: 'Remote work', session_state: 'running', summary: 'porting the app', agent_device_id: 7, last_ts: 111 },
    { id: 'convo-self', title: 'Local work', session_state: 'running', summary: null, agent_device_id: 1, last_ts: 222 },
    { id: 'convo-orphan', title: 'No agent', session_state: 'ended', summary: '', agent_device_id: null, last_ts: 333 },
  ],
};

// Fake publisher + fake invites record every call into one shared `calls`
// list (with the registry's record() wrapped into it too) so ordering
// invariants — upsert before opening publish before record before invite —
// are assertable directly.
function makeFixture(overrides = {}) {
  const calls = [];
  const publisher = {
    identity: () => SELF,
    fetchRoster: async () => ROSTER,
    fetchMessages: async () => ({ events: [] }),
    upsertConvo: (convoId, opts) => calls.push({ call: 'upsertConvo', convoId, opts }),
    publishText: (convoId, payload) => calls.push({ call: 'publishText', convoId, payload }),
    ...overrides.publisher,
  };
  const registry = createAgentRooms({ log: { warn: () => {} } });
  const rooms = {
    ...registry,
    record: (roomId, fields) => { calls.push({ call: 'record', roomId, fields }); return registry.record(roomId, fields); },
  };
  const invites = {
    invite: vi.fn(async (args) => { calls.push({ call: 'invite', args }); return overrides.inviteOutcome ?? { kind: 'accepted', peerDeviceId: 7 }; }),
    join: vi.fn(async (args) => { calls.push({ call: 'join', args }); return overrides.joinOutcome ?? { kind: 'accepted', peerDeviceId: 7 }; }),
    answer: vi.fn(() => true),
    leave: vi.fn(() => true),
    ...overrides.invites,
  };
  const sessions = new Map([['!sess', { busy: false, alive: true }]]);
  const log = { warn: vi.fn() };
  const handlers = createAgentChatHandlers({
    sessions, publisher, rooms, invites,
    awaitRoomMessage: overrides.awaitRoomMessage,
    serverLabel: '2',
    log,
  });
  return { handlers, calls, publisher, rooms, invites, sessions, log };
}

describe('createAgentChatHandlers', () => {
  describe('caller-session gate (all handlers)', () => {
    it('rejects a missing or non-string roomId with 400', async () => {
      const { handlers } = makeFixture();
      for (const h of ['roster', 'chatStart', 'chatSend', 'chatAccept', 'chatRefuse', 'chatJoin', 'chatLeave', 'chatRead']) {
        expect((await handlers[h]({})).status).toBe(400);
        expect((await handlers[h]({ roomId: 42 })).status).toBe(400);
      }
    });

    it('rejects an unknown session with 404', async () => {
      const { handlers } = makeFixture();
      const res = await handlers.roster({ roomId: '!nope' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/no active session/i);
    });
  });

  describe('roster', () => {
    it('returns self, excludes self from agents, maps conversations', async () => {
      const { handlers } = makeFixture();
      const res = await handlers.roster({ roomId: '!sess' });
      expect(res.status).toBe(200);
      expect(res.body.self).toEqual({ device_id: 1, name: 'mac' });
      expect(res.body.agents).toEqual([{ device_id: 7, name: 'dev-2' }]);
      expect(res.body.conversations).toEqual([
        { id: 'convo-remote', title: 'Remote work', session_state: 'running', summary: 'porting the app', agent_device_id: 7, last_ts: 111 },
        { id: 'convo-self', title: 'Local work', session_state: 'running', summary: '', agent_device_id: 1, last_ts: 222 },
        { id: 'convo-orphan', title: 'No agent', session_state: 'ended', summary: '', agent_device_id: null, last_ts: 333 },
      ]);
    });

    it('handles a null identity: self is null, agents unfiltered', async () => {
      const { handlers } = makeFixture({ publisher: { identity: () => null } });
      const res = await handlers.roster({ roomId: '!sess' });
      expect(res.body.self).toBeNull();
      expect(res.body.agents).toHaveLength(2);
    });

    it('502s when the roster fetch fails open with null', async () => {
      const { handlers } = makeFixture({ publisher: { fetchRoster: async () => null } });
      const res = await handlers.roster({ roomId: '!sess' });
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/journal unreachable/i);
    });
  });

  describe('chatStart', () => {
    const good = { roomId: '!sess', target_convo_id: 'convo-remote', topic: 'ci triage', justification: 'need eyes', message: 'hi, seen the red build?' };

    it('validates target_convo_id, justification, message', async () => {
      const { handlers } = makeFixture();
      expect((await handlers.chatStart({ ...good, target_convo_id: undefined })).status).toBe(400);
      expect((await handlers.chatStart({ ...good, justification: undefined })).status).toBe(400);
      expect((await handlers.chatStart({ ...good, message: undefined })).status).toBe(400);
    });

    it('502s when the roster is unreachable', async () => {
      const { handlers } = makeFixture({ publisher: { fetchRoster: async () => null } });
      expect((await handlers.chatStart(good)).status).toBe(502);
    });

    it('404s a target conversation not in the roster', async () => {
      const { handlers } = makeFixture();
      const res = await handlers.chatStart({ ...good, target_convo_id: 'convo-ghost' });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/convo-ghost/);
    });

    it('409s a conversation with no owning agent', async () => {
      const { handlers } = makeFixture();
      const res = await handlers.chatStart({ ...good, target_convo_id: 'convo-orphan' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/no owning agent/i);
    });

    it('400s a self-targeted conversation', async () => {
      const { handlers } = makeFixture();
      const res = await handlers.chatStart({ ...good, target_convo_id: 'convo-self' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/this bridge/i);
    });

    it('accepted: mints a room, upserts title, publishes opening message, records, invites — in that order', async () => {
      const { handlers, calls, rooms, invites } = makeFixture();
      const res = await handlers.chatStart(good);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('accepted');
      const chatRoomId = res.body.room_id;
      expect(chatRoomId).toMatch(/^[0-9a-f-]{36}$/);

      expect(calls.map((c) => c.call)).toEqual(['upsertConvo', 'publishText', 'record', 'invite']);
      expect(calls[0]).toEqual({ call: 'upsertConvo', convoId: chatRoomId, opts: { title: 'mac ↔ dev-2 — ci triage', sessionState: 'running' } });
      expect(calls[1]).toEqual({ call: 'publishText', convoId: chatRoomId, payload: { body: 'hi, seen the red build?', from: 'agent' } });
      expect(calls[2].fields).toEqual({
        role: 'owner', state: 'pending', sessionRoomId: '!sess',
        peerDeviceId: 7, peerName: 'dev-2', topic: 'ci triage', title: 'mac ↔ dev-2 — ci triage',
      });
      expect(invites.invite).toHaveBeenCalledWith({ roomId: chatRoomId, targetDeviceId: 7, topic: 'ci triage', justification: 'need eyes' });
      // The invite outcome drives state via onInviteFrame in production; the
      // handler itself leaves the registry pending.
      expect(rooms.get(chatRoomId).state).toBe('pending');
    });

    it('omits the topic suffix from the title when no topic given', async () => {
      const { handlers, calls } = makeFixture();
      await handlers.chatStart({ ...good, topic: undefined });
      expect(calls[0].opts.title).toBe('mac ↔ dev-2');
    });

    it('falls back to serverLabel when identity is unknown and caps the title at 120 chars', async () => {
      const { handlers, calls } = makeFixture({ publisher: { identity: () => null } });
      await handlers.chatStart({ ...good, topic: 'x'.repeat(300) });
      expect(calls[0].opts.title.startsWith('2 ↔ dev-2 — xxx')).toBe(true);
      expect(calls[0].opts.title).toHaveLength(120);
    });

    it('maps outcome kinds to tool responses', async () => {
      const table = [
        [{ kind: 'refused', reason: 'busy elsewhere' }, 200, { status: 'refused', reason: 'busy elsewhere' }],
        [{ kind: 'pending_busy' }, 200, { status: 'pending_busy' }],
        [{ kind: 'pending_idle' }, 200, { status: 'pending' }],
        [{ kind: 'pending_quiet' }, 200, { status: 'pending' }],
        [{ kind: 'error', code: 'offline' }, 200, { status: 'offline' }],
      ];
      for (const [outcome, status, bodyMatch] of table) {
        const { handlers } = makeFixture({ inviteOutcome: outcome });
        const res = await handlers.chatStart(good);
        expect(res.status).toBe(status);
        expect(res.body).toMatchObject(bodyMatch);
      }
    });

    it('maps conflict errors to 409 and other errors to 502', async () => {
      let f = makeFixture({ inviteOutcome: { kind: 'error', code: 'conflict', detail: 'already invited' } });
      let res = await f.handlers.chatStart(good);
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('already invited');

      f = makeFixture({ inviteOutcome: { kind: 'error', code: 'journal_unreachable' } });
      res = await f.handlers.chatStart(good);
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('journal_unreachable');
    });

    it('502s and warns on an unexpected outcome kind', async () => {
      const { handlers, log } = makeFixture({ inviteOutcome: { kind: 'banana' } });
      const res = await handlers.chatStart(good);
      expect(res.status).toBe(502);
      expect(res.body.error).toMatch(/unexpected invite outcome/i);
      expect(log.warn).toHaveBeenCalledOnce();
    });
  });

  describe('chatSend', () => {
    function joined(f, roomId = 'room-1', state = 'joined', role = 'guest') {
      f.rooms.record(roomId, { role, state, sessionRoomId: '!sess' });
      return roomId;
    }

    it('400s a missing room_id and 404s a room this session is not in', async () => {
      const { handlers, rooms } = makeFixture();
      expect((await handlers.chatSend({ roomId: '!sess', message: 'x' })).status).toBe(400);
      expect((await handlers.chatSend({ roomId: '!sess', room_id: 'room-ghost', message: 'x' })).status).toBe(404);
      rooms.record('room-other', { role: 'guest', state: 'joined', sessionRoomId: '!other' });
      expect((await handlers.chatSend({ roomId: '!sess', room_id: 'room-other', message: 'x' })).status).toBe(404);
    });

    it('409s a guest room that is not joined', async () => {
      const f = makeFixture();
      const id = joined(f, 'room-1', 'pending');
      const res = await f.handlers.chatSend({ roomId: '!sess', room_id: id, message: 'x' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/pending/);
    });

    it('lets the owner send while the room is still pending', async () => {
      const f = makeFixture();
      const id = joined(f, 'room-1', 'pending', 'owner');
      const res = await f.handlers.chatSend({ roomId: '!sess', room_id: id, message: 'x' });
      expect(res.status).toBe(200);
    });

    it('400s a missing message', async () => {
      const f = makeFixture();
      const id = joined(f);
      expect((await f.handlers.chatSend({ roomId: '!sess', room_id: id })).status).toBe(400);
    });

    it('publishes the message and does not wait when wait_seconds is absent', async () => {
      const awaitRoomMessage = vi.fn(async () => ({ from: 'dev-2 (agent)', body: 'yo' }));
      const f = makeFixture({ awaitRoomMessage });
      const id = joined(f);
      const res = await f.handlers.chatSend({ roomId: '!sess', room_id: id, message: 'ping' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, note: 'sent — any reply will arrive as a later turn' });
      expect(f.calls).toContainEqual({ call: 'publishText', convoId: id, payload: { body: 'ping', from: 'agent' } });
      expect(awaitRoomMessage).not.toHaveBeenCalled();
    });

    it('returns a quick reply from the wait window and caps wait_seconds at 60', async () => {
      const awaitRoomMessage = vi.fn(async () => ({ from: 'dev-2 (agent)', body: 'yo' }));
      const f = makeFixture({ awaitRoomMessage });
      const id = joined(f);
      const res = await f.handlers.chatSend({ roomId: '!sess', room_id: id, message: 'ping', wait_seconds: 999 });
      expect(awaitRoomMessage).toHaveBeenCalledWith(id, 60_000);
      expect(res.body).toEqual({ ok: true, reply: { from: 'dev-2 (agent)', body: 'yo' } });
    });

    it('falls back to the sent note when the wait times out', async () => {
      const awaitRoomMessage = vi.fn(async () => null);
      const f = makeFixture({ awaitRoomMessage });
      const id = joined(f);
      const res = await f.handlers.chatSend({ roomId: '!sess', room_id: id, message: 'ping', wait_seconds: 5 });
      expect(awaitRoomMessage).toHaveBeenCalledWith(id, 5000);
      expect(res.body.note).toMatch(/later turn/);
    });
  });

  describe('chatAccept / chatRefuse', () => {
    it('404s when there is no room or it belongs to another session', async () => {
      const { handlers, rooms } = makeFixture();
      expect((await handlers.chatAccept({ roomId: '!sess', room_id: 'room-ghost' })).status).toBe(404);
      rooms.record('room-other', { role: 'guest', state: 'pending', sessionRoomId: '!other' });
      expect((await handlers.chatAccept({ roomId: '!sess', room_id: 'room-other' })).status).toBe(404);
    });

    it('409s a room that is not pending', async () => {
      const { handlers, rooms } = makeFixture();
      rooms.record('room-1', { role: 'guest', state: 'joined', sessionRoomId: '!sess' });
      const res = await handlers.chatAccept({ roomId: '!sess', room_id: 'room-1' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/nothing to answer/i);
    });

    it('guest accept omits peer_device_id and joins the room', async () => {
      const { handlers, rooms, invites } = makeFixture();
      rooms.record('room-1', { role: 'guest', state: 'pending', sessionRoomId: '!sess', peerDeviceId: 7 });
      const res = await handlers.chatAccept({ roomId: '!sess', room_id: 'room-1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, room_id: 'room-1' });
      expect(invites.answer).toHaveBeenCalledWith({ roomId: 'room-1', peerDeviceId: null, accept: true, reason: undefined });
      expect(rooms.get('room-1').state).toBe('joined');
    });

    it('owner answering a join_request names the requester', async () => {
      const { handlers, rooms, invites } = makeFixture();
      rooms.record('room-1', { role: 'owner', state: 'pending', sessionRoomId: '!sess', peerDeviceId: 9 });
      await handlers.chatAccept({ roomId: '!sess', room_id: 'room-1' });
      expect(invites.answer).toHaveBeenCalledWith({ roomId: 'room-1', peerDeviceId: 9, accept: true, reason: undefined });
    });

    it('refuse carries the reason and marks the room refused', async () => {
      const { handlers, rooms, invites } = makeFixture();
      rooms.record('room-1', { role: 'guest', state: 'pending', sessionRoomId: '!sess' });
      const res = await handlers.chatRefuse({ roomId: '!sess', room_id: 'room-1', reason: 'mid-release' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, room_id: 'room-1', refused: true });
      expect(invites.answer).toHaveBeenCalledWith({ roomId: 'room-1', peerDeviceId: null, accept: false, reason: 'mid-release' });
      expect(rooms.get('room-1').state).toBe('refused');
    });

    it('502s when the answer op cannot be sent and leaves the room pending', async () => {
      const { handlers, rooms } = makeFixture({ invites: { answer: vi.fn(() => false) } });
      rooms.record('room-1', { role: 'guest', state: 'pending', sessionRoomId: '!sess' });
      const res = await handlers.chatAccept({ roomId: '!sess', room_id: 'room-1' });
      expect(res.status).toBe(502);
      expect(rooms.get('room-1').state).toBe('pending');
    });
  });

  describe('chatJoin', () => {
    it('validates room_id and justification', async () => {
      const { handlers } = makeFixture();
      expect((await handlers.chatJoin({ roomId: '!sess', justification: 'j' })).status).toBe(400);
      expect((await handlers.chatJoin({ roomId: '!sess', room_id: 'room-1' })).status).toBe(400);
    });

    it('records a pending guest binding, sends the join, maps the outcome', async () => {
      const { handlers, rooms, invites } = makeFixture({ joinOutcome: { kind: 'pending_busy' } });
      const res = await handlers.chatJoin({ roomId: '!sess', room_id: 'room-1', justification: 'user handed me this room' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ room_id: 'room-1', status: 'pending_busy' });
      expect(invites.join).toHaveBeenCalledWith({ roomId: 'room-1', justification: 'user handed me this room' });
      expect(rooms.get('room-1')).toMatchObject({ role: 'guest', state: 'pending', sessionRoomId: '!sess' });
    });
  });

  describe('chatLeave', () => {
    it('404s a room this session is not in', async () => {
      const { handlers } = makeFixture();
      expect((await handlers.chatLeave({ roomId: '!sess', room_id: 'room-ghost' })).status).toBe(404);
    });

    it('sends the leave op and marks the room left, even from pending', async () => {
      const { handlers, rooms, invites } = makeFixture();
      rooms.record('room-1', { role: 'guest', state: 'pending', sessionRoomId: '!sess' });
      const res = await handlers.chatLeave({ roomId: '!sess', room_id: 'room-1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(invites.leave).toHaveBeenCalledWith({ roomId: 'room-1' });
      expect(rooms.get('room-1').state).toBe('left');
    });
  });

  describe('chatRead', () => {
    it('404s a room this session is not in', async () => {
      const { handlers } = makeFixture();
      expect((await handlers.chatRead({ roomId: '!sess', room_id: 'room-ghost' })).status).toBe(404);
    });

    it('works on a non-joined room (inbox catch-up after refusal/leave)', async () => {
      const { handlers, rooms } = makeFixture();
      rooms.record('room-1', { role: 'guest', state: 'left', sessionRoomId: '!sess' });
      const res = await handlers.chatRead({ roomId: '!sess', room_id: 'room-1' });
      expect(res.status).toBe(200);
    });

    it('502s when the fetch fails open with null', async () => {
      const { handlers, rooms } = makeFixture({ publisher: { fetchMessages: async () => null } });
      rooms.record('room-1', { role: 'guest', state: 'joined', sessionRoomId: '!sess' });
      expect((await handlers.chatRead({ roomId: '!sess', room_id: 'room-1' })).status).toBe(502);
    });

    it('filters to text/file/image, describes attachments, carries captions', async () => {
      const events = [
        { type: 'text', sender: 'agent:dev-2', ts: 1, payload: { body: 'hello' } },
        { type: 'prompt', sender: 'agent:dev-2', ts: 2, payload: { body: 'nope' } },
        { type: 'tool_output', sender: 'agent:dev-2', ts: 3, payload: { body: 'nope' } },
        { type: 'file', sender: 'user:dan', ts: 4, payload: { name: 'notes.pdf', caption: 'read me' } },
        { type: 'image', sender: 'agent:mac', ts: 5, payload: {} },
      ];
      const { handlers, rooms } = makeFixture({ publisher: { fetchMessages: async () => ({ events }) } });
      rooms.record('room-1', { role: 'guest', state: 'joined', sessionRoomId: '!sess' });
      const res = await handlers.chatRead({ roomId: '!sess', room_id: 'room-1' });
      expect(res.body.room_id).toBe('room-1');
      expect(res.body.messages).toEqual([
        { sender: 'agent:dev-2', type: 'text', ts: 1, body: 'hello' },
        { sender: 'user:dan', type: 'file', ts: 4, body: '[file "notes.pdf"]', caption: 'read me' },
        { sender: 'agent:mac', type: 'image', ts: 5, body: '[image "unnamed"]' },
      ]);
    });

    it('clamps the limit to 1..200 and defaults to 50', async () => {
      const fetchMessages = vi.fn(async () => ({ events: [] }));
      const { handlers, rooms } = makeFixture({ publisher: { fetchMessages } });
      rooms.record('room-1', { role: 'guest', state: 'joined', sessionRoomId: '!sess' });
      await handlers.chatRead({ roomId: '!sess', room_id: 'room-1' });
      expect(fetchMessages).toHaveBeenLastCalledWith('room-1', { limit: 50 });
      await handlers.chatRead({ roomId: '!sess', room_id: 'room-1', limit: 999 });
      expect(fetchMessages).toHaveBeenLastCalledWith('room-1', { limit: 200 });
      await handlers.chatRead({ roomId: '!sess', room_id: 'room-1', limit: -3 });
      expect(fetchMessages).toHaveBeenLastCalledWith('room-1', { limit: 1 });
      await handlers.chatRead({ roomId: '!sess', room_id: 'room-1', limit: 0 });
      expect(fetchMessages).toHaveBeenLastCalledWith('room-1', { limit: 50 });
    });
  });
});

// The loopback routes and MCP tool declarations live in index.js/ask-user.js
// and can't be imported, so the Task 8 surface is pinned by source
// inspection — the same technique the index.js wiring pins in
// busy-queue.test.js use. Handler behavior itself is covered above.
describe('index.js routes + ask-user.js tools (source inspection)', () => {
  const ROUTES = [
    ['/agent-roster', 'roster'],
    ['/agent-chat-start', 'chatStart'],
    ['/agent-chat-send', 'chatSend'],
    ['/agent-chat-accept', 'chatAccept'],
    ['/agent-chat-refuse', 'chatRefuse'],
    ['/agent-chat-join', 'chatJoin'],
    ['/agent-chat-leave', 'chatLeave'],
    ['/agent-chat-read', 'chatRead'],
  ];
  const TOOLS = [
    'agent_roster', 'agent_chat_start', 'agent_chat_send', 'agent_chat_accept',
    'agent_chat_refuse', 'agent_chat_join', 'agent_chat_leave', 'agent_chat_read',
  ];
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
  const askUserSrc = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf-8');

  it('mounts all eight loopback routes on their handlers', () => {
    for (const [route, handler] of ROUTES) {
      expect(indexSrc).toMatch(new RegExp(
        `url\\.pathname === '${route}'[\\s\\S]{0,120}agentChatHandlers\\.${handler}\\(data\\)`));
    }
  });

  it('constructs the handlers with the awaitRoomMessage seam fed from journalOnRoomFrame', () => {
    expect(indexSrc).toMatch(/createAgentChatHandlers\(\{/);
    expect(indexSrc).toMatch(/\bawaitRoomMessage,/);
    expect(indexSrc).toMatch(/function awaitRoomMessage\(chatRoomId, ms\)/);
    // journalOnRoomFrame feeds waiters BEFORE handing to roomDelivery.
    expect(indexSrc).toMatch(/resolveRoomReplyWaiters\(frame\.convo_id, \{ from, body \}\);\s*\n\s*roomDelivery\.deliver\(/);
  });

  it('declares all eight MCP tools in ask-user.js', () => {
    for (const name of TOOLS) {
      expect(askUserSrc).toMatch(new RegExp(`server\\.tool\\(\\s*\\n\\s*'${name}',`));
    }
  });

  it('keeps the no-polling etiquette in the tool descriptions', () => {
    expect(askUserSrc).toMatch(/do NOT wait or poll: continue your own work/);
    expect(askUserSrc).toMatch(/replies always arrive as later turns regardless, so never poll/);
  });
});
