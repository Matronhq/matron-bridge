// Loopback handler behind the briefing_publish MCP tool (spec: matron-journal
// docs/superpowers/specs/2026-10-04-latest-briefing-design.md). The
// Coordinator publishes its sweep report and status updates as briefings;
// the apps show the latest at the top of Projects. The journal also writes
// the briefing into the Coordinator conversation as the agent's own
// message, so the ack tells the agent not to repeat it. Same {status, body}
// contract and Coordinator gate as lib/routines-tools.js: the journal is the
// real gate (the Coordinator only, naming its own conversation); this layer
// refuses a non-Coordinator first with the clearer sentence and validates
// the body so a bad call never costs a journal round trip.
import { peerField } from './peer-text.js';

const NOT_COORDINATOR = 'only the Coordinator may publish a briefing — this conversation is not the Coordinator';
// The journal's limit: the trimmed body, at most 32 KB of UTF-8.
export const BRIEFING_BODY_MAX = 32768;

const bad = (error) => ({ status: 400, body: { error } });

export function formatJournalBriefingsError(data) {
  const code = typeof data?.error === 'string' ? data.error : '';
  const detail = typeof data?.detail === 'string' ? data.detail : '';
  if (detail === 'not_coordinator' || code === 'not_coordinator') return 'the journal does not list this conversation as the Coordinator';
  if (code === 'forbidden') return 'the journal refused: only the Coordinator agent may publish a briefing';
  if (code === 'not_found') return 'the journal does not know this conversation as yours — or this journal deployment does not have the /briefings route yet (deploy the journal update: Coordinator briefings)';
  if (code === 'bad_request') return `the journal rejected the briefing — the body must be non-empty markdown of at most ${BRIEFING_BODY_MAX / 1024} KB`;
  if (code === 'journal unreachable') return 'journal unreachable';
  return peerField(code, 120) || 'unknown error';
}

export function formatBriefingPublishAck(data) {
  const b = data?.briefing;
  const convo = typeof b?.convo_id === 'string' && b.convo_id ? b.convo_id : null;
  const seq = Number.isInteger(b?.seq) ? b.seq : null;
  const where = convo ? ` (matron://convo/${convo}${seq !== null ? `, seq ${seq}` : ''})` : '';
  return `Briefing published${where}. It is already in the chat — do not repeat it.`;
}

export function validateBriefingBody(body) {
  const text = typeof body === 'string' ? body.trim() : '';
  if (!text) return { ok: false, err: bad('body is required: the briefing as markdown') };
  if (Buffer.byteLength(text, 'utf8') > BRIEFING_BODY_MAX) return { ok: false, err: bad(`body is too long: at most ${BRIEFING_BODY_MAX / 1024} KB — keep a briefing short and link to the detail`) };
  return { ok: true, value: text };
}

// `isCoordinator(session, convoId)` decides the local refusal, as for the
// routine tools: index.js passes one that also asks the journal's current
// role holder.
export function createBriefingHandlers({ sessions, journalConvoIdFor, client, isCoordinator = (session) => session?.coordinator === true }) {
  return {
    async publish(data) {
      const roomId = data?.roomId;
      if (!roomId || typeof roomId !== 'string') return bad('roomId is required');
      const session = sessions.get(roomId);
      if (!session) return { status: 404, body: { error: `no active session for chat ${roomId}` } };
      const convoId = journalConvoIdFor(session);
      if (!isCoordinator(session, convoId)) return { status: 403, body: { error: NOT_COORDINATOR } };
      if (!convoId) return { status: 409, body: { error: 'this session has no journal conversation yet' } };
      const v = validateBriefingBody(data?.body);
      if (!v.ok) return v.err;
      const idemKey = typeof data?.idem_key === 'string' && data.idem_key ? data.idem_key : null;
      const r = await client.publishBriefing({ convo_id: convoId, body: v.value }, { idemKey });
      if (r.status === 0) return { status: 502, body: { error: 'journal unreachable' } };
      if (r.status >= 400) return { status: r.status, body: { ...r.data, error: formatJournalBriefingsError(r.data) } };
      return { status: r.status, body: r.data };
    },
  };
}
