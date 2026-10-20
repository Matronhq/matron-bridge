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
