import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { dispatchBusyQueueMagicWord, handleBusyQueueMagicWord } from '../lib/busy-queue.js';

// Busy-queue magic-word parity (PR #101 follow-up). The Matrix busy branch's
// send/interrupt/!interrupt (flush now) and cancel (pop last) handling is
// extracted into lib/busy-queue.js so the journal session-text route can
// reuse the SAME implementation. Matrix behavior is pinned byte-for-byte via
// the full seam set. Per the PR #104 review findings, the journal caller
// passes BOTH Matrix notification seams too (editMessage AND
// stripQueueNotificationLinks — session.roomId is a real Matrix room, and
// queuedMessages/queueNotifications must move in lockstep on every path or
// later indexed cancels edit the WRONG tile); only sendHtml is omitted,
// because journal feedback stays plain text.

// The real formatQueueSummary lives in index.js (it leans on escapeHtml);
// tests inject a recognizable stand-in so assertions can prove it was fed
// the flushed queue.
function fakeSummary(queued) {
  return {
    plain: `  1. [${queued.length} entries]`,
    html: `<ol><li>[${queued.length} entries]</li></ol>`,
  };
}

function makeSession(overrides = {}) {
  return {
    roomId: '!room:server',
    busy: true,
    queuedMessages: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]],
    queueNotifications: [
      { eventId: '$ev1', plain: '📨 Queued (1): first' },
      { eventId: '$ev2', plain: '📨 Queued (2): second' },
    ],
    ...overrides,
  };
}

function matrixDeps(overrides = {}) {
  return {
    sendReply: vi.fn(async () => {}),
    sendHtml: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(fakeSummary),
    flushQueue: vi.fn(),
    stripQueueNotificationLinks: vi.fn(),
    editMessage: vi.fn(async () => {}),
    ...overrides,
  };
}

// Faithful stand-in for index.js's stripQueueNotificationLinks (index.js
// ~3150): clears session.queueNotifications AND edits every tile back to its
// plain text (removing the action links). Bound to a deps object so the
// per-tile edits are observable on the same editMessage mock.
function realisticStrip(deps) {
  return vi.fn(async (session) => {
    const notifs = session.queueNotifications || [];
    if (notifs.length === 0) return;
    session.queueNotifications = [];
    for (const { eventId, plain } of notifs) {
      await deps.editMessage(session.roomId, eventId, plain);
    }
  });
}

function journalDeps(overrides = {}) {
  // What journalRouteTextToSession passes: a plain reply sink, the shared
  // queue primitives, and BOTH Matrix notification seams (PR #104 review
  // findings) — session.roomId is a real Matrix room, so a Matron cancel
  // pops-and-edits the cancelled tile and a Matron send clears + strips the
  // queued tiles, exactly like their Matrix counterparts. Only sendHtml is
  // omitted (journal feedback stays plain text).
  const deps = {
    sendReply: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(fakeSummary),
    flushQueue: vi.fn(),
    editMessage: vi.fn(async () => {}),
  };
  deps.stripQueueNotificationLinks = realisticStrip(deps);
  return { ...deps, ...overrides };
}

describe('dispatchBusyQueueMagicWord — gating', () => {
  it('is a no-op when the session is not busy: the words route to Claude as normal text', async () => {
    for (const word of ['send', 'interrupt', '!interrupt', 'cancel']) {
      const session = makeSession({ busy: false });
      const deps = journalDeps();
      expect(await dispatchBusyQueueMagicWord(word, session, deps)).toBe(false);
      expect(deps.flushQueue).not.toHaveBeenCalled();
      expect(deps.sendReply).not.toHaveBeenCalled();
      expect(session.queuedMessages).toHaveLength(2); // untouched
    }
  });

  it('is a no-op for non-magic text while busy (queues as ordinary text at the call site)', async () => {
    const session = makeSession();
    const deps = journalDeps();
    expect(await dispatchBusyQueueMagicWord('please send the email', session, deps)).toBe(false);
    expect(deps.flushQueue).not.toHaveBeenCalled();
    expect(session.queuedMessages).toHaveLength(2);
  });

  it('handles a magic word while busy and reports it handled', async () => {
    const session = makeSession();
    const deps = journalDeps();
    expect(await dispatchBusyQueueMagicWord('send', session, deps)).toBe(true);
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });
});

describe('handleBusyQueueMagicWord — send/interrupt (Matrix pin, full seams)', () => {
  it('flushes the whole queue through flushQueue in ONE call, after the summary message', async () => {
    const session = makeSession();
    const queuedRef = session.queuedMessages;
    const order = [];
    const deps = matrixDeps({
      sendHtml: vi.fn(async () => order.push('summary')),
      flushQueue: vi.fn(() => order.push('flush')),
    });

    await handleBusyQueueMagicWord(session, 'send', deps);

    // The queue is detached before anything else (a concurrent queueing
    // message must not land in the flushed batch), then flushed once.
    expect(session.queuedMessages).toBeNull();
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue).toHaveBeenCalledWith(session, queuedRef);
    expect(order).toEqual(['summary', 'flush']);
    // Matrix strips its queue-notification links.
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
  });

  it('sends the exact Matrix summary text (html sink present)', async () => {
    const session = makeSession();
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendHtml).toHaveBeenCalledWith(
      '⚡ Sending 2 queued messages now:\n  1. [2 entries]',
      '<b>⚡ Sending 2 queued messages now:</b><ol><li>[2 entries]</li></ol>',
    );
    expect(deps.sendReply).not.toHaveBeenCalled();
  });

  it('uses the singular form for one queued message', async () => {
    const session = makeSession({ queuedMessages: [[{ type: 'text', text: 'only' }]] });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendHtml.mock.calls[0][0]).toMatch(/^⚡ Sending 1 queued message now:/);
  });

  it('replies "no queued messages" when the queue is empty, and never flushes', async () => {
    const session = makeSession({ queuedMessages: null });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('⚡ No queued messages to send.');
    expect(deps.flushQueue).not.toHaveBeenCalled();
    // Matrix still strips notification links on the empty-queue path —
    // pinned: the original ran stripQueueNotificationLinks unconditionally.
    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledTimes(1);
  });
});

describe('handleBusyQueueMagicWord — send/interrupt (journal seams)', () => {
  it('flushes via the same flushQueue and falls back to the plain-text summary', async () => {
    const session = makeSession();
    const queuedRef = session.queuedMessages;
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
    expect(deps.flushQueue).toHaveBeenCalledWith(session, queuedRef);
    expect(deps.sendReply).toHaveBeenCalledWith('⚡ Sending 2 queued messages now:\n  1. [2 entries]');
    expect(session.queuedMessages).toBeNull();
  });

  it('a caller that omits the strip seam is guarded (no crash), tiles left as-is', async () => {
    const session = makeSession();
    const deps = journalDeps({ stripQueueNotificationLinks: undefined });
    await expect(handleBusyQueueMagicWord(session, 'send', deps)).resolves.toBeUndefined();
    expect(session.queueNotifications).toHaveLength(2);
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('journal send-flush clears queueNotifications and strips each tile to its plain text (PR #104 Bugbot finding)', async () => {
    const session = makeSession();
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'send', deps);
    // strip is fire-and-forget (un-awaited, like the Matrix original) — let
    // its per-tile edits drain before asserting them.
    await new Promise(r => setTimeout(r, 0));

    expect(deps.stripQueueNotificationLinks).toHaveBeenCalledWith(session);
    expect(session.queueNotifications).toEqual([]);
    expect(deps.editMessage).toHaveBeenCalledWith('!room:server', '$ev1', '📨 Queued (1): first');
    expect(deps.editMessage).toHaveBeenCalledWith('!room:server', '$ev2', '📨 Queued (2): second');
    expect(deps.flushQueue).toHaveBeenCalledTimes(1);
  });

  it('Bugbot scenario invariant: after a Matron send-flush, a re-queued message is index-aligned with its tile', async () => {
    // The indexed cancel:<idx> button handler lives in index.js's Matrix
    // button_response path and is not importable in this harness (top-level
    // Matrix/express side effects — see showbashoutput.test.js). What
    // protects it is the invariant asserted here: a Matron send-flush leaves
    // BOTH arrays empty, so post-flush queueing rebuilds them in lockstep
    // from index 0 — cancel:0 then splices queue[0] and notifs[0] for the
    // SAME message. Pre-fix, notifs kept the two stale entries, so
    // notifs[0] was tileA while queue[0] was the new message C.
    const session = makeSession();
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'send', deps);

    expect(session.queuedMessages).toBeNull();
    expect(session.queueNotifications).toEqual([]);

    // Re-queue exactly like index.js's busy paths do (push to both arrays).
    session.queuedMessages = [[{ type: 'text', text: 'C' }]];
    session.queueNotifications.push({ eventId: '$evC', plain: '📨 Queued (1): C' });
    expect(session.queueNotifications[0].eventId).toBe('$evC');
    expect(session.queuedMessages).toHaveLength(session.queueNotifications.length);
  });
});

// The wiring half of the PR #104 Bugbot findings: index.js can't be imported
// in-process, so pin by source inspection that the journal busy caller hands
// the shared dispatcher BOTH Matrix notification seams (the lib guards make
// omitting them silently "work" — this is what keeps the wiring honest).
describe('index.js journal busy caller — notification seams wiring (source inspection)', () => {
  it('passes editMessage AND stripQueueNotificationLinks to dispatchBusyQueueMagicWord', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('dispatchBusyQueueMagicWord(trimmed, session, {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const args = src.slice(start, end);
    expect(args).toMatch(/\beditMessage\b/);
    expect(args).toMatch(/\bstripQueueNotificationLinks\b/);
  });
});

describe('handleBusyQueueMagicWord — cancel (Matrix pin, full seams)', () => {
  it('pops the LAST queued message, edits its notification, and reports the remaining count', async () => {
    const session = makeSession();
    const deps = matrixDeps();

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0]).toEqual([{ type: 'text', text: 'first' }]);
    expect(session.queueNotifications).toHaveLength(1);
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (1 remaining).');
    expect(deps.flushQueue).not.toHaveBeenCalled();
  });

  it('cancelling the only queued message nulls the queue and says "queue empty"', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'solo' }]],
      queueNotifications: [{ eventId: '$ev1', plain: '📨 Queued (1): solo' }],
    });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(session.queuedMessages).toBeNull();
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('replies "no queued messages" when nothing is queued', async () => {
    const session = makeSession({ queuedMessages: [], queueNotifications: [] });
    const deps = matrixDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('No queued messages to cancel.');
    expect(deps.editMessage).not.toHaveBeenCalled();
  });

  it('a notification entry without a Matrix event id is popped but not edited (guard, do not crash)', async () => {
    const session = makeSession({
      queuedMessages: [[{ type: 'text', text: 'x' }]],
      queueNotifications: [{ eventId: null, plain: '📨 Queued (1): x' }],
    });
    const deps = matrixDeps();
    await expect(handleBusyQueueMagicWord(session, 'cancel', deps)).resolves.toBeUndefined();
    expect(deps.editMessage).not.toHaveBeenCalled();
    // The notif is still popped in lockstep with the queue entry.
    expect(session.queueNotifications).toHaveLength(0);
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('pops the notification in lockstep even when NO editMessage seam is passed (arrays never drift)', async () => {
    // PR #104 review finding: skipping the pop when the edit seam was absent
    // left queueNotifications longer than queuedMessages, so a LATER Matrix
    // cancel edited the wrong tile. The pop must be unconditional; only the
    // edit itself is seam-gated.
    const session = makeSession();
    const deps = journalDeps({ editMessage: undefined });
    await expect(handleBusyQueueMagicWord(session, 'cancel', deps)).resolves.toBeUndefined();
    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queueNotifications).toHaveLength(1);
    expect(session.queueNotifications[0].eventId).toBe('$ev1');
  });
});

describe('handleBusyQueueMagicWord — cancel (journal seams)', () => {
  it('pops BOTH arrays in lockstep, edits the popped tile "(cancelled)", and publishes the remaining count', async () => {
    const session = makeSession();
    const deps = journalDeps();

    await handleBusyQueueMagicWord(session, 'cancel', deps);

    expect(session.queuedMessages).toHaveLength(1);
    expect(session.queuedMessages[0]).toEqual([{ type: 'text', text: 'first' }]);
    // Cross-transport display parity (PR #104 review finding): the
    // cancelled message's own notification is popped AND edited, exactly
    // like a Matrix-typed cancel — never left dangling to misalign a later
    // Matrix cancel.
    expect(session.queueNotifications).toHaveLength(1);
    expect(session.queueNotifications[0].eventId).toBe('$ev1');
    expect(deps.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );
    expect(deps.sendReply).toHaveBeenCalledWith('Cancelled queued message (1 remaining).');
  });

  it('mixed sequence: a Matron cancel then a Matrix cancel each edit the CORRECT tile', async () => {
    const session = makeSession();
    const journal = journalDeps();
    const matrix = matrixDeps();

    // Matron cancels the last queued message -> $ev2's tile is edited.
    await handleBusyQueueMagicWord(session, 'cancel', journal);
    expect(journal.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev2', '✕ 📨 Queued (2): second (cancelled)',
    );

    // A subsequent Matrix-typed cancel pops the remaining pair and edits
    // $ev1 — NOT a dangling $ev2 (the pre-fix misalignment).
    await handleBusyQueueMagicWord(session, 'cancel', matrix);
    expect(matrix.editMessage).toHaveBeenCalledWith(
      '!room:server', '$ev1', '✕ 📨 Queued (1): first (cancelled)',
    );
    expect(session.queuedMessages).toBeNull();
    expect(session.queueNotifications).toHaveLength(0);
    expect(matrix.sendReply).toHaveBeenCalledWith('Cancelled queued message (queue empty).');
  });

  it('empty queue: fresh "No queued messages to cancel." text, nothing mutated', async () => {
    const session = makeSession({ queuedMessages: null });
    const deps = journalDeps();
    await handleBusyQueueMagicWord(session, 'cancel', deps);
    expect(deps.sendReply).toHaveBeenCalledWith('No queued messages to cancel.');
    expect(deps.editMessage).not.toHaveBeenCalled();
    expect(session.queueNotifications).toHaveLength(2);
  });
});
