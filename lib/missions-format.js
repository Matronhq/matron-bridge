// Compact renderings of the journal's mission JSON for the mission_* tools.
// Pure and defensive (a journal a version ahead must degrade to a duller
// line, never throw inside a handler). One line per fact, never raw JSON.
const str = (v) => (typeof v === 'string' ? v : '');
const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isoTime = (ms) => { const d = new Date(Number(ms)); return Number.isNaN(d.getTime()) ? 'unknown time' : d.toISOString(); };

// The status paragraph (spec 2026-09-28 missions dashboard): when and by
// whom, so the Coordinator can tell a status newer than the last milestone.
function statusLine(m) {
  const s = str(m?.status).trim();
  if (!s) return null;
  const by = m.status_by === 'user' ? ', by the user' : (m.status_by === 'agent' ? ', by an agent' : '');
  return `Status (${isoTime(m.status_updated_at)}${by}): ${s}`;
}

export function missionLine(m) {
  if (!m || typeof m !== 'object') return '(unknown mission)';
  const state = m.state === 'closed' ? `closed${m.closed_by ? ` by ${m.closed_by}` : ''}` : (str(m.state) || 'open');
  const open = n(m.open_items); const need = n(m.needs_you);
  const openText = `${open} open item${open === 1 ? '' : 's'}${need > 0 ? ` (${need} need you)` : ''}`;
  const id = str(m.id);
  return `#${m.num ?? '?'} ${str(m.title) || '(untitled)'} — ${state}, ${openText}, ${n(m.conversations)} conversation${n(m.conversations) === 1 ? '' : 's'}, ${n(m.milestones)} milestone${n(m.milestones) === 1 ? '' : 's'}${id ? ` (id ${id})` : ''}`;
}

export function formatStartAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission started.';
  const id = str(m.id) ? ` (id ${m.id})` : '';
  return data.existing
    ? `Already in mission #${m.num ?? '?'} "${str(m.title)}" — nothing changed${id}`
    : `Started mission #${m.num ?? '?'} "${str(m.title)}"${id}`;
}

export function formatCreateAck(data) {
  const m = data?.mission;
  if (!m) return 'Mission created (unassigned).';
  return `Mission #${m.num ?? '?'} "${str(m.title)}" created (unassigned)`;
}

export function formatMilestoneAck(data) {
  const l = data?.milestone; const m = data?.mission;
  return `Milestone #${l?.num ?? '?'} posted to mission #${m?.num ?? '?'} "${str(m?.title)}"`;
}

export function formatStatusAck(data) {
  const m = data?.mission;
  if (!m) return 'Status set.';
  return `Status set on mission #${m.num ?? '?'} "${str(m.title)}"`;
}

export function formatMissionDetail(data) {
  const lines = [missionLine(data?.mission)];
  const body = str(data?.mission?.body).trim();
  if (body) lines.push(body);
  const status = statusLine(data?.mission);
  if (status) lines.push(status);
  if (data?.mission?.state === 'closed' && str(data.mission.close_summary).trim()) lines.push(`Closed: ${data.mission.close_summary.trim()}`);
  lines.push('');
  // Rendered in the order the journal returns them: GET /missions/:id is
  // newest first by contract, and this renderer never re-sorts.
  const ms = Array.isArray(data?.milestones) ? data.milestones : [];
  lines.push('Milestones (newest first):');
  if (!ms.length) lines.push('- (none yet)');
  for (const l of ms) lines.push(`- #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)} in ${str(l.convo_id) || '?'}`);
  const items = Array.isArray(data?.items) ? data.items : [];
  lines.push('Open items:');
  if (!items.length) lines.push('- (none)');
  for (const i of items) lines.push(`- #${i.num ?? '?'} ${str(i.title)}${i.awaiting ? ` — awaiting ${i.awaiting}` : ''}`);
  const convos = Array.isArray(data?.conversations) ? data.conversations : [];
  lines.push('Conversations:');
  if (!convos.length) lines.push('- (none)');
  for (const c of convos) lines.push(`- ${str(c.id)} ${str(c.title)} (${str(c.box) || 'unknown box'}, ${str(c.state) || 'unknown'})`);
  return lines.join('\n');
}

const itemList = (items) => (Array.isArray(items) ? items : []).map((i) => `#${i.num ?? '?'} ${str(i.title)}`).join(', ');

export function formatBlocked(data) {
  switch (data?.blocked_by) {
    case 'no_mission': return 'this conversation has no mission — call mission_start(title, body) first, then post the milestone again';
    case 'closed': return 'mission is closed — no more milestones, joins or status changes';
    case 'user_items': return `blocked by items awaiting the user: ${itemList(data.items)} — only the user can clear those`;
    case 'agent_items': return `blocked by open items: ${itemList(data.items)} — close each with a real resolution (item_close), or item_move it to the mission it belongs to`;
    case 'other_mission': return 'this conversation already belongs to another mission';
    default: return str(data?.error) || 'conflict';
  }
}

// The journal's non-409 errors are machine words — `not_found`,
// `bad_request` — and passthrough hands them to the model verbatim, which
// tells it nothing it can act on ("mission_get failed: not_found"). Map the
// ones it can actually hit to a sentence that names the next move. Anything
// else, including the bridge's own sentences, passes through unchanged.
export function formatJournalError(op, data) {
  switch (str(data?.error)) {
    case 'not_found': return "no mission with that number, or it isn't visible to this session";
    case 'bad_request':
      // A status-only PATCH to a journal from before mission status is a
      // 400 too (it sees no fields it knows) — say so, or the model retries
      // a status that was never the problem.
      if (op === 'status') return 'the journal rejected the status — it must be 1–600 characters after trimming, with no control characters other than newlines and tabs (a journal older than mission status rejects every status: deploy the journal update)';
      return 'the journal rejected it — check the number and the limits (title ≤ 200 characters, body ≤ 32 KiB; a mission already holding 200 conversations refuses joins)';
    // A colleague's shared mission is readable but not writable (journal
    // missions-http: getSharedMission → 403).
    case 'forbidden': return "that mission is shared with you by another user — only its owner's sessions can change it";
    default: return str(data?.error);
  }
}

// mission_list: GET /missions rows in the journal's order, each with its
// status and last milestone — what the Coordinator needs to decide which
// missions to refresh.
export function formatMissionList(data) {
  const ms = Array.isArray(data?.missions) ? data.missions : [];
  if (!ms.length) return 'No missions.';
  const lines = [];
  for (const m of ms) {
    lines.push(missionLine(m));
    lines.push(`  ${statusLine(m) || 'Status: (none yet)'}`);
    const l = m?.last_milestone;
    lines.push(l && typeof l === 'object'
      ? `  Last milestone: #${l.num ?? '?'} [${str(l.kind) || 'progress'}] ${str(l.title)} — ${isoTime(l.created_at)}`
      : '  Last milestone: (none yet)');
  }
  return lines.join('\n');
}
