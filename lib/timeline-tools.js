// Loopback handlers behind the timeline_week_read / timeline_week_write MCP
// tools. The Coordinator reads one week of the user's work (every project that
// moved, what is already written for the week, and for the current week the
// Went quiet list) and writes the week for Projects: one entry per project that
// mattered.
// Same {status, body} contract and Coordinator gate as lib/briefings-tools.js:
// the journal is the real gate (the Coordinator only, naming its own
// conversation, and it refuses private work); this layer refuses a
// non-Coordinator first with the clearer sentence and validates the call
// against the journal's limits so a bad call never costs a round trip.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = 'only the Coordinator may read or write the timeline — this conversation is not the Coordinator';

// The journal's limits, mirrored.
export const TIMELINE_LIMITS = Object.freeze({
  entriesMax: 8,
  sentenceMax: 300,
  nextMax: 300,
  notesMax: 50,
  noteMax: 300,
  blobIdMax: 128,
});
const L = TIMELINE_LIMITS;

const bad = (error) => ({ status: 400, body: { error } });
const WEEK_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// A week is named by its Monday, YYYY-MM-DD.
export function validateWeekKey(week) {
  const m = typeof week === 'string' ? week.trim().match(WEEK_RE) : null;
  if (!m) return { ok: false, err: bad('week must be the Monday of the week as YYYY-MM-DD') };
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const real = d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
  if (!real) return { ok: false, err: bad(`week ${week.trim()} is not a real date — pass the Monday of the week as YYYY-MM-DD`) };
  if (d.getUTCDay() !== 1) return { ok: false, err: bad(`week ${week.trim()} is not a Monday — a week is named by its Monday, as YYYY-MM-DD`) };
  return { ok: true, value: week.trim() };
}

// A project reference: the id, or the number (12 or "#12").
export function normalizeRef(ref) {
  if (typeof ref === 'number') return Number.isSafeInteger(ref) && ref > 0 ? ref : null;
  if (typeof ref !== 'string') return null;
  const s = ref.trim();
  if (!s) return null;
  const n = s.match(/^#?(\d+)$/);
  if (n) {
    const v = Number(n[1]);
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }
  return s.startsWith('#') ? null : s;
}

function text(value, what, { min = 0, max }) {
  if (value === undefined || value === null) return min > 0 ? { err: `${what} is required` } : { value: '' };
  if (typeof value !== 'string') return { err: `${what} must be text` };
  const t = value.trim();
  if (t.length < min) return { err: `${what} is required` };
  if (t.length > max) return { err: `${what} is too long: at most ${max} characters (got ${t.length})` };
  return { value: t };
}

const duplicateProject = (ref) => `project ${ref || '(unnamed)'} has two entries — one entry per project`;

// A week is written as one entry per project. The tool schema refuses
// anything else in the call (a lede, stories, a title on an entry); for a
// caller that bypasses that schema it is ignored here, never forwarded.
export function validateTimelineWrite(data) {
  const wk = validateWeekKey(data?.week);
  if (!wk.ok) return wk;
  const fail = (msg) => ({ ok: false, err: bad(msg) });

  const rawEntries = data?.entries;
  if (!Array.isArray(rawEntries)) return fail(`entries is required: a list of up to ${L.entriesMax} entries, one per project (an empty list for a quiet week)`);
  if (rawEntries.length > L.entriesMax) return fail(`too many entries: at most ${L.entriesMax} (got ${rawEntries.length}) — one entry per project, for the projects that mattered most`);

  const entries = [];
  const seen = new Set();
  for (let i = 0; i < rawEntries.length; i++) {
    const e = rawEntries[i];
    const at = `entry ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) return fail(`${at} must be an object with project and sentence`);
    if (e.project === undefined || e.project === null) return fail(`${at} project is required: the project's id, or its number such as 12 or #12`);
    const project = normalizeRef(e.project);
    if (project === null) return fail(`${at} has a bad project ${JSON.stringify(e.project)} — use the id, or the number such as 12 or #12`);
    // Only the same reference twice is caught here; the journal also catches
    // an id and a number that name one project.
    const key = `${typeof project}:${project}`;
    if (seen.has(key)) return fail(duplicateProject(typeof project === 'number' ? `#${project}` : peerField(project, 80)));
    seen.add(key);
    const sentence = text(e.sentence, `${at} sentence`, { min: 1, max: L.sentenceMax });
    if (sentence.err) return fail(sentence.err);
    const next = text(e.next, `${at} next`, { max: L.nextMax });
    if (next.err) return fail(next.err);
    const out = { project, sentence: sentence.value };
    if (next.value) out.next = next.value;
    if (e.media_blob_id !== undefined && e.media_blob_id !== null && e.media_blob_id !== '') {
      if (typeof e.media_blob_id !== 'string' || !e.media_blob_id.trim()) return fail(`${at} media_blob_id must be a blob id from the week's media list`);
      const blob = e.media_blob_id.trim();
      if (blob.length > L.blobIdMax) return fail(`${at} media_blob_id is too long: at most ${L.blobIdMax} characters (got ${blob.length}) — use the blob id exactly as the week's media list gives it`);
      out.media_blob_id = blob;
    }
    entries.push(out);
  }

  const notes = [];
  if (data?.notes !== undefined && data?.notes !== null) {
    if (!Array.isArray(data.notes)) return fail('notes must be a list of { project_id, note }');
    if (data.notes.length > L.notesMax) return fail(`too many notes: at most ${L.notesMax} (got ${data.notes.length})`);
    for (let i = 0; i < data.notes.length; i++) {
      const n = data.notes[i];
      const at = `note ${i + 1}`;
      if (!n || typeof n !== 'object' || Array.isArray(n)) return fail(`${at} must be an object with project_id and note`);
      const ref = normalizeRef(n.project_id);
      if (ref === null) return fail(`${at} has a bad project_id ${JSON.stringify(n.project_id)} — use the id, or the number such as 12 or #12`);
      const note = text(n.note, `${at} note`, { min: 1, max: L.noteMax });
      if (note.err) return fail(note.err);
      notes.push({ project_id: ref, note: note.value });
    }
  }

  if (data?.final !== undefined && data?.final !== null && typeof data.final !== 'boolean') return fail('final must be true or false');
  return { ok: true, value: { week: wk.value, entries, final: data?.final === true, notes } };
}

// One sentence an agent can act on for each thing the journal can say.
// `status` matters only for a 404 whose body carries no code (a journal that
// predates the route). `read` picks the wording for the read tool. A write
// goes to the per-project route, which an older journal does not have: its 404
// stores nothing. A current journal also answers 404 when it does not know the
// Coordinator's conversation, and the two cannot be told apart from here.
export function formatJournalTimelineError(data, status = 0, read = false) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  const ref = data?.ref !== undefined && data?.ref !== null ? peerField(data.ref, 80) : '';
  if (detail === 'not_coordinator' || code === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: only the Coordinator agent may read or write the timeline';
  if (status === 404 || code === 'not_found') {
    return read
      ? 'the journal predates the timeline routes — deploy the journal update (Projects timeline) before using this tool'
      : 'the journal predates per-project weeks — deploy the journal update before writing (nothing was written; if the journal is up to date, it does not know this conversation on this box)';
  }
  if (code === 'conflict' && (detail === 'week_final' || !detail)) return 'that week is frozen; pass final: true to rewrite it on purpose';
  if (code === 'bad_request') {
    if (read && !detail) return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'bad_week') return 'the journal does not accept that week — pass the Monday of the week as YYYY-MM-DD';
    if (detail === 'week_out_of_range') return 'that week is outside the range the timeline covers (too old or in the future) — use a week from the timeline list';
    if (detail === 'week_not_ended') return 'a week can be frozen only after it ends (Monday 00:00 in the user\'s zone) — write the current week without final';
    if (detail === 'unknown_project') return `project ${ref || '(unnamed)'} is not one of the user's projects, or is private — a week never names private work`;
    if (detail === 'duplicate_project') return duplicateProject(ref);
    if (detail === 'unknown_blob') return `media_blob_id ${ref || '(unnamed)'} is not a picture or video from that week's work — pick one from the week's media list`;
    return 'the journal rejected the call — check the week and the entry limits (8 entries, one per project, sentences to 300 characters)';
  }
  if (code === 'journal unreachable') return 'journal unreachable';
  return peerField(code, 120) || 'unknown error';
}

// The Coordinator can take in about 49,000 characters of one tool result; a
// read longer than this is refused rather than cut off part-way.
export const TIMELINE_READ_MAX_CHARS = 45000;
const READ_TOO_LARGE = 'the journal\'s week read is too large for this tool — deploy the journal update';

// The read as text, shortest and most often missed part first: the Went quiet
// list (the first page of the current week only), then the page of the week,
// then whether there is another page to ask for.
export function formatTimelineReadAck(data) {
  const week = data?.week ?? {};
  const lines = [];
  if (Array.isArray(data?.quiet)) {
    const total = Number.isInteger(data.quiet_total) ? data.quiet_total : data.quiet.length;
    lines.push(`quiet (${data.quiet.length} of ${total}): ${JSON.stringify(data.quiet)}`);
  }
  lines.push(`week: ${JSON.stringify(week)}`);
  if (Number.isInteger(week.next_offset)) {
    lines.push(`More projects: call timeline_week_read again with week: ${JSON.stringify(week.week ?? '')}, offset: ${week.next_offset}.`);
  } else if (week.more_projects === true) {
    // A journal without paging: it cut the list and has no way to give the rest.
    lines.push('More projects moved this week than this read shows; the journal cannot page them — deploy the journal update.');
  } else {
    lines.push('That is every project that moved this week.');
  }
  return lines.join('\n');
}

export function formatTimelineWriteAck(data) {
  const week = typeof data?.week === 'string' ? data.week : '?';
  const n = Number.isInteger(data?.entries) ? data.entries : 0;
  return `Week ${week} written (${n} ${n === 1 ? 'project' : 'projects'}${data?.final === true ? ', frozen' : ''}).`;
}

// `isCoordinator(session, convoId)` decides the local refusal, as for the
// briefing tools: index.js passes one that also asks the journal's current
// role holder.
export function createTimelineHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true }) {
  // The shared session / Coordinator / conversation gate.
  function gate(data) {
    const roomId = data?.roomId;
    if (!roomId || typeof roomId !== 'string') return { err: bad('roomId is required') };
    const session = sessions.get(roomId);
    if (!session) return { err: { status: 404, body: { error: `no active session for chat ${roomId}` } } };
    const convoId = journalConvoIdFor(session);
    if (!isCoordinator(session, convoId)) return { err: { status: 403, body: { error: NOT_COORDINATOR } } };
    if (!convoId) return { err: { status: 409, body: { error: 'this session has no journal conversation yet' } } };
    return { convoId };
  }
  const failed = (r, read = false) => (r.status === 0
    ? { status: 502, body: { error: 'journal unreachable' } }
    : { status: r.status, body: { ...r.data, error: formatJournalTimelineError(r.data, r.status, read) } });

  return {
    async read(data) {
      const g = gate(data);
      if (g.err) return g.err;
      let offset = 0;
      if (data?.offset !== undefined && data?.offset !== null) {
        if (!Number.isSafeInteger(data.offset) || data.offset < 0) return bad('offset must be a whole number, 0 or more — pass the offset the last read gave, or leave it out for the first page');
        offset = data.offset;
      }
      let week;
      if (data?.week === undefined || data?.week === null || data?.week === '') {
        const list = await client.listWeeks({ limit: 1 });
        if (list.status === 0 || list.status >= 400) return failed(list, true);
        const first = Array.isArray(list.data?.weeks) ? list.data.weeks[0] : null;
        if (!first || typeof first.week !== 'string') return { status: 404, body: { error: 'the journal lists no weeks yet — pass a week (the Monday, YYYY-MM-DD)' } };
        week = first.week;
      } else {
        const v = validateWeekKey(data.week);
        if (!v.ok) return v.err;
        week = v.value;
      }
      const raw = await client.readWeekRaw(week, { offset });
      if (raw.status === 0 || raw.status >= 400) return failed(raw, true);
      // A phase-1 journal ignores ?raw=1 and answers with the apps' week detail.
      if (typeof raw.data?.current !== 'boolean' || !Array.isArray(raw.data?.projects)) return failed({ status: 404, data: {} }, true);
      const body = { week: raw.data };
      // The Went quiet list goes with the first page of the current week only.
      if (raw.data?.current === true && offset === 0) {
        const q = await client.wentQuiet();
        if (q.status === 0 || q.status >= 400) return failed(q, true);
        body.quiet = Array.isArray(q.data?.rows) ? q.data.rows : [];
        if (Number.isInteger(q.data?.total)) body.quiet_total = q.data.total;
      }
      // A journal without paging can answer with a week too long to read.
      if (formatTimelineReadAck(body).length >= TIMELINE_READ_MAX_CHARS) return { status: 502, body: { error: READ_TOO_LARGE } };
      return { status: 200, body };
    },

    async write(data) {
      const g = gate(data);
      if (g.err) return g.err;
      const v = validateTimelineWrite(data);
      if (!v.ok) return v.err;
      const { week, ...rest } = v.value;
      // The per-project route only: an older journal answers 404 and keeps the
      // week it has. Never fall back to the whole-week route, which would
      // replace that week.
      const r = await client.writeWeekEntries(week, { convo_id: g.convoId, ...rest });
      if (r.status === 0 || r.status >= 400) return failed(r);
      return { status: r.status, body: { ...r.data, week: r.data?.week ?? week, final: r.data?.final ?? rest.final, entries: Number.isInteger(r.data?.entries) ? r.data.entries : rest.entries.length } };
    },
  };
}
