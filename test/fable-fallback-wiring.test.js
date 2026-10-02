import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process, so the Fable-limit fallback
// wiring is pinned by source inspection, as in test/stall-wiring.test.js.
// The rules themselves are unit-tested in test/fable-fallback.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('spawn start fallback (source inspection)', () => {
  it('the RPC handler gets the fallback thunk', () => {
    const h = body('const journalRpcHandler = createRpcRequestHandler({', '\n});');
    expect(h).toContain('startModelFallback: () => startModelFallbackFromLimits(),');
  });
  it('decides on the box default and the usage cache, refreshing a stale cache within a bounded wait', () => {
    const fn = body('function startModelFallbackFromLimits() {', '\n}\n');
    expect(fn).toContain('spawnModelFallback({ defaultModel: DEFAULT_MODEL, lines: usageLimitsCache.lines })');
    expect(fn).toContain('if (!isFableModel(DEFAULT_MODEL)) return null;');
    expect(fn).toContain('refreshUsageLimits(DEFAULT_WORKDIR, { force: true })');
    expect(fn).toContain('Promise.race([refresh.catch(() => false), deadline])');
    // 12 s wait + 5 s mission pre-join must stay well inside the journal's 30 s.
    expect(index).toContain('const START_LIMITS_WAIT_MS = 12_000;');
  });
});

describe('stalled-session Fable switch (source inspection)', () => {
  it('runs on the forced refresh after a usage-limit stall, after the carry-on is armed', () => {
    const c = body("    case 'assistant': {", "    case 'result': {");
    const then = c.slice(c.indexOf('refresh.then((updated) => {'));
    expect(then.indexOf('armFromStall(')).toBeGreaterThan(-1);
    expect(then.indexOf("if (session._stall.kind === 'usage_limit') switchFableStall(session);")).toBeGreaterThan(then.indexOf('armFromStall('));
  });
  it('switches with explicit:false and arms a model_recovery carry-on on the live session', () => {
    const fn = body('function switchFableStall(session, { retry = 0 } = {}) {', '\n}\n');
    expect(fn).toContain('stallModelFallback({ stall: session._stall,');
    expect(fn).toContain('applyModelSwitch(session.roomId, session, fb.model, { sendReply: ctx.sendReply, sendHtml: ctx.sendHtml, explicit: false })');
    expect(fn).toContain('const next = sessions.get(session.roomId) || session;');
    expect(fn).toContain("next._autoResume = { at: new Date().toISOString(), kind: 'model_recovery', text: FABLE_SWITCH_TEXT };");
    expect(fn).toContain("kind: 'fable_switch', retry: retry + 1");
    expect(fn).toContain('if (retry >= FABLE_SWITCH_MAX_RETRIES) return false;');
  });
  it('a deferred switch is retried by the sweep, and falls back to waiting for the reset', () => {
    const fn = body('async function fireAutoResume(roomId, convoId, slot) {', '\n}\n');
    expect(fn).toContain("if (slot.kind === 'fable_switch') {");
    expect(fn).toContain('switchFableStall(session, { retry: slot.retry || 0 })');
    expect(fn).toContain('session._autoResume = armFromStall(session._stall, null, Date.now(), session._autoResumeRetries || 0);');
  });
});
