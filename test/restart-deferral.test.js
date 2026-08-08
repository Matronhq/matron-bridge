import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractForceFlag } from '../lib/command-dispatch.js';

// /restart's wait-for-turn-end deferral: issued mid-turn WITHOUT --force,
// /restart must no longer kill the session (cancelling e.g. an in-flight
// /compact — the exact incident that motivated this: "/compact then
// /restart --browser cancels the compaction"). Instead it parks the restart
// and replays it, forced, at the turn-end seams. --force keeps the old
// immediate behavior.

describe('extractForceFlag', () => {
  it('finds --force and strips it from rest', () => {
    expect(extractForceFlag(['--force'])).toEqual({ force: true, rest: [] });
    expect(extractForceFlag(['--browser', '--force'])).toEqual({ force: true, rest: ['--browser'] });
  });

  it('recognises the mobile-autocorrected em/en dash spellings', () => {
    expect(extractForceFlag(['—force'])).toEqual({ force: true, rest: [] });
    expect(extractForceFlag(['–force'])).toEqual({ force: true, rest: [] });
  });

  it('is case-insensitive on the flag word', () => {
    expect(extractForceFlag(['--Force'])).toEqual({ force: true, rest: [] });
  });

  it('returns force=false with tokens untouched when absent', () => {
    expect(extractForceFlag(['--browser', 'now'])).toEqual({ force: false, rest: ['--browser', 'now'] });
  });

  it('preserves non-force tokens verbatim, unicode dashes included', () => {
    expect(extractForceFlag(['—browser', '--force']).rest).toEqual(['—browser']);
  });

  it('does not treat "force" without dashes as the flag', () => {
    expect(extractForceFlag(['force'])).toEqual({ force: false, rest: ['force'] });
  });

  it('defaults to an empty token list', () => {
    expect(extractForceFlag()).toEqual({ force: false, rest: [] });
  });
});

// The deferral itself lives in index.js and can't be imported, so it's
// pinned by source inspection — the same technique the index.js wiring pins
// in busy-queue.test.js use.
const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

describe("index.js !restart busy deferral (source inspection)", () => {
  const start = src.indexOf("case '!restart':");
  const body = src.slice(start, src.indexOf("case '!resume':", start));

  it('parses --force before the extras/agent flag parsers', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toMatch(/extractForceFlag\(parts\.slice\(1\)\)/);
  });

  it('a busy, unforced /restart defers instead of restarting', () => {
    expect(body).toMatch(/existing\.busy && !restartForced/);
    expect(body).toMatch(/_deferredRestartText/);
  });

  it("replies with the exact 'waiting' message", () => {
    expect(body).toContain(
      "'Waiting for turn to finish before restarting. Send again with --force to restart immediately.'",
    );
  });

  it('the stashed replay is forced so it cannot re-defer at the seam', () => {
    expect(body).toMatch(/'!restart', '--force'/);
  });
});

describe('index.js dispatchDeferredRestart (source inspection)', () => {
  const start = src.indexOf('function dispatchDeferredRestart(session)');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  it('exists', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('clears the stash before the liveness check, so a dead session can never restart later', () => {
    const clear = body.indexOf('session._deferredRestartText = null');
    const aliveCheck = body.indexOf('!session.alive');
    expect(clear).toBeGreaterThan(-1);
    expect(aliveCheck).toBeGreaterThan(-1);
    expect(clear).toBeLessThan(aliveCheck);
  });

  it('refuses to fire for a superseded session (would restart its replacement)', () => {
    expect(body).toMatch(/sessions\.get\(session\.roomId\) !== session/);
  });

  it('replays through handleCommand with the journal command ctx', () => {
    expect(body).toMatch(/journalSessionCommandCtx\(session\)/);
    expect(body).toMatch(/handleCommand\(session\.roomId, text, ctx\.sendReply, ctx\.sendHtml, ctx\.sender\)/);
  });
});

// Each turn-end seam must consume the stash INSTEAD of flushing the queue:
// flushing first would type queued messages into the process the restart is
// about to kill. recreateSession carries queuedMessages into the
// replacement, and the room-delivery inbox is keyed by roomId, so both
// reach the new session.
describe('index.js turn-end seams dispatch the deferred restart (source inspection)', () => {
  const seamWindow = (anchor, end) => {
    const start = src.indexOf(anchor);
    expect(start).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf(end, start));
  };

  const expectDispatchBeforeFlush = (body) => {
    const dispatch = body.indexOf('dispatchDeferredRestart(session)');
    const flush = body.indexOf('flushPendingSessionQueue(session)');
    expect(dispatch).toBeGreaterThan(-1);
    expect(flush).toBeGreaterThan(-1);
    expect(dispatch).toBeLessThan(flush);
  };

  it('iv-mode onTurnEnd (also the manual-/compact boundary path)', () => {
    expectDispatchBeforeFlush(seamWindow('session.onTurnEnd = () => {', 'session.requestPlanDecision'));
  });

  it("print-mode 'result' event", () => {
    expectDispatchBeforeFlush(seamWindow("case 'result': {", "case 'system':"));
  });

  it('finishCodexTurn', () => {
    expectDispatchBeforeFlush(seamWindow('function finishCodexTurn(session', '\n}\n'));
  });
});
