// What a box expects of a signed tap on a tracker item, and the check of a
// stored tap against the box's own pinned keys (lib/approval-gate.js).
//
// A tap on a step-up question carries the user's signature over the item,
// the button, the question's words and the subject. The journal checks it
// before it stores the tap; a box that must not act on the journal's word
// rebuilds what the statement has to say from the item as it reads it and
// checks the signature itself. Here that check only labels the tap for the
// agent (the turn text and item_get): it never spends the statement's nonce,
// because the same tap is read many times.
import { createHash } from 'node:crypto';

const sha256Hex = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const str = (v) => (typeof v === 'string' ? v : '');

// The hash of the words the user was shown: {"body","title"} for the item's
// own buttons, {"body"} for a follow-up question's. Canonical JSON of an
// object of strings is JSON.stringify with the keys in order.
export function promptDigest({ title, body }) {
  const words = title === undefined ? { body: str(body) } : { body: str(body), title: str(title) };
  return sha256Hex(JSON.stringify(words));
}

const isSubject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// The `expect` of a tap comment, from the item and its thread as stored.
// null when the tap answers a comment the thread does not have: there is
// then nothing to compare the signed words with.
export function tapExpectation(item, comments, tap) {
  if (!item || typeof item !== 'object' || !tap || typeof tap !== 'object') return null;
  const replyTo = typeof tap.reply_to === 'string' && tap.reply_to ? tap.reply_to : null;
  let subject = isSubject(item.subject) ? item.subject : {};
  let digest;
  if (replyTo) {
    const asked = (Array.isArray(comments) ? comments : []).find((c) => c && c.id === replyTo);
    if (!asked) return null;
    if (asked.step_up === true) subject = isSubject(asked.subject) ? asked.subject : {};
    digest = promptDigest({ body: asked.body });
  } else {
    digest = promptDigest({ title: item.title, body: item.body });
  }
  const action = str(tap.action) || str(tap.meta?.action);
  return { type: 'item_tap', subject, item_num: item.num, item_id: item.id, action: action.trim(), reply_to: replyTo, prompt_digest: digest };
}

// gate: lib/approval-gate.js's. getItem: async (id) -> {status, data}, the
// item read with inline attachment refs as stored (the digest is over the
// stored text). Returns null when this box has no pinned keys: taps are then
// labelled from the journal's marker alone.
export function createTapVerifier({ gate, getItem }) {
  if (!gate || gate.enabled !== true) return null;

  function forThread(data, comment) {
    if (!comment || typeof comment !== 'object' || !comment.approval) return { ok: false, reason: 'no_approval' };
    const expected = tapExpectation(data?.item, data?.comments, comment);
    if (!expected) return { ok: false, reason: 'mismatch' };
    try {
      const r = gate.check(comment.approval, { ...expected, consume: false });
      return r && r.ok === true ? { ok: true, keyId: r.keyId } : { ok: false, reason: str(r?.reason) || 'check_failed' };
    } catch {
      return { ok: false, reason: 'check_failed' };
    }
  }

  return {
    // A comment in a thread already read (item_get).
    async forThread(data, comment) { return forThread(data, comment); },
    // A `commented` marker: read the item, find the comment, check it.
    async forMarker(payload) {
      let res;
      try { res = await getItem(payload?.item_id); } catch { res = null; }
      if (res?.status !== 200 || !res.data?.item) return { ok: false, reason: 'item_unreadable' };
      const id = payload?.comment?.id;
      const comment = (Array.isArray(res.data.comments) ? res.data.comments : []).find((c) => c && c.id === id);
      if (!comment) return { ok: false, reason: 'item_unreadable' };
      return forThread(res.data, comment);
    },
  };
}
