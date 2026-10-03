import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { armReplyRef, settleReplyRef } from '../lib/journal-stream.js';

// The spoken summary (voice mode, matron-apple spec 2026-10-03 §1) as index.js
// wires it. Importing index.js would start the bridge, so the two functions
// under test are lifted out of its source and run in a vm with their
// collaborators stubbed — the idiom of test/codex-progress.test.js. The
// pieces themselves are tested in test/journal-stream.test.js and
// test/summary-pass.test.js; a break here is silent in production (voice mode
// just loses its spoken line and falls back to the apps' own cleaner).
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

// Runs the real flushResponse once.
function flushWith(session, { splitMessage = (text) => [text] } = {}) {
  const start = src.indexOf('function flushResponse(');
  const end = src.indexOf('\n}\n', start) + 2;
  expect(start, 'could not find flushResponse in index.js — this test needs updating').toBeGreaterThan(-1);
  const context = vm.createContext({
    briefContextReport: () => null,
    recordConversationMessage: (s, role, text) => s.chatHistory.push({ role, text }),
    applyFallbackTitle: () => {}, SERVER_LABEL: 'bridge', updateRoomName: () => {},
    splitMessage, armReplyRef, settleReplyRef,
  });
  vm.runInContext(src.slice(start, end), context);
  context.flushResponse(session);
}

// A session whose sendCallback stands in for sendToRoom: it puts the armed
// ref on the text event it "publishes" and nulls it, in the same synchronous
// step. `events` is what was published.
function sessionWith(extra = {}) {
  const events = [];
  const session = {
    responseBuffer: 'The fix is ready.', chatHistory: [], _journalStreamRef: null, _journalDurableRef: null,
    sendCallback: (body) => {
      const ref = session._journalDurableRef;
      session._journalDurableRef = null;
      events.push(ref ? { body, message_ref: ref } : { body });
    },
    ...extra,
  };
  return { session, events };
}

describe('reply ref wiring (flushResponse)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('a reply that was never streamed is published under a fresh ref, and the session remembers it', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    expect(events).toHaveLength(1);
    expect(events[0].body).toBe('The fix is ready.');
    expect(events[0].message_ref).toMatch(UUID);
    expect(session._lastReplyRef).toBe(events[0].message_ref);
    expect(session._journalDurableRef).toBeNull();
  });

  it('a streamed reply keeps its overlay ref, and the session remembers that one', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A' });
    flushWith(session);
    expect(events).toEqual([{ body: 'The fix is ready.', message_ref: 'msg_A' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('a reply split into chunks carries the ref on its first chunk only', () => {
    const { session, events } = sessionWith({ _journalStreamRef: 'msg_A', responseBuffer: 'one two' });
    flushWith(session, { splitMessage: (text) => text.split(' ') });
    expect(events).toEqual([{ body: 'one', message_ref: 'msg_A' }, { body: 'two' }]);
    expect(session._lastReplyRef).toBe('msg_A');
  });

  it('each flush replaces the remembered ref: the last reply of the turn wins', () => {
    const { session, events } = sessionWith();
    flushWith(session);
    session.responseBuffer = 'Shall I deploy it?';
    flushWith(session);
    expect(events).toHaveLength(2);
    expect(events[1].message_ref).not.toBe(events[0].message_ref);
    expect(session._lastReplyRef).toBe(events[1].message_ref);
  });

  it('a callback that does not publish through sendToRoom leaves nothing armed and nothing remembered', () => {
    const received = [];
    const { session } = sessionWith({ _lastReplyRef: 'msg_OLD' });
    session.sendCallback = (body) => received.push(body);
    flushWith(session);
    expect(received).toEqual(['The fix is ready.']);
    expect(session._journalDurableRef).toBeNull();
    expect(session._lastReplyRef).toBeNull();
  });
});
