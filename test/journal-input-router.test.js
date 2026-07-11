import { describe, it, expect, vi } from 'vitest';
import { createJournalInputConsumer, resolvePromptChoice } from '../lib/journal-input-router.js';

const silentLog = { warn: () => {}, error: () => {} };

function baseFrame(overrides = {}) {
  return {
    kind: 'journal', seq: 1, convo_id: 'convo-1', ts: Date.now(),
    sender: 'user:dan', type: 'text', payload: { body: 'hi' },
    ...overrides,
  };
}

describe('resolvePromptChoice', () => {
  const options = [
    { id: 'opt_a', label: 'Yes please' },
    { id: 'opt_b', label: 'No thanks' },
    { id: 'prompt-opt-2', label: 'Ask me later' },
  ];

  it('matches by option id', () => {
    expect(resolvePromptChoice(options, 'opt_b')).toEqual({ option: options[1], index: 1 });
  });

  it('matches by label, case-insensitively', () => {
    expect(resolvePromptChoice(options, 'no THANKS')).toEqual({ option: options[1], index: 1 });
  });

  it('matches by 1-based number', () => {
    expect(resolvePromptChoice(options, '1')).toEqual({ option: options[0], index: 0 });
    expect(resolvePromptChoice(options, 3)).toEqual({ option: options[2], index: 2 });
  });

  it('returns null for an out-of-range number', () => {
    expect(resolvePromptChoice(options, '0')).toBeNull();
    expect(resolvePromptChoice(options, '99')).toBeNull();
  });

  it('returns null for an unmatched id/label', () => {
    expect(resolvePromptChoice(options, 'nonsense')).toBeNull();
  });

  it('returns null for null/undefined/empty choice', () => {
    expect(resolvePromptChoice(options, null)).toBeNull();
    expect(resolvePromptChoice(options, undefined)).toBeNull();
    expect(resolvePromptChoice(options, '  ')).toBeNull();
  });

  it('never throws on a non-array options list', () => {
    expect(resolvePromptChoice(null, 'opt_a')).toBeNull();
    expect(resolvePromptChoice(undefined, '1')).toBeNull();
  });

  it('a numeric string prefers the numbered-position match over an id match, per option order', () => {
    // id '1' would collide with the 1-based-number reading of choice '1' —
    // number wins (documents the precedence, not just asserts it).
    const numericIdOptions = [{ id: '5', label: 'Five' }, { id: '1', label: 'One' }];
    expect(resolvePromptChoice(numericIdOptions, '1')).toEqual({ option: numericIdOptions[0], index: 0 });
  });
});

describe('createJournalInputConsumer', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: vi.fn((id) => id === 'control-1'),
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  it('ignores frames whose sender is not user:* (agent echoes — the loop-prevention filter)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ sender: 'agent:dev-2' }));
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('ignores journal event types other than text/prompt_reply', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    for (const type of ['prompt', 'tool_output', 'session_status', 'read_marker', 'convo_meta', 'file', 'image', 'diff']) {
      consumer(baseFrame({ type }));
    }
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
  });

  it('routes a text event for a known session to routeTextToSession with the trimmed body and username', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ payload: { body: '  hello there  ' } }));
    expect(deps.routeTextToSession).toHaveBeenCalledTimes(1);
    const [session, body, ctx] = deps.routeTextToSession.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(body).toBe('hello there');
    expect(ctx).toEqual({ username: 'dan' });
  });

  it('skips a text event with no usable body (missing/non-string), logs, never throws', () => {
    const deps = makeDeps();
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame({ payload: {} }))).not.toThrow();
    expect(() => consumer(baseFrame({ payload: { body: '   ' } }))).not.toThrow();
    expect(() => consumer(baseFrame({ payload: null }))).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('routes a prompt_reply event for a known session to routePromptReply with target_seq/choice/text', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ type: 'prompt_reply', payload: { target_seq: 5, choice: 'opt_a', text: null } }));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    const [session, answer, ctx] = deps.routePromptReply.mock.calls[0];
    expect(session).toEqual({ claudeSessionId: 'convo-1' });
    expect(answer).toEqual({ target_seq: 5, choice: 'opt_a', text: null });
    expect(ctx).toEqual({ username: 'dan' });
  });

  it('a prompt_reply with a missing payload still dispatches with null-ish fields rather than throwing', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame({ type: 'prompt_reply', payload: undefined }))).not.toThrow();
    expect(deps.routePromptReply).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' },
      { target_seq: undefined, choice: null, text: null },
      { username: 'dan' },
    );
  });

  it('unknown/dead session (convo_id has no live session): logs, notices, never throws, never routes', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn(() => null) });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame())).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
    expect(deps.noticeUnknownConvo).toHaveBeenCalledWith('convo-1', { type: 'text', username: 'dan' });
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('control convo: text is dispatched to handleControlCommand, not to session routing', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', payload: { body: '  new /tmp/foo  ' } }));
    expect(deps.handleControlCommand).toHaveBeenCalledWith('new /tmp/foo', { username: 'dan' });
    expect(deps.findSessionByConvoId).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });

  it('control convo: prompt_reply is ignored (control convo only understands commands)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', type: 'prompt_reply', payload: { target_seq: 1, choice: 'a' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
  });

  it('control convo: an empty/whitespace-only command body is dropped silently', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'control-1', payload: { body: '   ' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
  });

  it('a non-control convo never has its text treated as a command, even if it looks like one', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ convo_id: 'convo-1', payload: { body: 'new /tmp/foo' } }));
    expect(deps.handleControlCommand).not.toHaveBeenCalled();
    expect(deps.routeTextToSession).toHaveBeenCalledWith(
      { claudeSessionId: 'convo-1' }, 'new /tmp/foo', { username: 'dan' },
    );
  });

  it('never throws even when every injected function throws', () => {
    const deps = makeDeps({
      findSessionByConvoId: vi.fn(() => { throw new Error('boom-lookup'); }),
    });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(baseFrame())).not.toThrow();
    expect(warnings.some(w => /boom-lookup/.test(w))).toBe(true);
  });

  it('malformed frame (null, non-object, missing fields) is ignored, never throws', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    expect(() => consumer(null)).not.toThrow();
    expect(() => consumer(undefined)).not.toThrow();
    expect(() => consumer({})).not.toThrow();
    expect(() => consumer('not-an-object')).not.toThrow();
    expect(deps.routeTextToSession).not.toHaveBeenCalled();
  });
});

// Staleness guard: prompt_reply.target_seq must reference the LATEST prompt
// the bridge published into that convo, or the reply is refused — a delayed
// reply must never mis-answer a newer prompt that superseded the one the
// user was looking at. Prompt seqs are recorded from the bridge's own
// published `prompt` frames echoing back on the socket (sender agent:*),
// BEFORE the user:* input filter.
describe('createJournalInputConsumer — prompt_reply staleness (target_seq)', () => {
  function makeDeps(overrides = {}) {
    return {
      isControlConvo: () => false,
      handleControlCommand: vi.fn(),
      findSessionByConvoId: vi.fn(() => ({ claudeSessionId: 'convo-1' })),
      routeTextToSession: vi.fn(),
      routePromptReply: vi.fn(),
      noticeUnknownConvo: vi.fn(),
      noticeStalePromptReply: vi.fn(),
      log: silentLog,
      ...overrides,
    };
  }

  const promptFrame = (seq, convoId = 'convo-1') => baseFrame({
    seq, convo_id: convoId, sender: 'agent:dev-2', type: 'prompt',
    payload: { question: 'Continue?', options: [{ id: 'opt-0', label: 'Yes' }] },
  });

  const replyFrame = (targetSeq, convoId = 'convo-1') => baseFrame({
    seq: 100, convo_id: convoId, type: 'prompt_reply',
    payload: { target_seq: targetSeq, choice: 'Yes', text: null },
  });

  it('a reply whose target_seq matches the latest recorded prompt seq is routed', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a stale target_seq (an older prompt was superseded) is refused with a notice, never routed', () => {
    const deps = makeDeps();
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(promptFrame(15)); // newer prompt supersedes seq 10
    consumer(replyFrame(10));
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalledWith('convo-1', {
      username: 'dan', targetSeq: 10, latestSeq: 15,
    });
    expect(warnings.some(w => /stale/i.test(w))).toBe(true);
  });

  it('no recorded prompt seq for the convo (e.g. bridge restarted live-only): reply is accepted as before', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(replyFrame(10));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('a reply with no target_seq set is accepted (nothing to check against)', () => {
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    consumer(baseFrame({ type: 'prompt_reply', payload: { target_seq: null, choice: 'Yes', text: null } }));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('prompt seqs are tracked per convo — a newer prompt in convo B does not staleness-refuse convo A', () => {
    const deps = makeDeps({ findSessionByConvoId: vi.fn((id) => ({ claudeSessionId: id })) });
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10, 'convo-a'));
    consumer(promptFrame(50, 'convo-b'));
    consumer(replyFrame(10, 'convo-a'));
    expect(deps.routePromptReply).toHaveBeenCalledTimes(1);
    expect(deps.noticeStalePromptReply).not.toHaveBeenCalled();
  });

  it('recording happens before the user:* filter — an agent-sender prompt frame is still recorded', () => {
    // (This is the normal case: the bridge's own published prompts come back
    // as agent:<device>. The previous tests already exercise it implicitly;
    // this one pins it explicitly against a future "filter first" refactor.)
    const deps = makeDeps();
    const consumer = createJournalInputConsumer(deps);
    consumer(baseFrame({ seq: 7, sender: 'agent:some-other-box', type: 'prompt', payload: { question: 'q' } }));
    consumer(replyFrame(3)); // stale vs the recorded 7
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(deps.noticeStalePromptReply).toHaveBeenCalled();
  });

  it('works without a noticeStalePromptReply callback (optional dep): still refuses, still logs, never throws', () => {
    const deps = makeDeps({ noticeStalePromptReply: undefined });
    const warnings = [];
    deps.log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const consumer = createJournalInputConsumer(deps);
    consumer(promptFrame(10));
    expect(() => consumer(replyFrame(5))).not.toThrow();
    expect(deps.routePromptReply).not.toHaveBeenCalled();
    expect(warnings.some(w => /stale/i.test(w))).toBe(true);
  });
});
