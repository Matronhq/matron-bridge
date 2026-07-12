import { describe, it, expect, vi } from 'vitest';
import { dispatchBusyQueueMagicWord, handleBusyQueueMagicWord } from '../lib/busy-queue.js';

// Busy-queue magic-word parity (PR #101 follow-up). The Matrix busy branch's
// send/interrupt/!interrupt (flush now) and cancel (pop last) handling is
// extracted into lib/busy-queue.js so the journal session-text route can
// reuse the SAME implementation. Matrix behavior is pinned byte-for-byte via
// the full seam set (sendHtml + stripQueueNotificationLinks + editMessage);
// the journal caller passes only sendReply/formatQueueSummary/flushQueue —
// no message editing exists in the journal protocol, so its feedback is a
// fresh text and the Matrix-only notification edits are simply skipped.

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

function journalDeps(overrides = {}) {
  // What journalRouteTextToSession passes: a plain reply sink, the shared
  // queue primitives, and the real editMessage — session.roomId is a real
  // Matrix room, so a Matron cancel edits the cancelled message's "📨
  // Queued" tile exactly like a Matrix cancel would (cross-transport
  // display parity; PR #104 review finding). Still no sendHtml (journal
  // feedback stays plain text) and no stripQueueNotificationLinks.
  return {
    sendReply: vi.fn(async () => {}),
    formatQueueSummary: vi.fn(fakeSummary),
    flushQueue: vi.fn(),
    editMessage: vi.fn(async () => {}),
    ...overrides,
  };
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

  it('does not strip notification links when that seam is absent (guard, do not crash)', async () => {
    const session = makeSession();
    const deps = journalDeps();
    await expect(handleBusyQueueMagicWord(session, 'send', deps)).resolves.toBeUndefined();
    // No stripQueueNotificationLinks seam passed — the "📨 Queued" tiles
    // stay as-is (their actions no-op against the now-empty queue), and
    // editMessage is a cancel-path seam only, never invoked on a flush.
    expect(session.queueNotifications).toHaveLength(2);
    expect(deps.editMessage).not.toHaveBeenCalled();
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
