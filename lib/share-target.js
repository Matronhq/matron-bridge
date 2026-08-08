// Resolve which live session a /share-sensitive roomId refers to.
//
// The share notification is posted into the room the caller names; a stale
// or mistyped roomId used to be accepted silently, landing the notification
// in another chat (or nowhere). Callers must get either a hard rejection
// (no live session) or a human-readable description of the chat that was
// notified, so a wrong-but-live room is immediately visible.

import path from 'node:path';

function describeSession(roomId, session) {
  const title = session._journalTitleHint
    || (session.workdir ? path.basename(session.workdir) : null)
    || '(untitled)';
  return `"${title}" (room ${roomId})`;
}

export function resolveShareTarget(sessions, roomId) {
  const session = sessions.get(roomId);
  if (session && session.alive !== false) {
    return { ok: true, description: describeSession(roomId, session) };
  }
  const live = [...sessions.entries()]
    .filter(([, s]) => s.alive !== false)
    .map(([id, s]) => describeSession(id, s));
  return {
    ok: false,
    error: `roomId ${roomId} has no live session — refusing to create a share whose `
      + `notification cannot reach its chat. Live sessions: ${live.join('; ') || '(none)'}`,
  };
}
