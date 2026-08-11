import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js, same idiom as test/codex-session.test.js's
// "Codex bridge wiring" block. index.js has no unit-test harness, so the
// restart-carry-on turn-boundary wiring (Task 4) has no behavioural coverage at
// all. These pin the two couplings that took two review rounds to discover by
// hand, both of which regress SILENTLY in either direction:
//
//   - too eager a clear  -> the marker is gone at the next boot, so a turn that
//                           really was interrupted gets no "Carry on" card and
//                           the feature is quietly dead for that path;
//   - too lazy a clear   -> a stale marker survives a finished turn and the next
//                           boot offers to carry on a conversation that is over,
//                           which is the exact failure the user rejected
//                           ("don't resurface all the old dead conversations").
//
// Nothing at runtime enforces either, hence these.
describe('restart carry-on turn-boundary wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  function bodyOf(startNeedle, endNeedle) {
    const start = src.indexOf(startNeedle);
    expect(start, `could not find ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    const end = src.indexOf(endNeedle, start + 1);
    expect(end, `could not find the end of ${startNeedle} in index.js — this test needs updating`).toBeGreaterThan(-1);
    return src.slice(start, end);
  }

  it('gates the Codex marker clear on !discardOutput so a teardown keeps the card', () => {
    const body = bodyOf('function finishCodexTurn(', '\nfunction ');

    expect(
      body,
      'finishCodexTurn must clear the inflight marker ONLY when the turn genuinely ended, '
      + 'i.e. guarded by `if (!discardOutput)`. discardOutput is passed exclusively by the two '
      + 'teardown callers (killSession, and the turn-exit fallback for an already-dead session), '
      + 'where the turn was INTERRUPTED, not finished. An unguarded clear here is how a SIGTERM '
      + 'restart erased its own evidence: restart.sh kills with plain kill/pkill (SIGTERM), the '
      + 'handler calls killSession for every live session, and a mid-turn Codex session deleted '
      + 'the very record the next boot needs. CONSEQUENCE OF REMOVING THIS GUARD: Codex sessions '
      + 'get no carry-on card on a restart — the feature is silently dead for that backend on its '
      + 'primary trigger.',
    ).toContain('if (!discardOutput) inflightMarker.noteTurnEnd(');

    // The guard is worthless if a second, ungated call sits alongside it.
    expect(
      body.split('inflightMarker.noteTurnEnd(').length - 1,
      'finishCodexTurn must contain EXACTLY ONE inflightMarker.noteTurnEnd call, the guarded one. '
      + 'A second, ungated call would defeat the guard and re-break the SIGTERM restart path.',
    ).toBe(1);
  });

  it('keeps discardOutput a teardown-only signal, since the marker gate now rides on it', () => {
    // The gate above encodes a caller CLASSIFICATION (teardown vs genuine turn
    // end) in a parameter whose name is about output suppression. That coupling
    // is the fragility; this pins it. If you are adding a call site, decide
    // which kind it is before changing this number.
    expect(
      src.split('discardOutput: true').length - 1,
      'index.js must pass `discardOutput: true` at exactly TWO call sites, both teardown: '
      + "killSession's Codex branch, and the codex.on('turn-exit') fallback for an already-dead "
      + 'session. finishCodexTurn treats that flag as "this turn was torn down, not finished" and '
      + 'so LEAVES the inflight marker standing for the next boot to card. A new call site passing '
      + 'it merely to suppress output would leak a marker -> SPURIOUS "Carry on" card for a '
      + 'conversation that actually finished. A teardown call site that drops it would clear the '
      + 'marker -> NO card for a turn that really was interrupted. Either way the break is silent; '
      + 'update this count only once you have classified the new site.',
    ).toBe(2);
  });

  it('clears the marker in the !stop handler BEFORE killSession, not inside killSession', () => {
    const body = bodyOf("case '!stop': {", '\n    }');
    const clear = body.indexOf('inflightMarker.noteTurnEnd(journalConvoIdFor(session))');
    const kill = body.indexOf('killSession(session)');

    expect(
      clear,
      '!stop must clear the inflight marker. It is a DELIBERATE turn end, but the kill path never '
      + 'sets session.busy = false for print/iv sessions, so this site is invisible to a '
      + '`session.busy = false` grep and was missed once already. CONSEQUENCE: without it, '
      + '!stop on a mid-turn session leaves a marker behind and the next boot offers to carry on a '
      + 'turn the user killed on purpose — a SPURIOUS card.',
    ).toBeGreaterThan(-1);

    expect(
      kill,
      'expected the !stop handler to still call killSession(session) — this test needs updating',
    ).toBeGreaterThan(-1);

    expect(
      clear < kill,
      'the !stop marker clear must come BEFORE killSession(session). killSession tears the session '
      + 'down and, for Codex, re-enters finishCodexTurn — whose clear is deliberately gated off on '
      + 'that path. Clearing first means the marker is gone regardless of what teardown does, and '
      + 'removes any dependency on killSession leaving journalConvoIdFor(session) resolvable. '
      + 'CONSEQUENCE OF INVERTING: a deliberately killed turn can survive as a marker and produce a '
      + 'SPURIOUS "Carry on" card.',
    ).toBe(true);
  });

  it('does not clear the marker inside killSession, so /restart and /switch still get their card', () => {
    const body = bodyOf('function killSession(', '\nfunction ');

    expect(
      body,
      'killSession must NOT clear the inflight marker. It is reused by /restart and /switch, where '
      + 'the turn genuinely WAS interrupted and the carry-on card is the correct behaviour, and by '
      + 'the SIGINT/SIGTERM shutdown handlers, which are the feature\'s whole reason to exist. '
      + 'Clearing here would silently kill restart carry-on for every path at once. The one caller '
      + 'that should clear — !stop — does so explicitly at its own call site.',
    ).not.toContain('inflightMarker.');
  });

  it('records a turn start at every site that sets session.busy = true', () => {
    // A missed start site is the quieter failure (a silently missed card), but
    // it is still a hole, and the set is small enough to pin exactly.
    const starts = src.split('session.busy = true;').length - 1;
    const notes = src.split('inflightMarker.noteTurnStart(').length - 1;

    expect(
      starts,
      'index.js should have exactly 3 `session.busy = true;` turn-start sites (submitAnswer\'s '
      + 'tool_result write, sendToSession, and the plan-approval tool_result). If this changed, a '
      + 'turn start was added or removed — pair it with an inflightMarker.noteTurnStart call, or a '
      + 'restart during that turn produces NO carry-on card.',
    ).toBe(3);

    expect(
      notes,
      'every `session.busy = true;` site must be followed by inflightMarker.noteTurnStart(...), '
      + 'otherwise a turn interrupted by a restart leaves no marker and the user gets no card.',
    ).toBe(starts);
  });
});
