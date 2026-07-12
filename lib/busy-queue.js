// Shared busy-queue magic-word handling (PR #101 follow-up): the Matrix
// room.message busy branch's send/interrupt/!interrupt (flush the queue now)
// and cancel (pop the last queued message) logic, extracted verbatim so the
// journal session-text route (journalRouteTextToSession, index.js) can reuse
// the SAME implementation instead of queueing those words as literal text.
//
// Injection style follows lib/command-dispatch.js: classification is a pure
// shared predicate (classifyBusyMagicWord there), and everything index.js-
// bound rides in as injected seams — formatQueueSummary and flushQueue are
// the shared queue primitives BOTH transports must go through (one merged
// send + origin-aware mirroring, lib/queue-flush.js; never a second flush
// path). The journal caller skips the sendHtml sink (its own feedback is a
// fresh plain text — the journal protocol has no message editing) and
// stripQueueNotificationLinks, but DOES pass editMessage: session.roomId is
// a real Matrix room, so a Matron cancel edits the cancelled message's
// "📨 Queued" tile exactly like a Matrix cancel (PR #104 review finding —
// cross-transport display parity, and queuedMessages/queueNotifications
// must pop in lockstep or a later Matrix cancel edits the WRONG tile).

import { classifyBusyMagicWord } from './command-dispatch.js';

// The extracted Matrix busy-branch bodies, byte-for-byte where a seam is
// present and skipped where it isn't:
//   'send'  : detach the queue first (a concurrently-arriving message must
//             not land in the flushed batch), strip Matrix notification
//             links (seam optional, un-awaited like the original), announce
//             the flush (html sink preferred, plain fallback — the exact
//             Matrix strings), THEN flushQueue(session, queued) — one merged
//             send. Empty queue: "⚡ No queued messages to send."
//   'cancel': pop the LAST queued message AND its notification — the pop is
//             unconditional (PR #104 review finding: the two arrays must
//             shrink in lockstep, or a later cancel's "(cancelled)" edit
//             lands on the wrong tile); only the edit itself is seam-gated,
//             and a notification without an eventId is popped but not
//             edited — same guard the Matrix branch had. Reply with the
//             exact remaining-count strings.
export async function handleBusyQueueMagicWord(session, action, {
  sendReply,
  sendHtml = null,
  formatQueueSummary,
  flushQueue,
  stripQueueNotificationLinks = null,
  editMessage = null,
} = {}) {
  if (action === 'send') {
    const queued = session.queuedMessages || [];
    session.queuedMessages = null;
    if (stripQueueNotificationLinks) stripQueueNotificationLinks(session);
    if (queued.length > 0) {
      const summary = formatQueueSummary(queued);
      if (sendHtml) {
        const plainMsg = `⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`;
        const htmlMsg = `<b>⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:</b>${summary.html}`;
        await sendHtml(plainMsg, htmlMsg);
      } else {
        await sendReply(`⚡ Sending ${queued.length} queued message${queued.length > 1 ? 's' : ''} now:\n${summary.plain}`);
      }
      flushQueue(session, queued);
    } else {
      await sendReply('⚡ No queued messages to send.');
    }
    return;
  }

  // action === 'cancel'
  const queue = session.queuedMessages || [];
  const notifs = session.queueNotifications || [];
  if (queue.length === 0) {
    await sendReply('No queued messages to cancel.');
    return;
  }
  queue.pop();
  if (notifs.length > 0) {
    const { eventId, plain } = notifs.pop();
    if (editMessage && eventId) {
      await editMessage(session.roomId, eventId, `✕ ${plain} (cancelled)`);
    }
  }
  const remaining = queue.length;
  if (remaining === 0) {
    session.queuedMessages = null;
  }
  await sendReply(remaining === 0
    ? 'Cancelled queued message (queue empty).'
    : `Cancelled queued message (${remaining} remaining).`);
}

// Classify-and-handle gate, dispatchJournalRescueKeystroke-style: returns
// true if `text` was a busy-queue magic word and has been fully handled,
// false otherwise (not busy, or not magic) — in which case NOTHING was
// touched and the caller queues/routes the text as it always did. The
// not-busy check lives HERE (not just at the call sites) so "these words are
// only magic while busy" is a tested property of the shared module rather
// than a convention each transport re-implements.
export async function dispatchBusyQueueMagicWord(text, session, deps) {
  if (!session || !session.busy) return false;
  const action = classifyBusyMagicWord(text);
  if (!action) return false;
  await handleBusyQueueMagicWord(session, action, deps);
  return true;
}
