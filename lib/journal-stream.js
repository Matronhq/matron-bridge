import { randomUUID } from 'crypto';

// Pure helper for assistant-text streaming wiring (index.js -> journalPublisher
// .stream / .endStream), in the same style as lib/journal-activity.js: no
// session, no I/O, so the per-message ref minting is unit-testable without a
// live session or a journal connection. index.js owns the per-session fields
// (session._journalStreamRef, session._journalStreamMsgId) and calls this
// around them, exactly the way journalActivity owns session._journalActivityState.

// Mint or reuse the streaming ref for the assistant message currently being
// streamed. A message's own id is a stable, globally-unique handle and the
// value the client keys its overlay off, so it IS the ref; only when the id is
// absent (defensive — Claude's partial events always carry one) do we fall back
// to a random uuid. The ref is reused while the SAME message keeps streaming so
// all of that message's deltas coalesce under one overlay (both bridge-side and
// in the server hub, whose coalescing key includes message_ref); a new message
// id yields a fresh ref (the caller ends the previous overlay first). The same
// ref is later threaded into the durable publish of that message so the client
// retires the overlay by ref rather than the body-match fallback.
export function streamRefFor(prevRef, prevMsgId, messageId, mkId = randomUUID) {
  if (prevRef && prevMsgId != null && prevMsgId === messageId) return prevRef;
  return messageId || mkId();
}
