import { describe, it, expect, vi } from 'vitest';
import { createBriefingHandlers, formatBriefingPublishAck, formatJournalBriefingsError, validateBriefingBody, BRIEFING_BODY_MAX } from '../lib/briefings-tools.js';
import { createBriefingsClient } from '../lib/briefings-client.js';

const published = { status: 201, data: { briefing: { id: 'br_1', body: '**All quiet.**', created_at: 1, convo_id: 'c-coord', seq: 42 } } };

function fixture({ coordinator = true, publish = published } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const sessions = new Map([['!r:s', session]]);
  const client = { publishBriefing: vi.fn(async () => publish) };
  const h = createBriefingHandlers({ sessions, journalConvoIdFor: (s) => s?.journalConvoId ?? null, client });
  return { h, client, session };
}

describe('briefing handler', () => {
  it('refuses a non-Coordinator session before any journal call, and the usual session guards', async () => {
    const { h, client } = fixture({ coordinator: false });
    const r = await h.publish({ roomId: '!r:s', body: 'x' });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/not the Coordinator/);
    expect(client.publishBriefing).not.toHaveBeenCalled();
    expect((await h.publish({ body: 'x' })).status).toBe(400);
    expect((await h.publish({ roomId: '!other', body: 'x' })).status).toBe(404);
    const noConvo = fixture();
    noConvo.session.journalConvoId = null;
    expect((await noConvo.h.publish({ roomId: '!r:s', body: 'x' })).status).toBe(409);
  });

  it('isCoordinator lets the wiring count the journal\'s current role holder', async () => {
    const session = { roomId: '!r:s', coordinator: false, journalConvoId: 'c-coord' };
    const client = { publishBriefing: vi.fn(async () => published) };
    const h = createBriefingHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client, isCoordinator: (s, convoId) => s.coordinator === true || convoId === 'c-coord' });
    expect((await h.publish({ roomId: '!r:s', body: 'x' })).status).toBe(201);
    session.journalConvoId = 'c-other';
    expect((await h.publish({ roomId: '!r:s', body: 'x' })).status).toBe(403);
  });

  it('posts the trimmed body with the Coordinator convo_id and the call\'s idempotency key', async () => {
    const { h, client } = fixture();
    const r = await h.publish({ roomId: '!r:s', body: '  **All quiet.**\n', idem_key: 'k1' });
    expect(r).toEqual({ status: 201, body: published.data });
    expect(client.publishBriefing).toHaveBeenCalledWith({ convo_id: 'c-coord', body: '**All quiet.**' }, { idemKey: 'k1' });
    await h.publish({ roomId: '!r:s', body: 'x' });
    expect(client.publishBriefing.mock.calls[1][1]).toEqual({ idemKey: null });
  });

  it('a replay (200) passes through like a first publish', async () => {
    const { h } = fixture({ publish: { ...published, status: 200 } });
    expect((await h.publish({ roomId: '!r:s', body: 'x', idem_key: 'k1' })).status).toBe(200);
  });

  it('validates the body with reasons before the journal', async () => {
    const { h, client } = fixture();
    for (const body of [undefined, '', '   \n', 42]) {
      const r = await h.publish({ roomId: '!r:s', body });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/body is required/);
    }
    const tooLong = await h.publish({ roomId: '!r:s', body: 'é'.repeat(BRIEFING_BODY_MAX / 2 + 1) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toMatch(/too long: at most 32 KB/);
    expect(client.publishBriefing).not.toHaveBeenCalled();
    expect(validateBriefingBody('a'.repeat(BRIEFING_BODY_MAX))).toEqual({ ok: true, value: 'a'.repeat(BRIEFING_BODY_MAX) });
    expect(validateBriefingBody(`  ${'a'.repeat(BRIEFING_BODY_MAX)}  `).ok).toBe(true);
  });

  it('maps journal errors to sentences, and unreachable to 502', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, 403, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden' } }, 403, /only the Coordinator agent may publish/],
      [{ status: 404, data: { error: 'not_found' } }, 404, /does not know this conversation.*\/briefings route yet/],
      [{ status: 400, data: { error: 'bad_request' } }, 400, /non-empty markdown of at most 32 KB/],
      [{ status: 500, data: { error: 'HTTP 500' } }, 500, /^HTTP 500$/],
      [{ status: 0, data: { error: 'journal unreachable' } }, 502, /^journal unreachable$/],
    ];
    for (const [publish, status, re] of cases) {
      const r = await fixture({ publish }).h.publish({ roomId: '!r:s', body: 'x' });
      expect(r.status, JSON.stringify(publish)).toBe(status);
      expect(r.body.error, JSON.stringify(publish)).toMatch(re);
      expect(r.body.error).not.toMatch(/\bnot_found\b|\bbad_request\b|\bforbidden\b|\bnot_coordinator\b/);
    }
    expect(formatJournalBriefingsError(null)).toBe('unknown error');
  });
});

describe('formatBriefingPublishAck', () => {
  it('links the conversation and the seq, and says not to repeat it', () => {
    expect(formatBriefingPublishAck(published.data)).toBe('Briefing published (matron://convo/c-coord, seq 42). It is already in the chat — do not repeat it.');
    expect(formatBriefingPublishAck({ briefing: { convo_id: 'c1' } })).toBe('Briefing published (matron://convo/c1). It is already in the chat — do not repeat it.');
    expect(formatBriefingPublishAck({})).toBe('Briefing published. It is already in the chat — do not repeat it.');
  });
});

describe('createBriefingsClient', () => {
  function fakeFetch(handler) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, init });
      const r = handler(url, init);
      return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
    });
    return { fetchImpl, calls };
  }

  it('publishBriefing posts to /briefings with bearer, idempotency key and JSON body', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 201, body: published.data }));
    const c = createBriefingsClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await c.publishBriefing({ convo_id: 'c1', body: 'b' }, { idemKey: 'k1' });
    expect(r).toEqual({ status: 201, data: published.data });
    expect(calls[0].url).toBe('https://j/briefings');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(calls[0].init.headers['Idempotency-Key']).toBe('k1');
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(calls[0].init.body)).toEqual({ convo_id: 'c1', body: 'b' });
  });

  it('sends no Idempotency-Key without one, returns error statuses, and never throws', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 403, body: { error: 'forbidden', detail: 'not_coordinator' } }));
    const c = createBriefingsClient({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(await c.publishBriefing({ convo_id: 'c1', body: 'b' })).toEqual({ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } });
    expect(calls[0].init.headers['Idempotency-Key']).toBeUndefined();
    const boom = createBriefingsClient({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('down'); } });
    expect(await boom.publishBriefing({ convo_id: 'c1', body: 'b' })).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    expect(await createBriefingsClient({ token: 't', fetchImpl }).publishBriefing({})).toEqual({ status: 0, data: { error: 'journal unreachable' } });
  });
});
