import { describe, it, expect, beforeEach } from 'vitest';
import {
  childConvoId,
  subagentTitle,
  createSubagentConvoTracker,
  CHILD_STATE_RUNNING,
  CHILD_STATE_FINISHED,
} from '../lib/subagent-convos.js';
import { modelFromEvent } from '../lib/model-aliases.js';

// A fake journal publisher recording every call, mirroring the real
// publisher's method surface (see lib/journal-publisher.js). Every method
// fails open in the real thing; here they just record.
function makePublisher() {
  const calls = { upsertConvo: [], publishStatus: [], publishText: [], publishDiff: [] };
  return {
    calls,
    upsertConvo(convoId, opts) { calls.upsertConvo.push({ convoId, opts }); },
    publishStatus(convoId, status) { calls.publishStatus.push({ convoId, status }); },
    publishText(convoId, payload) { calls.publishText.push({ convoId, payload }); },
    publishDiff(convoId, payload) { calls.publishDiff.push({ convoId, payload }); },
  };
}

// A subagent assistant transcript event: these are tagged isSidechain, which
// is exactly why modelFromEvent must return null for them — the child's model
// has to be read off the event directly, never through the parent's guard.
function subagentAssistantEvent({ model, text, usage } = {}) {
  return {
    type: 'assistant',
    isSidechain: true,
    message: {
      model: model ?? 'claude-haiku-4-5',
      usage: usage ?? { input_tokens: 100, cache_read_input_tokens: 900 },
      content: text ? [{ type: 'text', text }] : [],
    },
  };
}

describe('childConvoId', () => {
  it('is deterministic and stable for a given (parent, agentId)', () => {
    expect(childConvoId('parent-uuid', 'agent-1')).toBe('parent-uuid:sub:agent-1');
    // Same inputs -> same id every time (reconnects/restarts never mint dupes).
    expect(childConvoId('parent-uuid', 'agent-1')).toBe(childConvoId('parent-uuid', 'agent-1'));
    // Distinct agents under the same parent are distinct convos.
    expect(childConvoId('parent-uuid', 'agent-2')).not.toBe(childConvoId('parent-uuid', 'agent-1'));
  });

  it('keeps a real (36-char UUID parent + UUID agent) id well under the 128-char server cap', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    expect(childConvoId(uuid, uuid).length).toBeLessThan(128);
  });
});

describe('subagentTitle', () => {
  it('prefers the label, falling back to agentType', () => {
    expect(subagentTitle('Explore the auth flow', 'code-explorer')).toBe('Explore the auth flow');
    expect(subagentTitle(null, 'code-explorer')).toBe('code-explorer');
    expect(subagentTitle('   ', 'code-explorer')).toBe('code-explorer');
    expect(subagentTitle(null, null)).toBeNull();
  });
});

describe('createSubagentConvoTracker', () => {
  let publisher;
  let tracker;
  beforeEach(() => {
    publisher = makePublisher();
    tracker = createSubagentConvoTracker({
      publisher,
      getParentConvoId: () => 'parent-uuid',
      log: { warn() {} },
    });
  });

  it('publishes a running child convo_upsert on discovery, linked to the parent', () => {
    tracker.discover('agent-1', { label: 'Explore auth', agentType: 'code-explorer' });

    expect(publisher.calls.upsertConvo).toHaveLength(1);
    const { convoId, opts } = publisher.calls.upsertConvo[0];
    expect(convoId).toBe('parent-uuid:sub:agent-1');
    expect(opts.parentConvoId).toBe('parent-uuid');
    expect(opts.sessionState).toBe(CHILD_STATE_RUNNING);
    expect(opts.title).toBe('Explore auth');
  });

  it('titles the child by agentType when no label is available yet', () => {
    tracker.discover('agent-1', { label: null, agentType: 'code-explorer' });
    expect(publisher.calls.upsertConvo[0].opts.title).toBe('code-explorer');
  });

  it('discovering the same agent twice does not mint a second convo', () => {
    tracker.discover('agent-1', { label: 'x', agentType: null });
    tracker.discover('agent-1', { label: 'x', agentType: null });
    expect(publisher.calls.upsertConvo).toHaveLength(1);
  });

  it('routes a subagent event to the child convo id and derives the child model from the event itself', () => {
    tracker.discover('agent-1', { label: 'Explore', agentType: 'code-explorer' });
    publisher.calls.publishStatus.length = 0; // ignore the discovery status

    const ev = subagentAssistantEvent({ model: 'claude-haiku-4-5' });
    const child = tracker.onEvent('agent-1', { label: 'Explore', agentType: 'code-explorer', event: ev });

    expect(child.convoId).toBe('parent-uuid:sub:agent-1');
    // Per-subagent status published to the CHILD, model taken off the event.
    const status = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-1');
    expect(status.status.model).toBe('claude-haiku-4-5');
    expect(status.status.context.tokens).toBe(1000);
  });

  it('isolates per-subagent status AND the parent model guard is never weakened', () => {
    tracker.discover('agent-1', { label: 'A', agentType: 'code-explorer' });
    tracker.discover('agent-2', { label: 'B', agentType: 'code-reviewer' });

    tracker.onEvent('agent-1', { event: subagentAssistantEvent({ model: 'claude-haiku-4-5' }) });
    tracker.onEvent('agent-2', { event: subagentAssistantEvent({ model: 'claude-opus-4-8' }) });

    const s1 = publisher.calls.publishStatus.filter(s => s.convoId === 'parent-uuid:sub:agent-1').at(-1);
    const s2 = publisher.calls.publishStatus.filter(s => s.convoId === 'parent-uuid:sub:agent-2').at(-1);
    expect(s1.status.model).toBe('claude-haiku-4-5');
    expect(s2.status.model).toBe('claude-opus-4-8');

    // Regression: the tracker reads the subagent's model off the event directly
    // because the parent-protecting guard (modelFromEvent) intentionally
    // returns null for these isSidechain events. If it didn't, the child model
    // would be unreachable AND the parent's model would be at risk.
    expect(modelFromEvent(subagentAssistantEvent({ model: 'claude-haiku-4-5' }))).toBeNull();
  });

  it('carries task_ref (the spawning Task tool_use_id) in the child status payload', () => {
    tracker.noteTaskStarted('toolu_task_abc');
    tracker.discover('agent-1', { label: 'A', agentType: 'code-explorer' });

    // task_ref rides the status frame from the very first (discovery) status.
    const first = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-1');
    expect(first.status.task_ref).toBe('toolu_task_abc');

    // ...and keeps riding subsequent status frames (server caches last-per-convo).
    tracker.onEvent('agent-1', { event: subagentAssistantEvent({ model: 'claude-haiku-4-5' }) });
    expect(publisher.calls.publishStatus.at(-1).status.task_ref).toBe('toolu_task_abc');
  });

  it('associates pending Task tool_use_ids to children FIFO', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.noteTaskStarted('toolu_2');
    tracker.discover('agent-a', { label: 'A', agentType: null });
    tracker.discover('agent-b', { label: 'B', agentType: null });

    const a = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-a');
    const b = publisher.calls.publishStatus.find(s => s.convoId === 'parent-uuid:sub:agent-b');
    expect(a.status.task_ref).toBe('toolu_1');
    expect(b.status.task_ref).toBe('toolu_2');
  });

  it('marks the child done when the spawning Task tool_result is observed', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('agent-1', { label: 'A', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.noteTaskResult('toolu_1');

    expect(publisher.calls.upsertConvo).toHaveLength(1);
    const { convoId, opts } = publisher.calls.upsertConvo[0];
    expect(convoId).toBe('parent-uuid:sub:agent-1');
    expect(opts.sessionState).toBe(CHILD_STATE_FINISHED);
  });

  it('an unrelated Task tool_result does not finish any child', () => {
    tracker.noteTaskStarted('toolu_1');
    tracker.discover('agent-1', { label: 'A', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.noteTaskResult('toolu_unknown');
    expect(publisher.calls.upsertConvo).toHaveLength(0);
  });

  it('finishAll sweeps every still-running child to done exactly once', () => {
    tracker.discover('agent-1', { label: 'A', agentType: null });
    tracker.discover('agent-2', { label: 'B', agentType: null });
    publisher.calls.upsertConvo.length = 0;

    tracker.finishAll();
    expect(publisher.calls.upsertConvo.map(u => u.opts.sessionState)).toEqual([
      CHILD_STATE_FINISHED, CHILD_STATE_FINISHED,
    ]);

    // Idempotent: a second sweep (or a late tool_result) does not re-emit.
    tracker.finishAll();
    tracker.noteTaskResult('anything');
    expect(publisher.calls.upsertConvo).toHaveLength(2);
  });

  it('does nothing (never throws) when the parent convo id is not yet known', () => {
    const t = createSubagentConvoTracker({
      publisher,
      getParentConvoId: () => null,
      log: { warn() {} },
    });
    expect(() => t.discover('agent-1', { label: 'A', agentType: null })).not.toThrow();
    expect(publisher.calls.upsertConvo).toHaveLength(0);
    expect(t.convoIdFor('agent-1')).toBeNull();
  });
});
