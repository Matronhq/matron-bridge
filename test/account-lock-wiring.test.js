import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level side effects), so the
// account lock's wiring is pinned by source inspection, as the other
// *-wiring tests do. The lock itself and each path's refusal are unit-tested
// in test/account-lock.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('account lock wiring', () => {
  it('the journal feeds it: hello_ok and live panic frames, and nothing else clears it', () => {
    expect(index).toMatch(/onPanic: \(panic, \{ hello \}\) => \(hello \? accountLock\.onHello\(panic\) : accountLock\.onFrame\(panic\)\)/);
    const feeds = index.match(/accountLock\.(onHello|onFrame)\(/g) || [];
    expect(feeds).toHaveLength(2);
  });

  it('locking interrupts every running turn and tells each affected conversation once', () => {
    const stop = body('function stopTurnsForAccountLock()', '\n}\n');
    expect(stop).toMatch(/for \(const session of sessions\.values\(\)\)/);
    expect(stop).toMatch(/printModeInterrupt\(session/);
    expect(stop).toMatch(/sendKeystroke\('esc'\)/);
    expect(stop).toMatch(/noticeAccountLocked\(/);
    const notice = body('function noticeAccountLocked(', '\n}\n');
    expect(notice).toMatch(/accountLock\.shouldNotify\(/);
    expect(notice).toMatch(/ACCOUNT_LOCKED_LINE/);
  });

  it('no turn starts while locked, whatever its source: the one function every turn goes through refuses first', () => {
    const send = body('function sendToSession(session, contentBlocks', 'const historyText');
    const guard = send.indexOf('accountLock.isLocked()');
    expect(guard).toBeGreaterThan(-1);
    expect(send.slice(guard, guard + 200)).toMatch(/return false/);
    // Ahead of everything that could dispatch or change state.
    expect(guard).toBeLessThan(send.indexOf('foreignSessions.end'));
  });

  it('queued messages are not flushed while locked', () => {
    const flush = body('function flushPendingSessionQueue(session) {', 'const queue = session.queuedMessages');
    expect(flush).toMatch(/if \(accountLock\.isLocked\(\)\) return false;/);
  });

  it('a reminder that falls due while locked is held, and fired after the clear', () => {
    const fire = body('async function fireTimer(record) {', 'let session = findSessionByClaudeSessionId');
    expect(fire).toMatch(/if \(accountLock\.hold\(\{ kind: 'timer', record \}\)\) return;/);
    const release = body('function releaseAfterAccountLock(held)', '\n}\n');
    expect(release).toMatch(/kind === 'timer'/);
    expect(release).toMatch(/fireTimer\(/);
  });

  it('every inbound path is told about the lock', () => {
    expect(body('const journalRpcHandler = createRpcRequestHandler({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    expect(body('agentInvites = createAgentInvites({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    expect(body('transferReceiver = createTransferReceiver({', '\n});')).toMatch(/accountLocked: \(\) => accountLock\.isLocked\(\)/);
    const router = body('const journalInputConsumer = createJournalInputConsumer({', '\n});');
    expect(router).toMatch(/inputLock: \{ verdict: \(kind, keyId\) => \(accountLock\.isLocked\(\) \? accountLock\.verdict\(\)/);
    // A same-bridge invite never passes the invites manager's frame handler.
    const local = body('function journalInjectInviteRequest(frame) {', 'const isJoin');
    expect(local).toMatch(/accountLock\.isLocked\(\)/);
  });

  it('it does not depend on the approval gate', () => {
    const make = body('const accountLock = createAccountLock({', '\n});');
    expect(make).not.toMatch(/approvalGate|boxLock/);
  });
});
