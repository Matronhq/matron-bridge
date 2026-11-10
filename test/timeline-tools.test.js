import { describe, it, expect, vi } from 'vitest';
import {
  createTimelineHandlers, formatJournalTimelineError, formatTimelineWriteAck, formatTimelineReadAck,
  normalizeRef, validateTimelineWrite, validateWeekKey, TIMELINE_LIMITS,
} from '../lib/timeline-tools.js';
import { createTimelineClient } from '../lib/timeline-client.js';

const rawWeek = (over = {}) => ({ week: '2026-11-09', start: 1, end: 2, final: false, written_at: null, current: true, stored: null, projects: [], more_projects: false, ...over });
const pagedWeek = (over = {}) => rawWeek({ projects_total: 0, offset: 0, next_offset: null, ...over });
const quiet = { total: 2, rows: [{ project: { id: 'p1', num: 1, title: 'A' }, last_moved_at: 5, note: null, weekly: false }] };

function fixture({ coordinator = true, client = {} } = {}) {
  const session = { roomId: '!r:s', coordinator, journalConvoId: 'c-coord' };
  const c = {
    readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week }) })),
    listWeeks: vi.fn(async () => ({ status: 200, data: { weeks: [{ week: '2026-11-09' }, { week: '2026-11-02' }], next_before: null } })),
    wentQuiet: vi.fn(async () => ({ status: 200, data: quiet })),
    writeWeekEntries: vi.fn(async (week, body) => ({ status: 201, data: { week, written: true, final: body.final, entries: body.entries.length } })),
    ...client,
  };
  const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s?.journalConvoId ?? null, client: c });
  return { h, c, session };
}

const entry = (over = {}) => ({ project: 3, sentence: 'The thing went out.', ...over });
const call = (over = {}) => ({ roomId: '!r:s', week: '2026-11-02', entries: [entry()], ...over });

describe('timeline handlers: gate', () => {
  it('refuses a non-Coordinator before any journal call, and the usual session guards', async () => {
    const { h, c } = fixture({ coordinator: false });
    for (const op of ['read', 'write']) {
      const r = await h[op](call());
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/not the Coordinator/);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect(c.listWeeks).not.toHaveBeenCalled();
    expect(c.writeWeekEntries).not.toHaveBeenCalled();
    const ok = fixture();
    for (const op of ['read', 'write']) {
      expect((await ok.h[op]({ ...call(), roomId: undefined })).status).toBe(400);
      expect((await ok.h[op]({ ...call(), roomId: '!other' })).status).toBe(404);
    }
    ok.session.journalConvoId = null;
    expect((await ok.h.write(call())).status).toBe(409);
  });
});

describe('timeline_week_read', () => {
  it('defaults to the current week via listWeeks, and includes quiet for the current week only', async () => {
    const { h, c } = fixture();
    const r = await h.read({ roomId: '!r:s' });
    expect(c.listWeeks).toHaveBeenCalledWith({ limit: 1 });
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09', { offset: 0 });
    expect(r.status).toBe(200);
    expect(r.body.week.week).toBe('2026-11-09');
    expect(r.body.quiet).toEqual(quiet.rows);
    expect(r.body.quiet_total).toBe(2);
  });

  it('an explicit past week skips listWeeks and carries no quiet list', async () => {
    const { h, c } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: rawWeek({ week, current: false }) })) } });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(c.listWeeks).not.toHaveBeenCalled();
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(r.body).toEqual({ week: rawWeek({ week: '2026-11-02', current: false }) });
  });

  it('rejects a malformed or non-Monday week locally', async () => {
    const { h, c } = fixture();
    for (const week of ['yesterday', '2026-11-03', '2026-02-30', '2026-13-01']) {
      const r = await h.read({ roomId: '!r:s', week });
      expect(r.status, week).toBe(400);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
  });

  it('an empty week list is a clear 404; journal errors become sentences; unreachable is 502', async () => {
    expect((await fixture({ client: { listWeeks: async () => ({ status: 200, data: { weeks: [] } }) } }).h.read({ roomId: '!r:s' })).body.error).toMatch(/no weeks yet/);
    const bad = await fixture({ client: { readWeekRaw: async () => ({ status: 400, data: { error: 'bad_request', detail: 'bad_week' } }) } }).h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/Monday of the week/);
    const down = await fixture({ client: { listWeeks: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.read({ roomId: '!r:s' });
    expect(down).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    const phase1 = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: { week: '2026-11-09', start: 1, end: 2, final: false, projects: [] } }) } }).h.read({ roomId: '!r:s' });
    expect(phase1.status).toBe(404);
    expect(phase1.body.error).toMatch(/^the journal predates the timeline routes — deploy/);
    expect(phase1.body.error).not.toMatch(/conversation/);
    const phase1b = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: { current: true, week: '2026-11-09' } }) } }).h.read({ roomId: '!r:s' });
    expect(phase1b.status).toBe(404);
    const badRead = await fixture({ client: { readWeekRaw: async () => ({ status: 400, data: { error: 'bad_request' } }) } }).h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(badRead.body.error).toMatch(/Monday of the week/);
    expect(badRead.body.error).not.toMatch(/story limits/);
    const quietDown = await fixture({ client: { wentQuiet: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.read({ roomId: '!r:s' });
    expect(quietDown.status).toBe(502);
  });

  it('the quiet line comes first, and only at offset 0 of the current week', async () => {
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week }) })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r.status).toBe(200);
    const lines = formatTimelineReadAck(r.body).split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(`quiet (1 of 2): ${JSON.stringify(quiet.rows)}`);
    expect(lines[1]).toBe(`week: ${JSON.stringify(pagedWeek())}`);
    expect(lines[2]).toBe('That is every project that moved this week.');

    const later = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, offset: 12, projects_total: 14 }) })) } });
    const r2 = await later.h.read({ roomId: '!r:s', offset: 12 });
    expect(later.c.wentQuiet).not.toHaveBeenCalled();
    expect(r2.body.quiet).toBeUndefined();
    const text = formatTimelineReadAck(r2.body);
    expect(text).not.toMatch(/quiet \(/);
    expect(text.split('\n')[0]).toMatch(/^week: \{/);
  });

  it('offset: 12 is passed to the journal as &offset=12', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url]); return { ok: true, status: 200, json: async () => pagedWeek({ current: false, offset: 12, projects_total: 14 }) }; };
    const session = { roomId: '!r:s', coordinator: true, journalConvoId: 'c-coord' };
    const h = createTimelineHandlers({ sessions: new Map([['!r:s', session]]), journalConvoIdFor: (s) => s.journalConvoId, client: createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl }) });
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', offset: 12 })).status).toBe(200);
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09' })).status).toBe(200);
    expect(calls).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1&offset=12'],
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1'],
    ]);
  });

  it('a bad offset is refused locally', async () => {
    const { h, c } = fixture();
    for (const offset of [-1, 1.5, '12', true, {}]) {
      const r = await h.read({ roomId: '!r:s', week: '2026-11-09', offset });
      expect(r.status, JSON.stringify(offset)).toBe(400);
      expect(r.body.error).toMatch(/^offset must be a whole number, 0 or more/);
    }
    expect(c.readWeekRaw).not.toHaveBeenCalled();
    expect((await h.read({ roomId: '!r:s', week: '2026-11-09', offset: null })).status).toBe(200);
    expect(c.readWeekRaw).toHaveBeenCalledWith('2026-11-09', { offset: 0 });
  });

  it("the More projects line carries the journal's next_offset", async () => {
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, projects_total: 20, next_offset: 6, more_projects: true }) })) } });
    const r = await h.read({ roomId: '!r:s' });
    const lines = formatTimelineReadAck(r.body).split('\n');
    expect(lines.at(-1)).toBe('More projects: call timeline_week_read again with week: "2026-11-09", offset: 6.');
    expect(lines[0]).toMatch(/^quiet \(1 of 2\): /);
    expect(formatTimelineReadAck({ week: pagedWeek({ next_offset: null }) }).split('\n').at(-1)).toBe('That is every project that moved this week.');
  });

  it('an older journal that says more projects moved but gives no next_offset is not called complete', () => {
    const lines = formatTimelineReadAck({ week: rawWeek({ current: false, more_projects: true }) }).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('More projects moved this week than this read shows; the journal cannot page them — deploy the journal update.');
  });

  it('an oversized body is refused: the journal has no paging', async () => {
    const big = rawWeek({ projects: [{ id: 'p1', num: 1, title: 'Promo launch', milestones: [{ text: 'x'.repeat(60000) }] }] });
    expect(JSON.stringify(big).length).toBeGreaterThan(60000);
    const { h } = fixture({ client: { readWeekRaw: vi.fn(async () => ({ status: 200, data: big })) } });
    const r = await h.read({ roomId: '!r:s' });
    expect(r).toEqual({ status: 502, body: { error: "the journal's week read is too large for this tool — deploy the journal update" } });
  });

  it('the text stays under 45,000 characters, the quiet list counted in', async () => {
    const week = pagedWeek({ projects: [{ id: 'p1', title: 'x'.repeat(30000) }] });
    const rows = Array.from({ length: 3 }, (_, i) => ({ project: { id: `p${i}`, num: i + 1, title: 'A' }, last_moved_at: 5, note: 'n'.repeat(5000), weekly: false }));
    const ok = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }) } }).h.read({ roomId: '!r:s' });
    expect(ok.status).toBe(200);
    expect(formatTimelineReadAck(ok.body).length).toBeLessThan(45000);
    const over = await fixture({ client: { readWeekRaw: async () => ({ status: 200, data: week }), wentQuiet: async () => ({ status: 200, data: { total: 3, rows } }) } }).h.read({ roomId: '!r:s' });
    expect(over.status).toBe(502);
    expect(over.body.error).toMatch(/too large for this tool/);
  });

  it('a past week has no quiet line', async () => {
    const { h, c } = fixture({ client: { readWeekRaw: vi.fn(async (week) => ({ status: 200, data: pagedWeek({ week, current: false }) })) } });
    const r = await h.read({ roomId: '!r:s', week: '2026-11-02' });
    expect(c.wentQuiet).not.toHaveBeenCalled();
    expect(formatTimelineReadAck(r.body)).toBe(`week: ${JSON.stringify(pagedWeek({ week: '2026-11-02', current: false }))}\nThat is every project that moved this week.`);
  });
});

describe('timeline_week_write', () => {
  it('posts the cleaned entries to the entries route with the Coordinator convo_id', async () => {
    const { h, c } = fixture();
    const r = await h.write(call({
      week: ' 2026-11-09 ',
      entries: [
        entry({ project: '#12', sentence: ' The thing went out. ', next: ' Then the rest. ', media_blob_id: ' blob1 ' }),
        entry({ project: ' prj_abc ' }),
        entry({ project: 7 }),
      ],
      final: true,
      notes: [{ project_id: '#9', note: ' Left at review. ' }],
    }));
    expect(c.writeWeekEntries).toHaveBeenCalledTimes(1);
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-09', {
      convo_id: 'c-coord',
      entries: [
        { project: 12, sentence: 'The thing went out.', next: 'Then the rest.', media_blob_id: 'blob1' },
        { project: 'prj_abc', sentence: 'The thing went out.' },
        { project: 7, sentence: 'The thing went out.' },
      ],
      final: true,
      notes: [{ project_id: 9, note: 'Left at review.' }],
    });
    expect(r).toEqual({ status: 201, body: { week: '2026-11-09', written: true, final: true, entries: 3 } });
  });

  it('reaches the journal at /timeline/weeks/<week>/entries', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url, init.body]); return { ok: true, status: 201, json: async () => ({ week: '2026-11-09', written: true, final: false, entries: 1 }) }; };
    const { h } = fixture({ client: createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }) });
    const r = await h.write(call({ week: '2026-11-09', entries: [entry({ project: '#12' })] }));
    expect(r.status).toBe(201);
    expect(calls).toHaveLength(1);
    expect(calls[0].slice(0, 2)).toEqual(['POST', 'https://journal.example.com/timeline/weeks/2026-11-09/entries']);
    expect(JSON.parse(calls[0][2])).toEqual({ convo_id: 'c-coord', entries: [{ project: 12, sentence: 'The thing went out.' }], final: false, notes: [] });
  });

  it('defaults: final false, no notes, optional entry fields omitted, an empty list for a quiet week', async () => {
    const { h, c } = fixture();
    await h.write({ roomId: '!r:s', week: '2026-11-02', entries: [] });
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-02', { convo_id: 'c-coord', entries: [], final: false, notes: [] });
    await h.write(call({ entries: [entry({ next: '  ', media_blob_id: '' })] }));
    expect(c.writeWeekEntries.mock.calls[1][1].entries[0]).toEqual({ project: 3, sentence: 'The thing went out.' });
  });

  it('lede, stories and the old story fields passed anyway are not forwarded', async () => {
    const { h, c } = fixture();
    const r = await h.write(call({
      lede: 'A good week.',
      stories: [{ title: 'Shipped it', sentence: 'The thing went out.', project_ids: [3] }],
      entries: [entry({ title: 'Shipped it', project_ids: [3, 4], item_ids: [5] })],
    }));
    expect(r.status).toBe(201);
    expect(c.writeWeekEntries).toHaveBeenCalledWith('2026-11-02', { convo_id: 'c-coord', entries: [{ project: 3, sentence: 'The thing went out.' }], final: false, notes: [] });
  });

  it('stories without entries is refused locally: the old shape is never sent', async () => {
    const { h, c } = fixture();
    const r = await h.write({ roomId: '!r:s', week: '2026-11-02', lede: 'A good week.', stories: [] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/entries is required/);
    expect(c.writeWeekEntries).not.toHaveBeenCalled();
  });

  it('nine entries, a missing sentence and a bad project ref each fail locally, naming the entry', async () => {
    const nine = Array.from({ length: 9 }, (_, i) => entry({ project: i + 1 }));
    const cases = [
      [{ entries: nine }, 'too many entries: at most 8 (got 9) — one entry per project, for the projects that mattered most'],
      [{ entries: [entry(), { project: 4 }] }, 'entry 2 sentence is required'],
      [{ entries: [entry(), entry({ project: 4 }), entry({ project: '#abc' })] }, 'entry 3 has a bad project "#abc" — use the id, or the number such as 12 or #12'],
    ];
    for (const [over, sentence] of cases) {
      const { h, c } = fixture();
      const r = await h.write(call(over));
      expect(r).toEqual({ status: 400, body: { error: sentence } });
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
  });

  it('two entries for the same project fail locally with the one-entry-per-project sentence', async () => {
    for (const [a, b, shown] of [[12, '#12', '#12'], ['12', 12, '#12'], ['prj_abc', ' prj_abc ', 'prj_abc']]) {
      const { h, c } = fixture();
      const r = await h.write(call({ entries: [entry({ project: a }), entry({ project: 5 }), entry({ project: b })] }));
      expect(r).toEqual({ status: 400, body: { error: `project ${shown} has two entries — one entry per project` } });
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
  });

  it('enforces every limit before the journal', async () => {
    const L = TIMELINE_LIMITS;
    const refs = (n) => Array.from({ length: n }, (_, i) => i + 1);
    const cases = [
      [{ week: undefined }, /week must be/],
      [{ week: '2026-11-03' }, /not a Monday/],
      [{ entries: undefined }, /entries is required/],
      [{ entries: 'x' }, /entries is required/],
      [{ entries: refs(L.entriesMax + 1).map((n) => entry({ project: n })) }, /too many entries/],
      [{ entries: ['x'] }, /entry 1 must be an object/],
      [{ entries: [[entry()]] }, /entry 1 must be an object/],
      [{ entries: [entry({ sentence: '  ' })] }, /entry 1 sentence is required/],
      [{ entries: [entry({ sentence: 5 })] }, /entry 1 sentence must be text/],
      [{ entries: [entry({ sentence: 'x'.repeat(L.sentenceMax + 1) })] }, /entry 1 sentence is too long: at most 300/],
      [{ entries: [entry({ next: 'x'.repeat(L.nextMax + 1) })] }, /entry 1 next is too long/],
      [{ entries: [entry({ project: undefined })] }, /entry 1 project is required/],
      [{ entries: [entry({ project: null })] }, /entry 1 project is required/],
      [{ entries: [entry({ project: 0 })] }, /entry 1 has a bad project/],
      [{ entries: [entry({ project: -3 })] }, /bad project/],
      [{ entries: [entry({ project: 1.5 })] }, /bad project/],
      [{ entries: [entry({ project: '  ' })] }, /bad project/],
      [{ entries: [entry({ project: '#0' })] }, /bad project/],
      [{ entries: [entry({ project: {} })] }, /bad project/],
      [{ entries: [entry({ project: [3] })] }, /bad project/],
      [{ entries: [entry({ media_blob_id: 7 })] }, /entry 1 media_blob_id/],
      [{ entries: [entry({ media_blob_id: 'b'.repeat(L.blobIdMax + 1) })] }, /entry 1 media_blob_id is too long: at most 128/],
      [{ notes: refs(L.notesMax + 1).map((n) => ({ project_id: n, note: 'x' })) }, /too many notes/],
      [{ notes: [{ project_id: 1, note: '' }] }, /note 1 note is required/],
      [{ notes: [{ project_id: 1, note: 'x'.repeat(L.noteMax + 1) }] }, /note is too long/],
      [{ notes: [{ project_id: '', note: 'x' }] }, /bad project_id/],
      [{ notes: 'nope' }, /notes must be a list/],
      [{ final: 'yes' }, /final must be true or false/],
    ];
    for (const [over, re] of cases) {
      const { h, c } = fixture();
      const r = await h.write(call(over));
      expect(r.status, JSON.stringify(over).slice(0, 80)).toBe(400);
      expect(r.body.error, JSON.stringify(over).slice(0, 80)).toMatch(re);
      expect(c.writeWeekEntries).not.toHaveBeenCalled();
    }
    // The limits themselves are accepted.
    const edge = fixture();
    const r = await edge.h.write(call({
      entries: refs(L.entriesMax).map((n) => entry({ project: n, sentence: 'x'.repeat(L.sentenceMax), next: 'x'.repeat(L.nextMax), media_blob_id: 'b'.repeat(L.blobIdMax) })),
      notes: refs(L.notesMax).map((n) => ({ project_id: n, note: 'x'.repeat(L.noteMax) })),
    }));
    expect(r.status).toBe(201);
    expect(L).toEqual({ entriesMax: 8, sentenceMax: 300, nextMax: 300, notesMax: 50, noteMax: 300, blobIdMax: 128 });
  });

  it('an old journal: 404, nothing written', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([init.method, url]); return { ok: false, status: 404, json: async () => { throw new Error('not json'); } }; };
    const { h } = fixture({ client: createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }) });
    const r = await h.write(call({ week: '2026-11-09' }));
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/^the journal predates per-project weeks — deploy the journal update before writing/);
    // One POST to the new path; the older whole-week path is never tried.
    expect(calls).toEqual([['POST', 'https://journal.example.com/timeline/weeks/2026-11-09/entries']]);
    expect(createTimelineClient({ baseUrl: 'https://journal.example.com', token: 'tok', fetchImpl }).writeWeek).toBeUndefined();
  });

  it('maps each journal error to a sentence an agent can act on, and unreachable to 502', async () => {
    const cases = [
      [{ status: 403, data: { error: 'forbidden', detail: 'not_coordinator' } }, 403, /does not list this conversation as the Coordinator/],
      [{ status: 403, data: { error: 'forbidden' } }, 403, /only the Coordinator agent/],
      [{ status: 409, data: { error: 'conflict', detail: 'week_final' } }, 409, /^that week is frozen; pass final: true to rewrite it on purpose$/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_not_ended' } }, 400, /only after it ends \(Monday 00:00/],
      [{ status: 400, data: { error: 'bad_request', detail: 'week_out_of_range' } }, 400, /outside the range/],
      [{ status: 400, data: { error: 'bad_request', detail: 'bad_week' } }, 400, /Monday of the week/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_project', ref: 42 } }, 400, /project 42 is not one of the user's projects, or is private — a week never names private work/],
      [{ status: 400, data: { error: 'bad_request', detail: 'unknown_blob', ref: 'b1' } }, 400, /media_blob_id b1 is not a picture or video/],
      [{ status: 400, data: { error: 'bad_request', detail: 'duplicate_project', ref: 12 } }, 400, /^project 12 has two entries — one entry per project$/],
      [{ status: 400, data: { error: 'bad_request', detail: 'duplicate_project' } }, 400, /^project \(unnamed\) has two entries — one entry per project$/],
      [{ status: 400, data: { error: 'bad_request' } }, 400, /rejected the call — check the week and the entry limits \(8 entries, one per project, sentences to 300 characters\)/],
      [{ status: 404, data: { error: 'HTTP 404' } }, 404, /^the journal predates per-project weeks — deploy the journal update before writing/],
      [{ status: 404, data: { error: 'not_found' } }, 404, /if the journal is up to date, it does not know this conversation on this box/],
      [{ status: 500, data: { error: 'HTTP 500' } }, 500, /^HTTP 500$/],
    ];
    for (const [res, status, re] of cases) {
      const r = await fixture({ client: { writeWeekEntries: async () => res } }).h.write(call());
      expect(r.status, JSON.stringify(res)).toBe(status);
      expect(r.body.error, JSON.stringify(res)).toMatch(re);
      expect(r.body.error).not.toMatch(/\bbad_request\b|\bforbidden\b|\bweek_final\b|\bunknown_project\b|\bduplicate_project\b|\bstor(y|ies)\b/);
    }
    const down = await fixture({ client: { writeWeekEntries: async () => ({ status: 0, data: { error: 'journal unreachable' } }) } }).h.write(call());
    expect(down).toEqual({ status: 502, body: { error: 'journal unreachable' } });
    expect(formatJournalTimelineError(null)).toBe('unknown error');
  });
});

describe('helpers', () => {
  it('normalizeRef turns #12 and "12" into 12 and keeps ids', () => {
    expect(normalizeRef('#12')).toBe(12);
    expect(normalizeRef('12')).toBe(12);
    expect(normalizeRef(' prj_1 ')).toBe('prj_1');
    expect(normalizeRef(12)).toBe(12);
    for (const bad of [0, -1, 1.2, '', '#', '#0', null, undefined, {}, '#x']) expect(normalizeRef(bad), String(bad)).toBeNull();
  });
  it('validateWeekKey accepts a Monday only', () => {
    expect(validateWeekKey('2026-11-09')).toEqual({ ok: true, value: '2026-11-09' });
    expect(validateWeekKey('2026-11-08').ok).toBe(false);
    expect(validateTimelineWrite({ week: '2026-11-09', entries: [] }).ok).toBe(true);
  });
  it('acks', () => {
    expect(formatTimelineWriteAck({ week: '2026-11-09', final: false, entries: 4 })).toBe('Week 2026-11-09 written (4 projects).');
    expect(formatTimelineWriteAck({ week: '2026-11-02', final: true, entries: 1 })).toBe('Week 2026-11-02 written (1 project, frozen).');
    expect(formatTimelineWriteAck({ week: '2026-11-02', final: false, entries: 0 })).toBe('Week 2026-11-02 written (0 projects).');
    expect(formatTimelineReadAck({ week: { week: 'w' } })).toBe('week: {"week":"w"}\nThat is every project that moved this week.');
    expect(formatTimelineReadAck({ week: { week: 'w', next_offset: 8 }, quiet: [], quiet_total: 0 })).toBe('quiet (0 of 0): []\nweek: {"week":"w","next_offset":8}\nMore projects: call timeline_week_read again with week: "w", offset: 8.');
  });
});

describe('createTimelineClient', () => {
  function fakeFetch(status = 200, body = {}) {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => { calls.push({ url, init }); return { ok: status < 300, status, json: async () => body }; });
    return { fetchImpl, calls };
  }
  it('hits the four routes with bearer auth', async () => {
    const { fetchImpl, calls } = fakeFetch(200, { ok: 1 });
    const c = createTimelineClient({ baseUrl: 'https://j/', token: 'tok', fetchImpl });
    await c.readWeekRaw('2026-11-09');
    await c.listWeeks({ limit: 1 });
    await c.listWeeks();
    await c.wentQuiet();
    await c.writeWeekEntries('2026-11-09', { convo_id: 'c1', entries: [] });
    expect(calls.map((x) => [x.init.method, x.url])).toEqual([
      ['GET', 'https://j/timeline/weeks/2026-11-09?raw=1'],
      ['GET', 'https://j/timeline/weeks?limit=1'],
      ['GET', 'https://j/timeline/weeks'],
      ['GET', 'https://j/timeline/quiet?raw=1'],
      ['POST', 'https://j/timeline/weeks/2026-11-09/entries'],
    ]);
    expect(calls[0].init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[4].init.body)).toEqual({ convo_id: 'c1', entries: [] });
    expect(calls[4].init.headers['Content-Type']).toBe('application/json');
  });
  it('returns error statuses and never throws; no base means unreachable', async () => {
    const { fetchImpl } = fakeFetch(409, { error: 'conflict', detail: 'week_final' });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl }).writeWeekEntries('2026-11-09', {})).toEqual({ status: 409, data: { error: 'conflict', detail: 'week_final' } });
    expect(await createTimelineClient({ baseUrl: 'https://j', token: 't', fetchImpl: async () => { throw new Error('boom'); } }).wentQuiet()).toEqual({ status: 0, data: { error: 'journal unreachable' } });
    expect((await createTimelineClient({}).wentQuiet()).status).toBe(0);
  });
});
