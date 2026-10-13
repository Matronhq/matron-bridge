// Compact rendering of the journal's GET /search/all response (spec
// 2026-10-12 unified search) for the `search` MCP tool. Pure and defensive,
// like lib/missions-format.js: a journal a version ahead, or a chats row
// missing a field, degrades to a duller line, never throws.

const str = (v) => (typeof v === 'string' ? v : '');

// One tracker result, best match first. `why` is one of exact/words/
// stemmed/similar/some_words — the journal's own rank order, so the label
// is shown verbatim rather than re-worded.
function label(r) {
  const ref = r.kind === 'memory' ? `memory ${str(r.name)}` : `${str(r.kind) || 'result'} #${r.num ?? '?'}`;
  const meta = [str(r.state) || null, r.mission_num ? `mission #${r.mission_num}` : null].filter(Boolean).join(', ');
  const snippet = str(r.snippet).replace(/\s+/g, ' ').trim();
  return `[${str(r.why) || '?'}] ${ref}${meta ? ` (${meta})` : ''} ${str(r.title)}${snippet ? ` — ${snippet.slice(0, 160)}` : ''}`;
}

// One chats row (same shape as GET /search mode=chats). `top` and
// `mission_num` are both optional on the wire — a row with neither must
// still render a usable line, not throw.
function chatLine(c) {
  const mission = c?.mission_num ? `mission #${c.mission_num}, ` : '';
  const seq = Number.isInteger(c?.top?.seq) ? ` seq ${c.top.seq}` : '';
  return `- ${str(c?.title) || '(untitled)'} (${mission}${Number(c?.count) || 0} matches) convo ${str(c?.convo_id) || '?'}${seq}`;
}

export function formatSearchAll({ results = [], chats = [], semantic } = {}) {
  const rows = Array.isArray(results) ? results : [];
  const chatRows = Array.isArray(chats) ? chats : [];
  if (!rows.length && !chatRows.length) return 'No match. Describe it differently, or put an exact name or number in quotes.';
  const lines = rows.map(label);
  if (chatRows.length) {
    lines.push('', 'Chats:');
    for (const c of chatRows) lines.push(chatLine(c));
  }
  if (semantic === 'off') lines.push('', '(meaning-based matching is off on this journal; only word matches are shown)');
  if (semantic === 'indexing') lines.push('', '(meaning-based matching is still indexing; results may be incomplete)');
  return lines.join('\n');
}
