import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the Coordinator session-control wiring is pinned by source
// inspection — same approach as test/coordinator-wiring.test.js. The
// planner (lib/session-control.js) and the calling side
// (lib/session-control-client.js) are unit-tested on their own.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('session control wiring (source inspection)', () => {
  it('registers the RPC method and the publisher hooks', () => {
    expect(index).toContain("controlSession: (params) => journalControlSession(params),");
    expect(index).toContain("onSessionControlFrame: (frame) => sessionControlHandlers?.onSessionControlFrame(frame),");
    expect(index).toMatch(/onOpError: \(e\) => \{ if \(sessionControlHandlers\?\.onOpError\?\.\(e\)\) return; if \(agentSpawnHandlers/);
  });
  it('resolves or resumes the target, then parks, schedules or applies', () => {
    const fn = body('async function journalControlSession(rawParams) {', '\nasync function applyControlSteps(');
    expect(fn).toContain('let session = findSessionByClaudeSessionId(params.convoId);');
    expect(fn).toContain('if (!session || !session.alive) session = journalResumeConvo(params.convoId, JOURNAL_RESUME_NOTICE);');
    expect(fn).toContain("code: known ? 'gone' : 'not_found'");
    expect(fn).toContain('planSessionControl({ params, session, canSwitch: canSwitchAgent })');
    expect(fn).toContain("session._deferredControls = { ...(session._deferredControls || {}), [plan.slot.kind]: plan.slot };");
    expect(fn).toContain("session._autoResume = { at: plan.at, text: plan.text, kind: 'usage_limit', source: 'coordinator' };");
  });
  it('applies steps through the existing switch, model, compact and turn paths', () => {
    const fn = body('async function applyControlSteps(session, steps) {', '\nfunction drainDeferredControls(');
    expect(fn).toContain('await switchAgentSession(current.roomId, step.agent, { sendReply: ctx.sendReply });');
    expect(fn).toContain('applyModelSwitch(current.roomId, current, step.model, { sendReply: ctx.sendReply, sendHtml: ctx.sendHtml, explicit: true });');
    expect(fn).toContain("await journalRouteTextToSession(current, '/compact');");
    expect(fn).toContain('sendTextToSession(current, step.text, { skipJournalMirror: true })');
  });
  it('drains parked slots from the shared free gate, before room delivery, and never on an occupied session', () => {
    const gate = body('function maybeFlushRoomDelivery(session) {', '\n}');
    const occ = gate.indexOf('if (sessionOccupiedForRoomDelivery(session)) return;');
    const drain = gate.indexOf('if (drainDeferredControls(session)) return;');
    const flush = gate.indexOf('roomDelivery.flush(session, session.roomId)');
    expect(occ).toBeGreaterThan(-1);
    expect(drain).toBeGreaterThan(occ);
    expect(flush).toBeGreaterThan(drain);
    const fn = body('function drainDeferredControls(session) {', '\nfunction maybeFlushRoomDelivery(');
    expect(fn).toContain('const kinds = CONTROL_KINDS.filter((k) => slots[k] && slots[k].params);');
    expect(fn).toContain('session._deferredControls = null;');
  });
  it('parked controls and the automatic carry-on persist and are restored on resume', () => {
    const ps = body('function persistSession(roomId, sessionId, workdir, originRoomId, extra) {', '\nfunction ');
    expect(ps).toContain('if (live) derived._deferredControls = live._deferredControls || null;');
    expect(ps).toContain('if (live) derived._autoResume = live._autoResume || null;');
    expect(index).toContain('_deferredControls: resumeSessionId ? (persistedMode?._deferredControls || null) : null,');
    expect(index).toContain('_deferredControls: resumeSessionId ? (persistedForRoom?._deferredControls || null) : null,');
    expect(index).toContain('_autoResume: resumeSessionId ? (persistedMode?._autoResume || null) : null,');
    expect(index).toContain('_autoResume: resumeSessionId ? (persistedForRoom?._autoResume || null) : null,');
  });
  it('exposes the three routes to the MCP tools', () => {
    for (const r of ['/session-set-model', '/session-compact', '/session-carry-on']) {
      expect(index).toContain(`url.pathname === '${r}'`);
      expect(askUser).toContain(`'${r}'`);
    }
    for (const t of ['session_set_model', 'session_compact', 'session_carry_on']) expect(askUser).toContain(`'${t}'`);
  });
});

describe('automatic carry-on wiring (source inspection)', () => {
  it('arms the slot from a usage-limit stall, re-arms when the forced refresh lands, and clears it on a real answer', () => {
    const c = body("    case 'assistant': {", "    case 'result': {");
    expect(c).toContain("if (stall.kind === 'bad_model') {");
    expect(c).toContain('recoverBadModel(session);');
    expect(c).toContain('session._autoResume = armFromStall(session._stall, session._autoResume);');
    expect(c.match(/session\._autoResume = armFromStall\(session\._stall, session\._autoResume\);/g)).toHaveLength(2);
    expect(c).toContain('session._autoResume = null;');
    expect(c).toContain('session._badModelRecovered = false;');
  });
  it('sweeps live and persisted sessions once a minute and fires due slots with a compact first when the gauge is high', () => {
    expect(index).toContain('startIdleReaper();\nstartAutoResumeSweep();');
    const fn = body('function runAutoResumeSweep(now = Date.now()) {', '\nfunction startAutoResumeSweep(');
    expect(fn).toContain('if (autoResumeDue(session._autoResume, now)) void fireAutoResume(roomId, journalConvoIdFor(session), session._autoResume);');
    expect(fn).toContain('for (const due of dueResumes(records, now)) {');
    const fire = body('async function fireAutoResume(roomId, convoId, slot) {', '\nfunction runAutoResumeSweep(');
    expect(fire).toContain('journalResumeConvo(convoId,');
    expect(fire).toContain('session._autoResume = null;');
    expect(fire).toContain("if (shouldCompactBefore(session._lastContextTokens, contextWindowForSession(session))) {");
    expect(fire).toContain("await journalRouteTextToSession(session, '/compact');");
    expect(fire).toContain('await journalRouteTextToSession(sessions.get(roomId) || session, slot.text || BAD_MODEL_RECOVERY_TEXT);');
  });
  it('recovers a bad model once with the default model, then carries on; a second failure is left for a person', () => {
    const fn = body('function recoverBadModel(session) {', '\n// --- Coordinator session control');
    expect(fn).toContain('if (session._badModelRecovered) {');
    expect(fn).toContain("applyModelSwitch(session.roomId, session, 'default', { sendReply: ctx.sendReply, sendHtml: ctx.sendHtml, explicit: false });");
    expect(fn).toContain('void journalRouteTextToSession(next, BAD_MODEL_RECOVERY_TEXT)');
    expect(fn.indexOf('session._badModelRecovered = true;')).toBeLessThan(fn.indexOf("applyModelSwitch("));
  });
  it('persists the recovery flag', () => {
    expect(index).toContain('if (live) derived._badModelRecovered = !!live._badModelRecovered;');
    expect(index).toContain('_badModelRecovered: resumeSessionId ? !!persistedMode?._badModelRecovered : false,');
  });
});
