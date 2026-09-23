import { describe, it, expect, vi } from 'vitest';
import { createCoordinatorLookup } from '../lib/coordinator.js';

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = vi.fn(async (url, init) => {
    calls.push({ url, init });
    const r = await handler(url, init);
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  });
  return { fetchImpl, calls };
}

function recordingLog() {
  const warns = [];
  return { warns, log: { warn: (m) => warns.push(m), error: () => {} } };
}

describe('createCoordinatorLookup', () => {
  it('is unknown until the journal answers, and an unknown role is never the coordinator', () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    expect(l.snapshot()).toEqual({ known: false, convoId: null });
    expect(l.roleFor(['c1'])).toEqual({ known: false, coordinator: false });
  });

  it('refresh reads convo_id with the agent bearer; roleFor matches any non-empty candidate', async () => {
    const { fetchImpl, calls } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    const r = await l.refresh({ force: true });
    expect(r).toEqual({ known: true, convoId: 'c1', fetched: true });
    expect(calls[0].url).toBe('https://j/coordinator');
    expect(calls[0].init.method).toBe('GET');
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(l.roleFor([undefined, null, '', 'other', 'c1'])).toEqual({ known: true, coordinator: true });
    expect(l.roleFor(['other'])).toEqual({ known: true, coordinator: false });
    expect(l.roleFor(null)).toEqual({ known: true, coordinator: false });
  });

  it('convo_id null (nobody, or hidden from this agent by the privacy filter) means known, nobody: every spawn is ordinary', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: null } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    expect(l.roleFor(['c1']).coordinator).toBe(false);
  });

  it('journal unreachable before it ever answered: stays unknown (ordinary spawns), warns once, never throws', async () => {
    const { fetchImpl } = fakeFetch(() => new Error('ECONNREFUSED'));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    const r1 = await l.refresh({ force: true });
    const r2 = await l.refresh({ force: true });
    expect(r1).toEqual({ known: false, convoId: null, fetched: false });
    expect(r2.fetched).toBe(false);
    expect(l.roleFor(['c1'])).toEqual({ known: false, coordinator: false });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/role unknown; sessions start as ordinary sessions/);
  });

  it('a failure after a good answer keeps the last known coordinator', async () => {
    let fail = false;
    const { fetchImpl } = fakeFetch(() => (fail ? { status: 503, body: {} } : { status: 200, body: { convo_id: 'c1' } }));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    fail = true;
    const r = await l.refresh({ force: true });
    expect(r).toEqual({ known: true, convoId: 'c1', fetched: false });
    expect(warns[0]).toMatch(/HTTP 503/);
    expect(warns[0]).toMatch(/keeping the last known coordinator \(c1\)/);
  });

  it('404 (journal predates /coordinator) is known-nobody, warned once', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 404, body: { error: 'not_found' } }));
    const { warns, log } = recordingLog();
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log });
    await l.refresh({ force: true });
    await l.refresh({ force: true });
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/predates GET \/coordinator/);
  });

  it('an unreadable body is a failure, not "nobody"', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 42 } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, log: recordingLog().log });
    const r = await l.refresh({ force: true });
    expect(r.fetched).toBe(false);
    expect(l.snapshot().known).toBe(false);
  });

  it('no base URL: never fetches, stays unknown', async () => {
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: '', token: 't', fetchImpl, log: recordingLog().log });
    const r = await l.refresh({ force: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r).toEqual({ known: false, convoId: null, fetched: false });
  });

  it('throttles unforced refreshes; force bypasses; concurrent calls share one request', async () => {
    let t = 1_000_000;
    const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { convo_id: 'c1' } }));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl, minRefreshMs: 30_000, now: () => t });
    await Promise.all([l.refresh(), l.refresh()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 10_000;
    const throttled = await l.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(throttled).toEqual({ known: true, convoId: 'c1', fetched: false });
    await l.refresh({ force: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    t += 30_000;
    await l.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('apply: assigned sets, released clears only the matching convo', () => {
    const l = createCoordinatorLookup({ baseUrl: '', token: 't' });
    l.apply('c1', 'assigned');
    expect(l.snapshot()).toEqual({ known: true, convoId: 'c1' });
    l.apply('c2', 'released');
    expect(l.snapshot()).toEqual({ known: true, convoId: 'c1' });
    l.apply('c1', 'released');
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
    l.apply('', 'assigned');
    l.apply('c3', 'bogus');
    expect(l.snapshot()).toEqual({ known: true, convoId: null });
  });

  it('an event applied while a GET is in flight is not clobbered by the stale answer; a forced refresh re-reads', async () => {
    const answers = [];
    const { fetchImpl } = fakeFetch(() => new Promise((resolve) => answers.push(resolve)));
    const l = createCoordinatorLookup({ baseUrl: 'https://j', token: 't', fetchImpl });
    const first = l.refresh({ force: true });
    l.apply('c2', 'assigned');
    const second = l.refresh({ force: true });
    answers.shift()({ status: 200, body: { convo_id: 'c1' } }); // stale: sent before the event
    expect(await first).toEqual({ known: true, convoId: 'c2', fetched: false });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers.shift()({ status: 200, body: { convo_id: 'c2' } });
    expect(await second).toEqual({ known: true, convoId: 'c2', fetched: true });
  });
});
