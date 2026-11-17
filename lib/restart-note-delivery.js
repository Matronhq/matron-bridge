// Delivery of resume notes after a restart, with retry and a fallback card.
//
// lib/restart-notes.js hands the boot code the notes a session left itself.
// Delivering one is a single attempt: if it fails (the conversation cannot be
// resumed yet, the session refuses the text) the note is gone and nothing
// resumes the chat. This module keeps the notes on disk until each one has
// been dealt with:
//
//   * a failed delivery is tried again after retryMs, maxAttempts times in
//     all; after the last one the chat gets a "Carry on" card instead (the
//     note replaced the card the chat would otherwise have had);
//   * the notes are removed from the notes file only once every one has
//     either been delivered or been given its card.
//
// Delivery is at-least-once. A crash before a note is delivered leaves it on
// disk, so the next boot delivers it (once). A crash after a successful
// delivery but before the notes are removed delivers it a second time: from
// the file alone that cannot be told apart from a failed delivery, and
// nothing on the receiving side deduplicates. Retries live in memory; a
// crash loses the attempt count, not the note.
//
// Everything impure is injected, so the policy tests without timers or a bridge.

export const NOTE_FIRST_DELAY_MS = 15_000;
export const NOTE_RETRY_MS = 60_000;
export const NOTE_MAX_ATTEMPTS = 3;

// deliver(note) -> true (handed to the session) or anything else (failed);
//   a throw or a rejection counts as failed. note = { convoId, text, ageMs,
//   interrupted }, with ageMs measured at the time of the attempt.
// recover(note) publishes the "Carry on" card for a note that could not be
//   delivered. A throw is logged; the card is best effort.
// discard(taken) removes the notes that were read from the notes file.
//   A throw is logged; the notes are then delivered again at the next boot.
export function createNoteDelivery({
  deliver, recover = () => {}, discard = () => {},
  schedule = setTimeout, now = Date.now, log = () => {},
  firstDelayMs = NOTE_FIRST_DELAY_MS, retryMs = NOTE_RETRY_MS, maxAttempts = NOTE_MAX_ATTEMPTS,
}) {
  return {
    // deliveries: what takeNoteDeliveries chose to deliver. taken: every note
    // that was read from the file (including the ones it dropped), which is
    // what gets removed once the deliveries have all settled.
    start(deliveries, taken = []) {
      const startedAt = now();
      let remaining = deliveries.length;
      const settleOne = () => {
        remaining -= 1;
        if (remaining > 0) return;
        try { discard(taken); } catch (e) { log(`[restart-note] could not remove the delivered notes: ${e?.message ?? e}`); }
      };
      if (!remaining) {
        try { discard(taken); } catch (e) { log(`[restart-note] could not remove the taken notes: ${e?.message ?? e}`); }
        return;
      }
      const attempt = async (note, n) => {
        let ok;
        try { ok = (await deliver({ ...note, ageMs: (note.ageMs || 0) + (now() - startedAt) })) === true; } catch { ok = false; }
        if (ok) { settleOne(); return; }
        if (n < maxAttempts) {
          log(`[restart-note] delivery to convo=${note.convoId} failed (attempt ${n} of ${maxAttempts}); trying again in ${Math.round(retryMs / 1000)}s`);
          schedule(() => { void attempt(note, n + 1); }, retryMs);
          return;
        }
        log(`[restart-note] delivery to convo=${note.convoId} failed ${maxAttempts} times; publishing the Carry on card`);
        try { recover(note); } catch (e) { log(`[restart-note] recovery card failed for convo=${note.convoId}: ${e?.message ?? e}`); }
        settleOne();
      };
      for (const note of deliveries) schedule(() => { void attempt(note, 1); }, firstDelayMs);
    },
  };
}
