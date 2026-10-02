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
    const dispatch = fn.indexOf('const markDispatched = () => { if (!busyAtDispatch) noteTurnDispatch(session, skipJournalMirror ? turnOrigin : null); };');
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
    expect(index).toContain("withTurnRowStart(entry.session, entry.turnSeq, 'publishToolOutput', finalPayload),");
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

// The turn-end seams and the dispatch decision, run for real. A stub
// flushResponse publishes the turn's buffered text the way the real one does
// (through sendToRoom -> journalPublish), so the arm is taken or left exactly
// as it would be in the bridge.
function seamHarness() {
  const h = harness();
  const ctx = h.context;
  Object.assign(ctx, {
    debug: () => {},
    AGENT_CODEX: 'codex', DEFAULT_WORKDIR: '/work',
    inflightMarker: { noteTurnStart: vi.fn(), noteTurnEnd: vi.fn() },
    journalSessionState: vi.fn(), journalActivity: vi.fn(), journalStatus: vi.fn(),
    journalStreamClear: vi.fn(), maybeSummarizeAtTurnEnd: vi.fn(), clearPendingInterrupt: vi.fn(),
    refreshUsageLimits: () => null, extractTextContent: () => '', splitMessage: (t) => [t],
    escapeHtml: (t) => t, markdownToHtml: (t) => t,
    planItems: { opened: vi.fn(), resolved: vi.fn() },
    dispatchDeferredCommand: vi.fn(() => false), flushPendingSessionQueue: vi.fn(() => false), maybeFlushRoomDelivery: vi.fn(),
    flushResponse: (s) => {
      const text = s.responseBuffer;
      s.responseBuffer = '';
      if (text && text.trim()) ctx.sendToRoom(s.roomId, text, '');
    },
  });
  Object.assign(h.session, { busy: true, responseBuffer: '', toolCalls: [], totalUsage: {}, turnCount: 0 });
  const iv = fnSource('function createInteractiveSessionForRoom(').match(/ {2}session\.onTurnEnd = \(\) => \{[\s\S]*?\n {2}\};\n/);
  expect(iv, 'iv onTurnEnd not found').not.toBeNull();
  const handle = fnSource('function handleClaudeEvent(session, event) {');
  const resultStart = handle.indexOf("    case 'result': {");
  const resultEnd = handle.indexOf('\n      break;\n    }\n', handle.indexOf('maybeFlushRoomDelivery(session);', resultStart));
  expect(resultStart).toBeGreaterThan(-1);
  vm.runInContext([
    `function installIvTurnEnd(session) {\n${iv[0]}}`,
    `function printResult(session, event) {\n  switch (event.type) {\n${handle.slice(resultStart, resultEnd)}\n      break;\n    }\n  }\n}`,
    fnSource('function finishCodexTurn(session, {'),
  ].join('\n'), ctx);
  const seams = {
    iv: (s) => { ctx.installIvTurnEnd(s); s.onTurnEnd(); },
    print: (s) => ctx.printResult(s, { type: 'result' }),
    codex: (s) => { s._codexTurnFinished = false; ctx.finishCodexTurn(s); },
  };
  return { ...h, seams };
}

describe('turn-end seams drop an arm the turn never used (runs the real index.js code)', () => {
  for (const seam of ['iv', 'print', 'codex']) {
    it(`${seam}: an injected turn that published nothing leaves no marker for the next line`, () => {
      const h = seamHarness();
      markers.noteTurnDispatch(h.session, 'nudge');
      h.seams[seam](h.session);
      h.context.journalPublishNotice('convo', '🛠 Model switched', { notice: 'control' });
      expect(h.published.at(-1).payload).toEqual({ notice: 'control', body: '🛠 Model switched', from: 'assistant' });
    });

    it(`${seam}: the turn's own last row still takes its marker`, () => {
      const h = seamHarness();
      markers.noteTurnDispatch(h.session, 'reminder');
      h.session.responseBuffer = 'done';
      h.seams[seam](h.session);
      expect(h.published.map((e) => e.payload)).toEqual([{ body: 'done', from: 'assistant', turn_start: { origin: 'reminder' } }]);
    });

    it(`${seam}: an announced line whose turn never ran does not swallow the next same-origin turn`, () => {
      const h = seamHarness();
      markers.announceTurnStart(h.session, 'reminder');
      h.context.journalPublishNotice('convo', '⏰ Timer #1', { notice: 'control' });
      h.seams[seam](h.session);
      markers.noteTurnDispatch(h.session, 'reminder');
      h.context.sendToRoom('room', 'on it', '');
      expect(h.published.at(-1).payload).toEqual({ body: 'on it', from: 'assistant', turn_start: { origin: 'reminder' } });
    });

    it(`${seam}: a turn the seam itself dispatches keeps its marker`, () => {
      const h = seamHarness();
      markers.noteTurnDispatch(h.session, 'nudge');
      h.session.queuedMessages = [[{ type: 'text', text: 'queued' }]];
      h.context.flushPendingSessionQueue.mockImplementation((s) => { markers.noteTurnDispatch(s, 'item'); return true; });
      h.seams[seam](h.session);
      h.context.sendToRoom('room', 'reply', '');
      expect(h.published.at(-1).payload).toEqual({ body: 'reply', from: 'assistant', turn_start: { origin: 'item' } });
    });
  }

  it('the plan "build" write starts a user turn: it clears a stale arm and bumps the turn counter', async () => {
    const h = seamHarness();
    Object.assign(h.context, { hasToolResultInHistory: () => false, persistSession: vi.fn(),
      notice: (kind, plain, html) => ({ plain, html }) });
    vm.runInContext(fnSource('async function approvePlanBuild(session, { sendHtml }) {'), h.context);
    markers.noteTurnDispatch(h.session, 'nudge');
    const seq = markers.turnSeq(h.session);
    Object.assign(h.session, { busy: false, pendingPlanDenialId: 'tool-1', proc: { stdin: { write: vi.fn() } } });
    await h.context.approvePlanBuild(h.session, { sendHtml: (plain, html) => h.context.sendToRoom('room', plain, html) });
    expect(h.session.proc.stdin.write).toHaveBeenCalledTimes(1);
    expect(markers.turnSeq(h.session)).toBe(seq + 1);
    expect(h.published.at(-1).payload).toEqual({ body: '▶️ Building...', from: 'assistant' });
  });
});

describe('a spawn outcome (runs the real notifyParent)', () => {
  function notifyHarness() {
    const h = harness();
    const start = index.indexOf('notifyParent: ({ session, convoId, text }) => {');
    expect(start).toBeGreaterThan(-1);
    const arrow = index.slice(start + 'notifyParent: '.length, index.indexOf('\n  },', start) + 4);
    Object.assign(h.context, { NOTICE: markers.NOTICE, TURN_ORIGIN: markers.TURN_ORIGIN, JOURNAL_CONTROL_CONVO_ID: 'control',
      sessionOccupiedForRoomDelivery: (s) => !!s.busy, roomDelivery: { deliver: vi.fn() } });
    return { ...h, notifyParent: vm.runInContext(`(${arrow})`, h.context) };
  }

  it('into a parent that would take the turn, the outcome line opens it', () => {
    const h = notifyHarness();
    h.notifyParent({ session: h.session, convoId: 'convo', text: '✅ Spawned' });
    markers.noteTurnDispatch(h.session, 'spawn');
    h.context.sendToRoom('room', 'the helper is up', '');
    expect(h.published.map((e) => e.payload)).toEqual([
      { notice: 'control', body: '✅ Spawned', from: 'assistant', turn_start: { origin: 'spawn' } },
      { body: 'the helper is up', from: 'assistant' },
    ]);
  });

  it('into an auto-stopped parent, the line announces nothing, so the later spawn turn is still marked', () => {
    const h = notifyHarness();
    h.session._autoStopped = true;
    h.notifyParent({ session: h.session, convoId: 'convo', text: '✅ Spawned' });
    h.session._autoStopped = false;
    markers.noteTurnDispatch(h.session, 'spawn');
    h.context.sendToRoom('room', 'back, reading the outcome', '');
    expect(h.published.map((e) => e.payload)).toEqual([
      { notice: 'control', body: '✅ Spawned', from: 'assistant' },
      { body: 'back, reading the outcome', from: 'assistant', turn_start: { origin: 'spawn' } },
    ]);
  });
});

describe('a merged flush into a busy session starts no injected turn (runs the real sendToSession)', () => {
  function sendHarness(mode) {
    const h = seamHarness();
    Object.assign(h.context, {
      reportSessionSendFailure: vi.fn(() => false), isCompactCommand: () => false, codexInput: (b) => b,
      contentBlocksToCodexPrompt: () => 'prompt', contextFullToNative: () => null,
      applyPendingAgentHandoff: (s, blocks) => ({ blocks, pending: null }), commitDispatchedUserTurn: vi.fn(),
    });
    vm.runInContext(fnSource('function sendToSession(session, contentBlocks, { skipJournalMirror = false, turnOrigin = null } = {}) {'), h.context);
    if (mode === 'iv') h.session.iv = { sendText: vi.fn() };
    else h.session.proc = { stdin: { write: vi.fn() } };
    return h;
  }
  const item = () => markers.markTurnOrigin(markJournalOrigin([{ type: 'text', text: '📌 a reply on the item' }]), 'item');

  for (const mode of ['iv', 'print']) {
    it(`${mode}: "Send now" while a turn runs leaves the running turn unmarked`, () => {
      const h = sendHarness(mode);
      h.session.busy = true;
      expect(h.context.dispatchMergedFlush(h.session, [item()])).toBe(true);
      h.context.sendToRoom('room', 'still working on the earlier task', '');
      expect(h.published.at(-1).payload).toEqual({ body: 'still working on the earlier task', from: 'assistant' });
    });

    it(`${mode}: the same flush into an idle session opens the item turn`, () => {
      const h = sendHarness(mode);
      h.session.busy = false;
      expect(h.context.dispatchMergedFlush(h.session, [item()])).toBe(true);
      h.context.sendToRoom('room', 'replying to the item', '');
      expect(h.published.at(-1).payload).toEqual({ body: 'replying to the item', from: 'assistant', turn_start: { origin: 'item' } });
    });
  }

  for (const mode of ['iv', 'print']) {
    it(`${mode}: "Send now" while an injected turn runs keeps that turn's own marker`, () => {
      const h = sendHarness(mode);
      h.session.busy = true;
      markers.noteTurnDispatch(h.session, 'nudge');
      const seq = markers.turnSeq(h.session);
      expect(h.context.dispatchMergedFlush(h.session, [item()])).toBe(true);
      expect(markers.turnSeq(h.session)).toBe(seq);
      h.context.sendToRoom('room', 'flagging the unseen items', '');
      expect(h.published.at(-1).payload).toEqual({ body: 'flagging the unseen items', from: 'assistant', turn_start: { origin: 'nudge' } });
    });
  }

  it('a mirrored continuation sent into a busy session is a plain user row', () => {
    const h = sendHarness('print');
    h.session.busy = true;
    const continuation = markers.markTurnOrigin([{ type: 'text', text: 'carry on with X' }], 'carry_on');
    expect(h.context.dispatchMergedFlush(h.session, [continuation])).toBe(true);
    expect(h.published.at(-1).payload).toEqual({ body: 'carry on with X', from: 'user' });
  });
});

describe('a tool output still finalizing at turn end keeps its turn marker (runs the real finalize)', () => {
  function finalizeHarness() {
    const h = seamHarness();
    let release;
    const finalized = [];
    h.publisher.finalizeToolOutput = vi.fn((convoId, ref, payload) => {
      if (h.failFinalize) throw new Error('journal down');
      finalized.push(payload);
    });
    Object.assign(h.context, {
      fs: { promises: { stat: () => Promise.reject(new Error('no log')) } },
      toolStreamPumps: new Map(), TOOL_LOG_UPLOAD_MAX_BYTES: 1024, TOOL_SNIPPET_READ_BYTES: 256,
      toolOutputSnippet: (t) => t, decodeByteExact: () => ({ text: '' }),
    });
    vm.runInContext(fnSource('function finalizeToolStreamEntry(key, entry, { exitCode = null, denied = false, truncated = false } = {}) {'), h.context);
    const start = () => {
      const entry = { pump: { stop: vi.fn(), flushFinal: () => new Promise((r) => { release = r; }) },
        session: h.session, turnSeq: markers.turnSeq(h.session), convoId: 'convo', command: 'npm test', logPath: '/nope', messageRef: 'tool-1' };
      h.context.finalizeToolStreamEntry('k', entry, { exitCode: 0 });
    };
    return { ...h, finalized, start, release: async () => { release(); await new Promise((r) => setTimeout(r, 0)); } };
  }

  it('the late row takes the marker, and nothing published after it does', async () => {
    const h = finalizeHarness();
    markers.noteTurnDispatch(h.session, 'nudge');
    h.start();
    h.seams.print(h.session);
    await h.release();
    expect(h.finalized[0].turn_start).toEqual({ origin: 'nudge' });
    h.context.journalPublishNotice('convo', '🛠 Model switched', { notice: 'control' });
    expect(h.published.at(-1).payload.turn_start).toBeUndefined();
  });

  it('a line published between the turn end and the late row does not take its marker', async () => {
    const h = finalizeHarness();
    markers.noteTurnDispatch(h.session, 'nudge');
    h.start();
    h.seams.print(h.session);
    h.context.journalPublishNotice('convo', '📬 Sending your queued message', { notice: 'control' });
    await h.release();
    expect(h.published.at(-1).payload.turn_start).toBeUndefined();
    expect(h.finalized[0].turn_start).toEqual({ origin: 'nudge' });
  });

  it('a late row whose turn was followed by a new dispatch takes nothing', async () => {
    const h = finalizeHarness();
    markers.noteTurnDispatch(h.session, 'nudge');
    h.start();
    h.seams.print(h.session);
    markers.noteTurnDispatch(h.session, 'item');
    await h.release();
    expect(h.finalized[0].turn_start).toBeUndefined();
    h.context.sendToRoom('room', 'on the item', '');
    expect(h.published.at(-1).payload.turn_start).toEqual({ origin: 'item' });
  });

  it('a reminder line announced before the late row lands keeps the boundaries in order', async () => {
    const h = finalizeHarness();
    markers.noteTurnDispatch(h.session, 'nudge');
    h.start();
    h.seams.print(h.session);
    h.context.journalPublishSessionNotice(h.session, '⏰ Reminder #3', { notice: 'control', turnOrigin: 'reminder' });
    await h.release();
    expect(h.published.at(-1).payload.turn_start).toEqual({ origin: 'reminder' });
    expect(h.finalized[0].turn_start).toBeUndefined();
  });

  it('a finalize that fails still drops the marker once it is done', async () => {
    const h = finalizeHarness();
    h.failFinalize = true;
    markers.noteTurnDispatch(h.session, 'nudge');
    h.start();
    h.seams.print(h.session);
    await h.release();
    h.context.journalPublishNotice('convo', '🛠 Model switched', { notice: 'control' });
    expect(h.published.at(-1).payload.turn_start).toBeUndefined();
  });
});
