// Bridge-originated turns (timers, reminders, carry-ons, auto-resume, wake,
// pre-reap compact, control compact) that land while a session is busy join
// the queue like any other message, but must never raise the "Send this
// queued message now?" card: that card is only for text a person typed.
//
// The real functions are lifted out of index.js and run in a vm context with
// stubbed collaborators, the same idiom as test/claude-steer-wiring.test.js.
// notifyQueuedMessage is the REAL one, so "no card" means the session's
// sendButtonMessage / sendReply were never called and the release registry
// was never told about a card.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { notifyQueuedMessage } from '../lib/busy-queue.js';
import { isBridgeOrigin, markBridgeOrigin, markJournalOrigin } from '../lib/queue-flush.js';
import { tagCauses, mergeCauses, plainCause } from '../lib/turn-cause.js';
import { hasQueuedCompact, isCompactCommand } from '../lib/compact-priority.js';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function sourceOf(name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start === -1) start = source.indexOf(`\nasync function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in index.js`);
  start += 1;
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}

const LIFTED = [
  'journalRouteTextToSession', 'fireTimer', 'carryOnConvo', 'fireAutoResume',
  'drainPreReapCompact', 'requeueSteeredMessages',
];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'new', 'await', 'async', 'super']);

function setup({ busy = true } = {}) {
  const lifted = LIFTED.map(sourceOf).join('\n');
  const session = {
    agent: 'claude', alive: true, busy, roomId: 'room', queuedMessages: null, queueNotifications: [],
    sendButtonMessage: vi.fn(async () => 'event-id'),
  };
  const sendReply = vi.fn(async () => 'event-id');
  const queueRelease = { noteQueued: vi.fn() };
  const explicit = {
    console: { log() {}, warn() {}, error() {} },
    Date, JSON, Map, Set, Promise, Math, Number, String, Object, Array, Boolean, Error,
    setTimeout, clearTimeout,
    AGENT_CODEX: 'codex',
    randomUUID: undefined,
    sessions: new Map([['room', session]]),
    notifyQueuedMessage,
    markJournalOrigin, markBridgeOrigin, isBridgeOrigin, tagCauses, mergeCauses, plainCause, hasQueuedCompact, isCompactCommand,
    requeuedSteerAt: new WeakMap(),
    journalInputConsumer: { queueRelease },
    journalConvoIdFor: () => 'convo',
    journalSessionCommandCtx: () => ({ sendReply, sendHtml: vi.fn(), sender: 'user' }),
    findSessionByClaudeSessionId: (id) => (id === 'convo' ? session : null),
    journalResumeConvo: () => null,
    accountLock: { hold: () => false },
    dispatchJournalBridgeCommand: vi.fn(async () => false),
    dispatchPlanBuild: vi.fn(async () => false),
    dispatchJournalRescueKeystroke: vi.fn(async () => false),
    dispatchBusyQueueMagicWord: vi.fn(async () => false),
    runCodexControl: vi.fn(async () => false),
    effortFlowHoldsInput: () => false,
    isIvSlashPassthrough: () => false,
    trySteerEntry: vi.fn(() => false),
    // Idle delivery: the turn starts, so the session is busy afterwards.
    sendTextToSession: vi.fn((s) => { s.busy = true; return true; }),
    formatTimerDuration: () => '1m',
    frameSafeBody: (t) => t,
    noticeMeta: () => null,
    controlOccupied: () => false,
    shouldCompactBefore: () => false,
    contextWindowForSession: () => 200000,
    preReapCompactCommand: () => '/compact',
    carryOnCause: () => plainCause('other'),
    AUTO_RESUME_TEXT: 'carry on',
    BAD_MODEL_RECOVERY_TEXT: 'recover',
    CLAUDE_STEER_ENABLED: false,
    escapeHtml: (t) => t, formatQueueSummary: vi.fn(), clearQueueNotifications: vi.fn(), emitRelease: vi.fn(), pendingFlushBatch: () => [], queueReleaseForBatch: () => null,
    QUEUE_EDIT_HOLD_MS: 60000,
    debug: () => {},
  };
  const context = { ...explicit };
  for (const [, name] of lifted.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (KEYWORDS.has(name) || name in context || LIFTED.includes(name)) continue;
    context[name] = vi.fn();
  }
  vm.createContext(context);
  vm.runInContext(lifted, context);
  return { session, context, sendReply, queueRelease };
}

// The card is a journal prompt (sendButtonMessage, the queued_release
// payload) or, without one, a plain reply; either way the registry hears of it.
function expectNoCard(h) {
  expect(h.session.sendButtonMessage).not.toHaveBeenCalled();
  expect(h.sendReply).not.toHaveBeenCalled();
  expect(h.queueRelease.noteQueued).not.toHaveBeenCalled();
}

// Queue and notification arrays move in lockstep, card or not: cancel and
// send_one address the queue by notification index.
function expectLockstep(h, expectedLength) {
  expect(h.session.queuedMessages).toHaveLength(expectedLength);
  expect(h.session.queueNotifications).toHaveLength(expectedLength);
}

const texts = (session) => session.queuedMessages.map((blocks) => blocks.map((b) => b.text).join(''));

describe('user-typed text still raises the card', () => {
  it('queues a typed message on a busy session with a queued_release card', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'please also check the logs');
    expect(texts(h.session)).toEqual(['please also check the logs']);
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    const payload = h.session.sendButtonMessage.mock.calls[0][5];
    expect(payload.kind).toBe('queued_release');
    expect(payload.question).toBe('Send this queued message now, or cancel it?');
    expectLockstep(h, 1);
  });

  it('still raises it for a typed message that follows a bridge turn', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'carry on', { bridgeOrigin: true });
    await h.context.journalRouteTextToSession(h.session, 'typed by a person');
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expect(h.session.sendButtonMessage.mock.calls[0][5].body).toContain('typed by a person');
    expectLockstep(h, 2);
  });
});

describe('bridge-originated injection paths raise no card', () => {
  it('journalRouteTextToSession with bridgeOrigin', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'ping', { bridgeOrigin: true });
    expect(texts(h.session)).toEqual(['ping']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a bridge text that spells a queue magic word is queued, not run as one', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'cancel', { bridgeOrigin: true });
    expect(h.context.dispatchBusyQueueMagicWord).not.toHaveBeenCalled();
    expect(texts(h.session)).toEqual(['cancel']);
  });

  it('a bridge /compact queued behind a typed message jumps the queue silently', async () => {
    const h = setup();
    await h.context.journalRouteTextToSession(h.session, 'typed');
    h.session.sendButtonMessage.mockClear();
    await h.context.journalRouteTextToSession(h.session, '/compact', { bridgeOrigin: true });
    expect(texts(h.session)).toEqual(['/compact', 'typed']);
    expect(h.session.sendButtonMessage).not.toHaveBeenCalled();
    expectLockstep(h, 2);
  });

  it('/timer fire', async () => {
    const h = setup();
    await h.context.fireTimer({ id: 1, convoId: 'convo', text: 'stand-up notes', createdAt: Date.now() });
    expect(texts(h.session)).toEqual(['stand-up notes']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('agent reminder fire', async () => {
    const h = setup();
    await h.context.fireTimer({ id: 2, convoId: 'convo', text: 'check the build', source: 'agent', createdAt: Date.now() });
    expect(h.session.queuedMessages).toHaveLength(1);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('crash-recovery and code-update carry-on (carryOnConvo)', async () => {
    const h = setup();
    await h.context.carryOnConvo('convo', h.session, null, 'carry on');
    expect(texts(h.session)).toEqual(['carry on']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('after-limit-reset carry-on whose preceding /compact started a turn', async () => {
    const h = setup({ busy: false });
    h.context.shouldCompactBefore = () => true;
    await h.context.fireAutoResume('room', 'convo', { kind: 'limit', text: 'carry on', source: 'coordinator' });
    // /compact went to the idle session and started a turn; the carry-on then
    // arrived while it was busy.
    expect(texts(h.session)).toEqual(['carry on']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('pre-reap handoff compact', async () => {
    const h = setup();
    h.session._preReapHandoff = { compactPending: true };
    h.context.drainPreReapCompact(h.session);
    await new Promise((r) => setTimeout(r, 0));
    expect(texts(h.session)).toEqual(['/compact']);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a steered bridge message restored to the queue', async () => {
    const h = setup();
    const blocks = [{ type: 'text', text: 'Reminder: check progress' }];
    markBridgeOrigin(blocks);
    h.context.requeueSteeredMessages(h.session, [{ queuedEntries: [blocks], at: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.queuedMessages).toHaveLength(1);
    expectNoCard(h);
    expectLockstep(h, 1);
  });

  it('a steered typed message restored to the queue keeps its card', async () => {
    const h = setup();
    h.context.requeueSteeredMessages(h.session, [{ queuedEntries: [[{ type: 'text', text: 'typed' }]], at: 1 }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.session.sendButtonMessage).toHaveBeenCalledTimes(1);
    expectLockstep(h, 1);
  });
});

// Callers not liftable into the harness: pin that they declare bridge origin.
describe('bridge injection callers declare bridgeOrigin', () => {
  const callOf = (needle) => {
    const at = source.indexOf(needle);
    expect(at, `${needle} not found in index.js`).toBeGreaterThan(-1);
    return source.slice(at, at + 260);
  };
  it.each([
    ['wake route', 'routeText: (session, t) => journalRouteTextToSession('],
    ['control compact step', "journalRouteTextToSession(current, step.command || '/compact'"],
    ['limit-reset compact', "await journalRouteTextToSession(session, '/compact'"],
    ['limit-reset carry-on', 'await journalRouteTextToSession(sessions.get(roomId) || session'],
    ['pre-reap compact', 'journalRouteTextToSession(session, preReapCompactCommand()'],
    ['carryOnConvo', 'await journalRouteTextToSession(target, text'],
    ['timer text', 'await journalRouteTextToSession(session, record.text'],
    ['agent reminder', 'await journalRouteTextToSession(session,\n      `⏰ Reminder'],
  ])('%s', (_name, needle) => {
    expect(callOf(needle)).toContain('bridgeOrigin: true');
  });
});
