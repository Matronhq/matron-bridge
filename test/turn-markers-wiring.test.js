import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';
import * as markers from '../lib/turn-markers.js';
import { markJournalOrigin, planQueueFlush } from '../lib/queue-flush.js';

// index.js cannot be imported in-process (it boots the bridge), so the seams
// that carry payload.notice / payload.turn_start are exercised two ways: the
// small publish-path functions run for real inside a vm context with fakes
// around them, and each emit site is pinned by source inspection.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const codexWiring = readFileSync(new URL('../lib/codex-app-wiring.js', import.meta.url), 'utf8');

function fnSource(signature) {
  const start = index.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  return index.slice(start, index.indexOf('\n}\n', start) + 2);
}
function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

function harness() {
  const published = [];
  const publisher = {
    publishText: vi.fn((convoId, payload) => published.push({ convoId, method: 'publishText', payload })),
    publishDiff: vi.fn((convoId, payload) => published.push({ convoId, method: 'publishDiff', payload })),
    upsertConvo: vi.fn(),
    markRead: vi.fn(),
    endStream: vi.fn(),
  };
  const sessions = new Map();
  const context = vm.createContext({
    ...markers,
    markJournalOrigin, planQueueFlush,
    JOURNAL_ENABLED: true,
    journalPublisher: publisher,
    sessions,
    console,
    journalConvoIdFor: (s) => s?.claudeSessionId || null,
    findSessionByClaudeSessionId: (id) => [...sessions.values()].find((s) => s.claudeSessionId === id) || null,
    journalBufferPush: vi.fn(),
    sendToSession: vi.fn(() => true),
    pendingMediaMirror: () => [],
    journalMirrorUserMedia: vi.fn(),
  });
  vm.runInContext([
    'function journalPublish(session, method, payload, options) {',
    'const journalNoticeByRoom = new Map();',
    'function withJournalNotice(roomId, kind, send) {',
    'async function sendToRoom(roomId, text, html, { skipJournalMirror = false } = {}) {',
    'function journalPublishNotice(convoId, body, extra) {',
    'function journalPublishSessionNotice(session, body, { notice, turnOrigin } = {}) {',
    'function journalPublishUserItem(session, method, payload) {',
    'function dispatchMergedFlush(session, queued) {',
  ].map((sig) => (sig.startsWith('const ') ? sig : fnSource(sig))).join('\n'), context);
  const session = { roomId: 'room', claudeSessionId: 'convo', alive: true, _journalConvoEstablished: true };
  sessions.set('room', session);
  return { context, publisher, published, session };
}

describe('publish path (runs the real index.js functions)', () => {
  it('a notice sent under withJournalNotice carries payload.notice; the next send does not', () => {
    const h = harness();
    h.context.withJournalNotice('room', 'compaction', () => h.context.sendToRoom('room', '🗜️ Context compacted', ''));
    h.context.sendToRoom('room', 'agent reply', '');
    expect(h.published.map((e) => e.payload)).toEqual([
      { body: '🗜️ Context compacted', from: 'assistant', notice: 'compaction' },
      { body: 'agent reply', from: 'assistant' },
    ]);
  });

  it('a send that never reaches sendToRoom leaves no class behind for a later line', () => {
    const h = harness();
    h.context.withJournalNotice('room', 'slow_tool', () => {});
    h.context.sendToRoom('room', 'agent reply', '');
    expect(h.published[0].payload).toEqual({ body: 'agent reply', from: 'assistant' });
  });

  it('the first event of an injected turn carries turn_start, whatever its type', () => {
    const h = harness();
    markers.noteTurnDispatch(h.session, 'peer');
    h.context.journalPublish(h.session, 'publishDiff', { file_path: '/a', from: 'assistant' });
    h.context.sendToRoom('room', 'done', '');
    expect(h.published.map((e) => e.payload)).toEqual([
      { file_path: '/a', from: 'assistant', turn_start: { origin: 'peer' } },
      { body: 'done', from: 'assistant' },
    ]);
  });

  it('a session notice announces the turn only when the session is free', () => {
    const h = harness();
    h.context.journalPublishSessionNotice(h.session, '⏰ Reminder #1', { notice: 'control', turnOrigin: 'reminder' });
    markers.noteTurnDispatch(h.session, 'reminder');
    h.context.sendToRoom('room', 'on it', '');
    h.session.busy = true;
    h.context.journalPublishSessionNotice(h.session, '⏰ Reminder #2', { notice: 'control', turnOrigin: 'reminder' });
    expect(h.published.map((e) => e.payload)).toEqual([
      { notice: 'control', body: '⏰ Reminder #1', from: 'assistant', turn_start: { origin: 'reminder' } },
      { body: 'on it', from: 'assistant' },
      { notice: 'control', body: '⏰ Reminder #2', from: 'assistant' },
    ]);
  });

  it('a bare convo notice into a live session takes a pending turn_start like any event', () => {
    const h = harness();
    markers.noteTurnDispatch(h.session, 'nudge');
    h.context.journalPublishNotice('convo', '⏳ Still working', { notice: 'slow_tool' });
    h.context.journalPublishNotice('control-convo', 'unrelated');
    h.context.sendToRoom('room', 'reply', '');
    expect(h.published.map((e) => e.payload)).toEqual([
      { notice: 'slow_tool', body: '⏳ Still working', from: 'assistant', turn_start: { origin: 'nudge' } },
      { body: 'unrelated', from: 'assistant' },
      { body: 'reply', from: 'assistant' },
    ]);
  });

  it('a merged flush of injected entries dispatches with their origin', () => {
    const h = harness();
    const nudge = markers.markTurnOrigin(markJournalOrigin([{ type: 'text', text: 'nudge' }]), 'nudge');
    const peer = markers.markTurnOrigin(markJournalOrigin([{ type: 'text', text: 'room' }]), 'peer');
    expect(h.context.dispatchMergedFlush(h.session, [nudge, peer])).toBe(true);
    expect(h.context.sendToSession.mock.calls[0][2]).toEqual({ skipJournalMirror: true, turnOrigin: 'nudge' });
  });

  it('one user message in the batch makes it the user turn', () => {
    const h = harness();
    const nudge = markers.markTurnOrigin(markJournalOrigin([{ type: 'text', text: 'nudge' }]), 'nudge');
    const typed = markJournalOrigin([{ type: 'text', text: 'typed in Matron' }]);
    h.context.dispatchMergedFlush(h.session, [nudge, typed]);
    expect(h.context.sendToSession.mock.calls[0][2]).toEqual({ skipJournalMirror: true, turnOrigin: null });
  });

  it('a mirrored injected batch puts turn_start on the mirrored user row itself', () => {
    const h = harness();
    const continuation = markers.markTurnOrigin([{ type: 'text', text: 'carry on with X' }], 'carry_on');
    h.context.dispatchMergedFlush(h.session, [continuation]);
    expect(h.context.sendToSession.mock.calls[0][2]).toEqual({ skipJournalMirror: true, turnOrigin: null });
    expect(h.published[0].payload).toEqual({ body: 'carry on with X', from: 'user', turn_start: { origin: 'carry_on' } });
  });
});

describe('dispatch and queue seams (source inspection)', () => {
  it('sendToSession decides the arm at the one real dispatch point, after the resume hold', () => {
    const fn = body('function sendToSession(session, contentBlocks, { skipJournalMirror = false, turnOrigin = null } = {}) {', '\nfunction sendTextToSession(');
    const hold = fn.indexOf('(session._resumeOutbox ||= []).push(skipJournalMirror ? markTurnOrigin(markJournalOrigin(contentBlocks), turnOrigin) : contentBlocks);');
    const dispatch = fn.indexOf('const markDispatched = () => noteTurnDispatch(session, skipJournalMirror ? turnOrigin : null);');
    expect(hold).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(hold);
    // Armed only on an accepted send (Codex accepted, PTY typed, stdin written)...
    expect((fn.match(/markDispatched\(\);/g) || [])).toHaveLength(3);
    expect(fn).toMatch(/if \(sent\) \{\s*\n\s*markDispatched\(\);/);
    expect(fn).toMatch(/session\.iv\.sendText\(text\);\s*\n\s*markDispatched\(\);/);
    expect(fn).toMatch(/markDispatched\(\);\s*\n\s*commitDispatchedUserTurn\(session, historyText, preparedHandoff\.pending\);\s*\n\s*if \(session\.resetTimeout\) session\.resetTimeout\(\);\s*\n\s*return true;\s*\n\}/);
    // ...and every refusal past that point clears it before its failure line.
    expect((fn.match(/noteTurnDispatch\(session, null\);\s*\n(\s*const detail[^\n]*\n)?[\s\S]{0,400}?reportSessionSendFailure\(/g) || []).length).toBe(3);
  });
  it('journalPublish marks the first event of the turn, buffered or not', () => {
    const fn = body('function journalPublish(session, method, payload, options) {', '\n}\n');
    expect(fn.indexOf('payload = withTurnStart(session, method, payload);')).toBeLessThan(fn.indexOf('const convoId = journalConvoIdFor(session);'));
  });
  it('queued and routed injections carry their origin to the eventual dispatch', () => {
    expect(index).toContain('if (!mirrorToJournal) markTurnOrigin(markJournalOrigin(entry), turnOrigin);');
    const route = body('async function journalRouteTextToSession(session, body, { turnOrigin = null } = {}) {', '\n// prompt_reply -> pending prompt.');
    expect(route).toContain('markTurnOrigin(entry, turnOrigin);');
    expect(route).toContain('sendTextToSession(session, trimmed, { skipJournalMirror: true, turnOrigin });');
  });
  it('the 📬 turn-end flush opens an all-injected batch, and is a control notice', () => {
    const fn = body('function flushPendingSessionQueue(session) {', '\n}\n');
    expect(fn).toContain('const injectedOrigin = flushCanSend && !planQueueFlush(queued).mirrorText ? mergedTurnOrigin(queued) : null;');
    expect(fn).toContain("&& !(typeof session._deferredCommandText === 'string' && session._deferredCommandText.startsWith('!restart'));");
    expect(fn).toContain('if (injectedOrigin) announceTurnStart(session, injectedOrigin);');
    expect(fn).toContain('withJournalNotice(session.roomId, NOTICE.CONTROL, () => {');
  });
});

describe('injection sites name their origin (source inspection)', () => {
  it('session control: the now/applied line follows the accepted turn and takes its marker; parked, scheduled and refused lines do not', () => {
    const fn = body('async function journalControlSession(rawParams, { fromDeviceId } = {}) {', '\nasync function applyControlSteps(');
    const apply = fn.indexOf('const r = await applyControlSteps(session, plan.steps, { turnOrigin });');
    const before = fn.indexOf('if (!turnOrigin) postControlNotice(session, nowLine);');
    const after = fn.indexOf('if (turnOrigin && r.ok) postControlNotice(sessions.get(session.roomId) || session, nowLine);');
    expect(apply).toBeGreaterThan(-1);
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(apply);
    expect(after).toBeGreaterThan(apply);
    expect(fn).toContain("postControlNotice(session, controlNotice(params, { phase: 'deferred', agent: session.agent }));");
    expect(fn).toContain("postControlNotice(session, controlNotice(params, { phase: 'scheduled', resetsAt: plan.at, agent: session.agent }));");
    const drain = body('function drainDeferredControls(session) {', '\n}\n');
    const dApply = drain.indexOf('const r = await applyControlSteps(current, plan.steps, { turnOrigin });');
    const dBefore = drain.indexOf('if (!turnOrigin) postControlNotice(current, appliedLine);');
    const dAfter = drain.indexOf('if (turnOrigin && r.ok) postControlNotice(current, appliedLine);');
    expect(dApply).toBeGreaterThan(-1);
    expect(dBefore).toBeGreaterThan(-1);
    expect(dBefore).toBeLessThan(dApply);
    expect(dAfter).toBeGreaterThan(dApply);
    const post = body('function postControlNotice(session, text, { turnOrigin = null } = {}) {', '\n}\n');
    expect(post).toContain('if (turnOrigin && canAnnounceTurn(session)) announceTurnStart(session, turnOrigin);');
    expect(post).toContain('withJournalNotice(session.roomId, NOTICE.CONTROL, () => session.sendHtml(n.plain, n.html));');
  });
  it('timers and reminders', () => {
    const fn = body('async function fireTimer(record) {', '\n}\n');
    // A command-shaped timer may run no turn at all, so its line does not announce one.
    expect(fn).toContain("const commandShaped = /^[!/]/.test(String(record.text ?? '').trim());");
    expect(fn).toContain('{ notice: NOTICE.CONTROL, turnOrigin: commandShaped ? null : TURN_ORIGIN.REMINDER });');
    expect(fn).toContain('{ notice: NOTICE.CONTROL, turnOrigin: TURN_ORIGIN.REMINDER });');
    expect((fn.match(/journalPublishSessionNotice\(session, /g) || [])).toHaveLength(2);
    expect((fn.match(/\{ turnOrigin: TURN_ORIGIN\.REMINDER \}\);/g) || [])).toHaveLength(2);
    expect(fn).toContain('{ notice: NOTICE.DELIVERY_FAILED });');
  });
  it('restart carry-on card, items, secrets, spawns and rooms', () => {
    expect(index).toContain("await journalRouteTextToSession(target, 'carry on', { turnOrigin: TURN_ORIGIN.CARRY_ON });");
    expect(index).toContain('injectBlocks: (session, blocks) => sendToSession(session, blocks, { skipJournalMirror: true, turnOrigin: TURN_ORIGIN.ITEM }),');
    expect(index).toContain('turnOrigin: TURN_ORIGIN.ITEM,');
    expect(index).toContain("inject: (session, text) => sendToSession(session, [{ type: 'text', text }], { skipJournalMirror: true, turnOrigin: TURN_ORIGIN.SECRET }),");
    expect(index).toContain('turnOrigin: TURN_ORIGIN.SECRET,');
    expect(index).toContain('injectTurn: (session, text, roomIds) => sendTextToSession(session, text, { skipJournalMirror: true, turnOrigin: roomTurnOrigin(roomIds) }),');
    expect(index).toContain('const entry = markTurnOrigin([{ type: \'text\', text }], TURN_ORIGIN.CARRY_ON);');
  });
  it('a spawn outcome is a spawn turn, any other room delivery a peer turn', () => {
    const fn = body('function roomTurnOrigin(roomIds) {', '\n}\n');
    const ctx = vm.createContext({ TURN_ORIGIN: markers.TURN_ORIGIN });
    vm.runInContext(`${fn}\n}`, ctx);
    expect(ctx.roomTurnOrigin(['spawn'])).toBe('spawn');
    expect(ctx.roomTurnOrigin(['spawn', 'room-1'])).toBe('peer');
    expect(ctx.roomTurnOrigin(['room-1'])).toBe('peer');
    expect(ctx.roomTurnOrigin(undefined)).toBe('peer');
  });
  it('room lines: 💬 opens an idle turn, ⏳ is a control line, 📨 takes the flushed turn', () => {
    expect(index).toContain('{ turnOrigin: sessionOccupiedForRoomDelivery(session) ? null : TURN_ORIGIN.PEER });');
    expect(index).toContain('journalPublishSessionNotice(session, ROOM_MESSAGE_QUEUED_NOTICE, { notice: NOTICE.CONTROL });');
    const gate = body('function flushRoomInbox(session) {', '\n}\n');
    expect(gate).toContain('{ notice: flushed ? NOTICE.CONTROL : NOTICE.DELIVERY_FAILED });');
    expect(gate.indexOf('roomDelivery.flush(session, session.roomId)')).toBeLessThan(gate.indexOf('journalPublishSessionNotice(session,'));
  });
});

describe('notice classes at their emit sites (source inspection)', () => {
  it('compaction, restart, crash restart and slow tool', () => {
    expect((index.match(/withJournalNotice\(session\.roomId, NOTICE\.COMPACTION, /g) || [])).toHaveLength(3);
    expect(index).toContain('await withJournalNotice(roomId, NOTICE.RESTART, () => sendReply(');
    expect(index).toContain('withJournalNotice(session.roomId, NOTICE.RESTART, () => {');
    expect(index).toContain('withJournalNotice(roomId, NOTICE.CRASH_RESTART, () => {');
    expect(index).toContain('withJournalNotice(restarted.roomId, NOTICE.CRASH_RESTART, () => {');
    expect(index).toContain('withJournalNotice(session.roomId, NOTICE.SLOW_TOOL, () => session.sendCallback(renderSlowToolNotice({ toolName, elapsedMs, reminder })));');
  });
  it('a Claude tool output finalized late only marks the turn that ran it', () => {
    expect(index).toContain('turnSeq: turnSeq(session),');
    expect(index).toContain("entry.turnSeq === turnSeq(entry.session) ? withTurnStart(entry.session, 'publishToolOutput', finalPayload) : finalPayload,");
  });

  it('Claude compaction start (PreCompact hook) is a compaction notice', () => {
    expect(index).toContain('withJournalNotice(target.roomId, NOTICE.COMPACTION, () => {');
  });
  it('the Codex wiring publishes parent rows through the turn-marked publisher', () => {
    expect(index).toContain('publisher: turnMarkedPublisher(session), convoIdFor: journalConvoIdFor, runningStore: subagentRunningStore,');
    const fn = body('function turnMarkedPublisher(owner) {', '\n}\n');
    const published = [];
    const journalPublisher = {
      publishDiff: (convoId, payload) => published.push([convoId, payload]),
      publishText: (convoId, payload) => published.push([convoId, payload]),
      upsertConvo: () => 'inherited',
    };
    const session = { claudeSessionId: 'parent' };
    let live = session;
    const ctx = vm.createContext({ journalPublisher, withTurnStart: markers.withTurnStart,
      findSessionByClaudeSessionId: (id) => (id === 'parent' ? live : null) });
    vm.runInContext(`${fn}\n}`, ctx);
    const p = ctx.turnMarkedPublisher(session);
    // A row of a session the convo has since replaced (agent switch) never takes the new session's marker.
    const replacement = { claudeSessionId: 'parent' };
    live = replacement;
    markers.noteTurnDispatch(replacement, 'peer');
    p.publishText('parent', { body: 'stale', from: 'assistant' });
    expect(markers.takeTurnStart(replacement)).toEqual({ origin: 'peer' });
    live = session;
    expect(published.splice(0)).toEqual([['parent', { body: 'stale', from: 'assistant' }]]);
    markers.noteTurnDispatch(session, 'secret');
    // A silent command finalized as the turn's first row takes the marker...
    session.codex = { finishedTurns: new Set(['old-turn']) };
    journalPublisher.finalizeToolOutput = (convoId, ref, payload) => published.push([convoId, payload]);
    p.finalizeToolOutput('parent', 'codex:th:old-turn:i1', { message_ref: 'late' }, null);
    p.finalizeToolOutput('parent', 'codex:th:cur-turn:i2', { message_ref: 'first' }, null);
    expect(published.splice(0)).toEqual([
      ['parent', { message_ref: 'late' }],
      ['parent', { message_ref: 'first', turn_start: { origin: 'secret' } }],
    ]);
    // ...and a later row of the same turn does not.
    markers.noteTurnDispatch(session, 'secret');
    p.publishText('child', { body: 'subagent', from: 'assistant' });
    p.publishDiff('parent', { file_path: '/x', from: 'assistant' });
    p.publishText('parent', { body: 'done', from: 'assistant' });
    expect(published).toEqual([
      ['child', { body: 'subagent', from: 'assistant' }],
      ['parent', { file_path: '/x', from: 'assistant', turn_start: { origin: 'secret' } }],
      ['parent', { body: 'done', from: 'assistant' }],
    ]);
    expect(p.upsertConvo()).toBe('inherited');
  });

  it('a native Codex control routed for an injected turn keeps its origin', () => {
    expect(index).toContain('function runCodexControl(session, text, reply, { turnOrigin = null } = {}) {');
    expect(index).toContain('send: body => sendTextToSession(session, body, { skipJournalMirror: true, turnOrigin }),');
    expect(index).toContain("await runCodexControl(session, trimmed, undefined, { turnOrigin })) return;");
  });
  it('Codex compaction and slow-tool lines pass their class through the notice seam', () => {
    expect(codexWiring).toContain("notice(session, '🗜️ Compacting context — summarizing conversation history…', NOTICE.COMPACTION);");
    expect(codexWiring).toContain("notice(session, '✅ Context compacted — conversation history summarized.', NOTICE.COMPACTION);");
    expect(codexWiring).toContain("renderSlowToolNotice(event).replace('send \"interrupt\"', 'send !esc'), NOTICE.SLOW_TOOL);");
    expect(index).toContain('notice: (s, message, kind) => journalPublishNotice(journalConvoIdFor(s), message, kind ? { notice: kind } : undefined),');
  });
  it('undelivered queued messages and session-control results', () => {
    expect(index).toMatch(/the session ended before it was sent\.",\s*\n\s*\{ notice: NOTICE\.DELIVERY_FAILED \}\);/);
    expect(index).toContain('notify: (convoId, text) => journalPublishNotice(convoId, text, { notice: NOTICE.CONTROL }),');
  });
});
