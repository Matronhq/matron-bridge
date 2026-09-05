import path from 'path';

// The LLM rename in maybeUpdatePinnedSummary only fires from the 5th chat
// history entry (and not at all without a GEMINI_API_KEY), so short convos
// kept their workdir seed forever. Fall back to the same name Claude Code
// itself gives a session — the first user message, as shown by
// `claude --resume` and the bridge's own /sessions listing (see
// lib/session-summary.js's extraction, whose cleaning rules this mirrors).
// One-shot per session: the first user message never changes, so there is
// nothing to re-derive. Same title format as the LLM rename (the message
// text alone) so journals look uniform whichever path named them.
const FALLBACK_TITLE_MAX = 60;

// The seed title seedJournalTitle below would give this workdir — the only
// title the fallback is allowed to replace. Anything else (a resume summary,
// media naming, an earlier fallback surviving a bridge restart) already beat
// the seed and must not be clobbered.
//
// No server-label prefix: which box owns a conversation is data
// (conversations.agent_device_id) that clients render as a chip, not text
// baked into the title.
function seedTitleFor(workdir) {
  const base = workdir ? path.basename(path.resolve(workdir)) : '';
  return base || 'session';
}

// Every form that has ever been a seed for this workdir. A session that
// started before the label was dropped persisted `LABEL: basename`, and one
// older still persisted the bare basename; both are seeds and both stay
// replaceable by the first-user-message fallback.
function legacySeedTitles(workdir, serverLabel) {
  const base = seedTitleFor(workdir);
  return serverLabel ? [base, `${serverLabel}: ${base}`] : [base];
}

// Two characters of the session id, prefixed to every EARNED title (the
// first-message fallback below, the Gemini rename, resume titles). Which box
// owns a conversation is data clients render as a chip or subtitle, but
// nothing else tells two sessions on the SAME box apart — the short went out
// with the server label in #205 and was missed immediately. Seed titles stay
// bare: at seed time the native session id often doesn't exist yet, and the
// seed-detection in legacySeedTitles stays a closed set of label-era forms.
export function withSessionShort(id, title, marker = '') {
  const short = typeof id === 'string' ? id.trim().slice(0, 2) : '';
  const prefix = marker ? `${marker} ` : '';
  return short ? `${prefix}[${short}] ${title}` : `${prefix}${title}`;
}

// Marks a session another agent started (journal-rpc `start`), ahead of the
// short: `🐣 [ab] Title`. The room-title ↔️ (lib/agent-chat.js) is its twin.
export const SPAWN_TITLE_MARKER = '🐣';

// Every marker that may lead a title AHEAD of the short: ↔️ / 🔗 for an
// agent-chat room (the latter is what rooms minted before #228 still carry —
// titles are only rewritten on rename, so both must parse indefinitely) and
// 🐣 for a spawned session.
const TITLE_MARKERS = ['↔️ ', '🔗 ', `${SPAWN_TITLE_MARKER} `];

// withSessionShort's inverse: the short read back OUT of a title, or '' when
// the title never earned one. Used to tag the PEER side of an agent-chat
// room title (lib/agent-chat.js) — the peer's own bridge baked its short into
// the conversation title, and that published title is the only place this
// bridge can learn it.
//
// The accepted shape is the same closed set the apps parse (MatronShared
// SessionTag.splitTitle): exactly two alphanumerics in brackets, a single
// space, and a non-empty title after it. Bracketed text that misses any of
// those is ordinary title text and yields nothing, so `[WIP] ship it` is
// never mistaken for a short. Markers are read through, not stripped from
// the caller's view: the short sits BEHIND them.
export function sessionShortFromTitle(raw) {
  if (typeof raw !== 'string') return '';
  const marker = TITLE_MARKERS.find((m) => raw.startsWith(m));
  if (marker) return sessionShortFromTitle(raw.slice(marker.length));
  return /^\[([\p{L}\p{N}]{2})\] .+$/u.exec(raw)?.[1] || '';
}

// The marker every EARNED title of this session must carry. Spawned
// sessions set `spawnedByAgent` at spawn; after a bridge restart that flag
// is gone, so fall back to whether the CURRENT title already carries the
// marker (`_journalTitleHint` tracks every publish and rides the persisted
// session record) — a rename must never silently drop the 🐣.
export function titleMarkerFor(session) {
  if (session?.spawnedByAgent) return SPAWN_TITLE_MARKER;
  const hint = session?._journalTitleHint;
  return typeof hint === 'string' && hint.startsWith(`${SPAWN_TITLE_MARKER} `)
    ? SPAWN_TITLE_MARKER
    : '';
}

// Shared cleaning for anything that becomes a title: tag-strip, then drop
// stray angle brackets outright: a single-pass strip can reassemble or pass
// through `<script` fragments (CodeQL
// js/incomplete-multi-character-sanitization), and a title has no
// legitimate need for < or >.
function cleanTitleText(text) {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function applyFallbackTitle(session, { serverLabel, updateRoomName, workdir }) {
  if (session._fallbackTitleApplied) return false;
  const hint = session._journalTitleHint;
  // Any historical seed form is still just a seed, still fair game to
  // replace — including the labeled form written before the prefix was
  // dropped.
  if (hint !== undefined && !legacySeedTitles(workdir, serverLabel).includes(hint)) return false;
  // A spawned session's first user message is the composed opening turn —
  // boilerplate ("[spawned session] You were started by…") that made every
  // spawned chat read identically. Name it from the approved task instead,
  // which is what the conversation is actually about.
  const spawnTask = typeof session.spawnTask === 'string' ? [{ role: 'user', text: session.spawnTask }] : null;
  const history = spawnTask ?? (Array.isArray(session.chatHistory) ? session.chatHistory : []);
  // First user message whose text survives cleaning — a tag-only opener
  // (IDE context pastes) must not block naming forever.
  for (const m of history) {
    if (m?.role !== 'user' || typeof m.text !== 'string') continue;
    const clean = cleanTitleText(m.text);
    if (!clean) continue;
    const text = clean.length > FALLBACK_TITLE_MAX ? `${clean.slice(0, FALLBACK_TITLE_MAX)}…` : clean;
    session._fallbackTitleApplied = true;
    // By first flush the agent has emitted its session id; the roomId (the
    // journal convo id, a bare UUID) is the never-blank fallback.
    updateRoomName(session.roomId, withSessionShort(session.claudeSessionId || session.roomId, text, titleMarkerFor(session)));
    return true;
  }
  return false; // no usable user turn yet — stay armed for the next flush
}

// Parses the Gemini title-pass response. ROSTER is the 2-3 sentence rolling
// conversation summary published to the journal (roster targeting metadata) —
// distinct from the bullet-list pinned summary the bridge keeps locally.
// TITLE/SUMMARY/NEW are single-line; ROSTER captures multiple lines, stopping
// at the next line that opens with one of THIS parser's own format keys, or at
// end-of-text — which is why the prompt must keep ROSTER as its LAST format
// line (a field after it would be swallowed).
//
// The stop set is the known keys and nothing else. A generic `\n[A-Z]+:`
// delimiter also fires on ordinary prose — a roster sentence beginning `API:`
// or `TODO:` truncated the summary there and dropped everything after it.
export function parseTitlePassResponse(text) {
  const t = typeof text === 'string' ? text : '';
  const title = t.match(/TITLE:\s*(.+)/i)?.[1]?.trim() || null;
  const summary = t.match(/SUMMARY:\s*(.+)/i)?.[1]?.trim() || null;
  const added = t.match(/NEW:\s*(.+)/i)?.[1]?.trim() || null;
  const roster = t.match(/ROSTER:\s*([\s\S]*?)(?:\n(?:TITLE|SUMMARY|NEW|ROSTER):|$)/)?.[1]?.trim() || null;
  return { title, summary, added, roster };
}

// Seed a journal convo title from the session's workdir (basename), unless a
// live title hint already won. Fails open — a title is cosmetic.
//
// `incomingHint` carries the title from this convo's PRIOR life across a
// restart/resume (the good Gemini summary lived on the old session object).
// When present it is adopted onto the fresh session SILENTLY — no upsert —
// because that title already exists server-side. Publishing the workdir
// basename here instead would clobber it via the journal's COALESCE upsert
// (the title-revert bug: a respawn re-seeded the bare repo name over the
// good title). Note `undefined` means "no prior title"; '' is a real,
// deliberately-chosen title and is adopted like any other.
//
// `persistedHint` is the same idea across a full BRIDGE restart, where no
// live session object survives to carry incomingHint: the last published
// title, read back from the persisted session record (journalUpsertConvo
// writes it there on every title change). Only adopted when reattaching —
// on a brand-new convo the server has no title yet, so a stale hint from
// the room's prior convo must not suppress the seed. Without this, a
// resumed session's first assistant flush saw no hint, re-applied the
// first-user-message fallback title, and clobbered the earned Gemini title.
export async function seedJournalTitle(session, { workdir, incomingHint, persistedHint, reattaching = false, upsertConvo, warn = () => {} }) {
  try {
    if (incomingHint !== undefined) {
      session._journalTitleHint = incomingHint;
      return false;
    }
    if (session._journalTitleHint !== undefined) return false;
    // Reattaching to an existing conversation (a journalConvoId was supplied):
    // it already exists server-side with whatever title it earned, so seeding
    // the workdir basename could only clobber it. Only a brand-new convo seeds.
    if (reattaching) {
      if (persistedHint !== undefined) session._journalTitleHint = persistedHint;
      return false;
    }
    upsertConvo(session, { title: seedTitleFor(workdir) });
    return true;
  } catch (e) {
    warn(`seedJournalTitle failed: ${e?.message || e}`);
    return false;
  }
}
