import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// index.js boots the bridge and cannot be imported, so the seams where each
// turn source hands its causes to sendToSession are pinned by source. The
// rules themselves are unit-tested in turn-cause, session-control,
// room-delivery, items-turn and journal-input-router.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const fnBody = (sig) => {
  const start = index.indexOf(sig);
  expect(start, sig).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start));
};

describe('turn causes reach sendToSession from every turn source', () => {
  it('a user\'s message names itself by convo and seq, on the direct send and on the queue entry', () => {
    expect(fnBody('function journalOnText(')).toContain('const causes = seq != null && convoId ? [userMessageCause(convoId, seq)] : null;');
    expect(fnBody('function journalOnText(')).toContain('journalRouteTextToSession(session, body, { causes })');
    const route = fnBody('async function journalRouteTextToSession(');
    expect(route).toContain('{ keepRestartBudget = false, causes = null } = {}');
    expect(route).toContain('const entry = tagCauses(markJournalOrigin([{ type: \'text\', text: trimmed }]), causes);');
    expect(route.match(/sendTextToSession\(session, trimmed, \{ skipJournalMirror: true, causes \}\)/g)).toHaveLength(2);
  });

  it('queued and resume-held messages keep their causes, and the flush that sends them merges them', () => {
    expect(fnBody('function sendToSession(')).toContain('(session._resumeOutbox ||= []).push(tagCauses(skipJournalMirror ? markJournalOrigin(contentBlocks) : contentBlocks, causes));');
    expect(fnBody('function dispatchMergedFlush(')).toContain('sendToSession(session, blocks, { skipJournalMirror: true, causes: queueCauses(queued) })');
    expect(fnBody('async function journalQueueMedia(')).toContain('const entry = tagCauses([...blocks], cause);');
  });

  it('a user\'s media message forwards its causes to both send paths', () => {
    expect(index).toContain('injectText: (session, text, { causes = null } = {}) => sendTextToSession(session, text, { causes }),');
    expect(index).toContain('injectBlocks: (session, blocks, { causes = null } = {}) => sendToSession(session, blocks, { skipJournalMirror: true, causes }),\n  // A voice note sent with the typed draft');
  });

  it('an item reply\'s cause rides the inject and the queue', () => {
    expect(index).toContain("injectBlocks: (session, blocks, { causes = null } = {}) => sendToSession(session, blocks, { skipJournalMirror: true, causes }),");
    expect(index).toMatch(/queueText: \(session, \{ text, preview, source, cause = null \}\) => journalQueueMedia\(session, \{[\s\S]{0,160}?\n {4}cause,\n/);
  });

  it('room turns forward their causes; reminders and timers are reminder turns', () => {
    expect(index).toContain('sendTextToSession(session, text, { skipJournalMirror: true, causes: meta?.causes ?? null })');
    const fire = fnBody('async function fireTimer(');
    expect(fire.match(/\{ causes: \[plainCause\('reminder'\)\] \}/g)).toHaveLength(2);
  });
});

describe('a running turn only ever gains causes', () => {
  it('a send onto a turn already on the session merges into it; only a fresh turn begins one', () => {
    const send = fnBody('function sendToSession(');
    expect(send).toContain('const beganTurn = turnStarts && !session.currentTurn;');
    expect(send).toContain('if (beganTurn) beginTurn(session, causes);\n  else if (turnStarts || causes) mergeIntoTurn(session, causes);');
    expect(send.match(/beginTurn\(/g)).toHaveLength(1);
  });

  it('a send failure ends the turn only when that send began it', () => {
    const report = fnBody('function reportSessionSendFailure(');
    expect(report).toContain('{ restoreJournalState = false, beganTurn = false } = {}');
    expect(report).toContain('if (beganTurn) endTurn(session);');
    expect(report.match(/endTurn\(/g)).toHaveLength(1);
    const send = fnBody('function sendToSession(');
    // The three dispatch failures after the turn starts pass the flag; the
    // validation rejects before it pass nothing, so they never end a turn.
    expect(send.match(/\{ restoreJournalState: true, beganTurn \}/g)).toHaveLength(3);
    expect(send.match(/reportSessionSendFailure\(/g)).toHaveLength(7);
  });

  it('agent output with no turn on the session begins one of unknown origin', () => {
    const handler = fnBody('function handleClaudeEvent(');
    const guard = handler.indexOf("if (!session.busy && !session.currentTurn && (event.type === 'assistant' || event.type === 'stream_event')) {\n    beginTurn(session, [plainCause('other')]);");
    expect(guard).toBeGreaterThan(handler.indexOf('if (isSidechainEvent(event)) return;'));
    expect(guard).toBeLessThan(handler.indexOf('switch (event.type)'));
  });

  it('a Codex steer merges its entries\' causes into the running turn before it dispatches', () => {
    const flush = fnBody('function flushQueue(');
    const merge = flush.indexOf('const steerCauses = queueCauses(queued);\n    if (steerCauses) mergeIntoTurn(session, steerCauses);');
    expect(merge).toBeGreaterThan(-1);
    expect(merge).toBeLessThan(flush.indexOf('session.codex.steer(blocks)'));
  });

  it('Send now on a busy Claude session reaches sendToSession with the queue\'s causes (merged there)', () => {
    expect(fnBody('function dispatchMergedFlush(')).toContain('causes: queueCauses(queued)');
  });
});
