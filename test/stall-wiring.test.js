import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the stall wiring is pinned by source inspection — same
// approach as test/coordinator-wiring.test.js. The detector itself is
// unit-tested in test/stall-detector.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('usage-limit stall wiring (source inspection)', () => {
  it('imports the detector', () => {
    expect(index).toContain("import { stallFromAssistantEvent, stallResetsAt } from './lib/stall-detector.js';");
  });
  it('the assistant case sets or clears session._stall from every parent assistant record and publishes a stall at once', () => {
    const c = body("    case 'assistant': {", "    case 'result': {");
    expect(c).toContain('const stall = stallFromAssistantEvent(event);');
    expect(c).toContain('session._stall = stall ? { ...stall, since: Date.now(), resets_at: stallResetsAt(usageLimitsCache.lines) } : null;');
    expect(c).toContain('if (stall) journalStatus(session);');
  });
  it('journalStatus publishes the stall and applyModelSwitch clears it', () => {
    const js = body('function journalStatus(session) {', '\nfunction ');
    expect(js).toContain('stall: session._stall || undefined,');
    const ams = body('function applyModelSwitch(', '\nfunction ');
    expect(ams.indexOf('session._stall = null;')).toBeLessThan(ams.indexOf('if (session.agent === AGENT_CODEX) {'));
  });
  it('every session literal starts unstalled', () => {
    expect(index.match(/^ {4}_stall: null,$/gm)).toHaveLength(3);
  });
});
