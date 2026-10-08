import { describe, it, expect } from 'vitest';
import { activityStateChanged, truncateActivityDetail, shouldResumeThinkingAfterTool } from '../lib/journal-activity.js';

// Pure helpers only — no session, no publisher, no I/O. index.js owns the
// session._journalActivityState field and calls these around it, exactly
// the way journalSessionState owns session._journalState. See index.js's
// journalActivity() for the wiring these are extracted from.

describe('activityStateChanged', () => {
  it('reports a change on the very first state (lastState undefined/null)', () => {
    expect(activityStateChanged(undefined, 'thinking')).toBe(true);
    expect(activityStateChanged(null, 'thinking')).toBe(true);
  });

  it('suppresses a repeat of the same state (thinking -> thinking)', () => {
    expect(activityStateChanged('thinking', 'thinking')).toBe(false);
  });

  it('reports a change across the full thinking -> tool -> thinking sequence', () => {
    // Simulates the exact sequence the brief calls out: dispatch (thinking),
    // a tool starts (tool), that tool completes and Claude continues
    // (thinking again) — every step here is a real change.
    let last = null;
    const seen = [];
    for (const next of ['thinking', 'thinking', 'tool', 'thinking', 'idle']) {
      const changed = activityStateChanged(last, next);
      seen.push(changed);
      if (changed) last = next;
    }
    expect(seen).toEqual([true, false, true, true, true]);
    expect(last).toBe('idle');
  });

  it('treats different states as a change regardless of value (tool -> idle)', () => {
    expect(activityStateChanged('tool', 'idle')).toBe(true);
  });
});

describe('truncateActivityDetail', () => {
  it('passes short commands through unchanged', () => {
    expect(truncateActivityDetail('ls -la')).toBe('ls -la');
  });

  it('leaves a command exactly at the limit untouched', () => {
    const exact = 'a'.repeat(100);
    expect(truncateActivityDetail(exact)).toBe(exact);
  });

  it('truncates a long command with an ellipsis, tighter than the server\'s 200-char cap', () => {
    const long = 'x'.repeat(250);
    const result = truncateActivityDetail(long);
    expect(result.length).toBeLessThan(200);
    expect(result.endsWith('…')).toBe(true);
    expect(result.startsWith('x'.repeat(100))).toBe(true);
  });

  it('passes non-string input through as undefined rather than throwing', () => {
    expect(truncateActivityDetail(undefined)).toBeUndefined();
    expect(truncateActivityDetail(null)).toBeUndefined();
    expect(truncateActivityDetail(42)).toBeUndefined();
  });
});

describe('shouldResumeThinkingAfterTool', () => {
  it('resumes thinking when the last activity is tool and nothing is waiting on a prompt (the normal case)', () => {
    expect(shouldResumeThinkingAfterTool('tool', false)).toBe(true);
  });

  it('the exact bug scenario: a prompt-answered iv turn (busy never set) still resumes thinking after its tool finishes', () => {
    // session.busy is irrelevant to this helper by design — it isn't even a
    // parameter. What matters is that activity state was 'tool' and nothing
    // is currently waiting on a prompt, regardless of what busy is doing.
    expect(shouldResumeThinkingAfterTool('tool', false)).toBe(true);
  });

  it('does not fire when the last activity state is not tool (nothing to resume from)', () => {
    expect(shouldResumeThinkingAfterTool('thinking', false)).toBe(false);
    expect(shouldResumeThinkingAfterTool('idle', false)).toBe(false);
    expect(shouldResumeThinkingAfterTool(undefined, false)).toBe(false);
    expect(shouldResumeThinkingAfterTool(null, false)).toBe(false);
  });

  it('never fires for a session waiting on a prompt, even if activity state still reads tool', () => {
    expect(shouldResumeThinkingAfterTool('tool', true)).toBe(false);
  });

  it('a finished command never keeps showing while Claude continues working: tool -> (tool_result) -> thinking', () => {
    // Simulates the exact sequence: dispatch marks 'tool', a Bash tool
    // finishes (tool_result arrives), gate decides whether to resurrect.
    let last = 'tool';
    const waitingOnPrompt = false;
    const resumed = shouldResumeThinkingAfterTool(last, waitingOnPrompt);
    expect(resumed).toBe(true);
    if (resumed) last = 'thinking';
    expect(last).toBe('thinking');
  });

  it('thinking never fires for an idle/waiting session: turn already ended before a stray tool_result arrives', () => {
    // 'result'/onTurnEnd already flipped activity to 'idle' (turn is over);
    // a late tool_result for that turn's tool must not resurrect 'thinking'
    // behind it.
    expect(shouldResumeThinkingAfterTool('idle', false)).toBe(false);
  });
});
