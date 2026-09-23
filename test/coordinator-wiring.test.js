import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// index.js cannot be imported in-process (top-level journal/express side
// effects), so the coordinator wiring is pinned by source inspection — same
// approach as test/start-model-flag-wiring.test.js. The decisions themselves
// are unit-tested in test/coordinator.test.js.
const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function body(startMarker, endMarker) {
  const start = index.indexOf(startMarker);
  const end = index.indexOf(endMarker, start + startMarker.length);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return index.slice(start, end);
}

describe('coordinator spawn wiring (source inspection)', () => {
  it('loads BRIDGE_COORDINATOR.md with an env override, like the other prompt files', () => {
    expect(index).toContain("const DEFAULT_BRIDGE_COORDINATOR_MD_PATH = path.join(__dirname, 'BRIDGE_COORDINATOR.md');");
    expect(index).toContain('const BRIDGE_COORDINATOR_MD_PATH = process.env.BRIDGE_COORDINATOR_MD_PATH || DEFAULT_BRIDGE_COORDINATOR_MD_PATH;');
    expect(index).toMatch(/const COORDINATOR_BLOCK = loadCoordinatorBlock\(\{/);
  });

  it('builds one lookup on the journal HTTP base and refreshes it at boot and on every hello_ok', () => {
    expect(index).toMatch(/const coordinatorLookup = createCoordinatorLookup\(\{\s*baseUrl: journalHttpBase,\s*token: _journalToken,/);
    const reconnect = body('function handleJournalReconnect()', '\nfunction ');
    expect(reconnect).toContain('coordinatorLookup.refresh({ force: true });');
    const boot = body('if (JOURNAL_ENABLED) {', '\nfunction expandHome(');
    expect(boot).toContain('coordinatorLookup.refresh({ force: true });');
  });

  it('createSession resolves the role before any agent branch and hands it to all three builders', () => {
    const cs = body('function createSession(roomId, workdir, resumeSessionId, options = {}) {', 'if (agent === AGENT_CODEX) {');
    expect(cs).toContain('const coordinator = coordinatorRoleAtSpawn(roomId, resumeSessionId, options, persistedMode);');
    expect(cs).toContain('options = { ...options, coordinator };');
  });

  it('an unknown role spawns an ordinary session and logs it — never a failed spawn', () => {
    const fn = body('function coordinatorRoleAtSpawn(', '\nfunction ');
    expect(fn).toContain('coordinatorLookup.roleFor(candidates)');
    expect(fn).toContain('coordinatorLookup.refresh();');
    expect(fn).toMatch(/starting as an ordinary session/);
    expect(fn).not.toMatch(/throw /);
  });

  it('print mode: prompt and disallowed tools come from claudeCoordinatorArgs', () => {
    const cs = body('function createSession(roomId, workdir, resumeSessionId, options = {}) {', '\nfunction ');
    expect(cs).toMatch(/const printCoord = claudeCoordinatorArgs\(\{ coordinator: !!options\.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK, baseDisallowed: \['AskUserQuestion'\] \}\);/);
    expect(cs).toContain("'--disallowed-tools', ...printCoord.disallowedTools,");
    expect(cs).toContain("'--append-system-prompt', printCoord.appendSystemPrompt,");
  });

  it('interactive mode: same helper, --disallowed-tools only when there is something to disallow', () => {
    const iv = body('function createInteractiveSessionForRoom(', '\nfunction ');
    expect(iv).toMatch(/const ivCoord = claudeCoordinatorArgs\(\{ coordinator: !!options\.coordinator, basePrompt: BRIDGE_SYSTEM_PROMPT, block: COORDINATOR_BLOCK \}\);/);
    expect(iv).toContain("...(ivCoord.disallowedTools.length ? ['--disallowed-tools', ...ivCoord.disallowedTools] : []),");
    expect(iv).toContain("'--append-system-prompt', ivCoord.appendSystemPrompt,");
  });

  it('no spawn site appends the bare BRIDGE_SYSTEM_PROMPT any more', () => {
    expect(index).not.toContain("'--append-system-prompt', BRIDGE_SYSTEM_PROMPT");
  });

  it('Codex: developer instructions and sandbox come from codexCoordinatorOptions', () => {
    const cx = body('function createCodexSessionForRoom(', '\nfunction ');
    expect(cx).toMatch(/const codexCoord = codexCoordinatorOptions\(\{ coordinator: !!options\.coordinator, baseInstructions: CODEX_BRIDGE_PROMPT, block: COORDINATOR_BLOCK, baseSandbox: CODEX_SANDBOX_MODE \}\);/);
    expect(cx).toContain('sandbox: codexCoord.sandbox,');
    expect(cx).toContain('developerInstructions: codexCoord.developerInstructions + (CODEX_APP_SERVER');
    expect(cx).not.toContain('sandbox: CODEX_SANDBOX_MODE,');
  });

  it('every session records whether it was spawned as the Coordinator', () => {
    expect(index.match(/^\s+coordinator: !!options\.coordinator,$/gm)).toHaveLength(3);
  });
});

describe('explicit model picks are persisted as such (source inspection)', () => {
  it('imports explicitModelFlag', () => {
    expect(index).toMatch(/import \{[^}]*\bexplicitModelFlag\b[^}]*\} from '\.\/lib\/coordinator\.js'/);
  });

  it('RPC start, !start, !restart, !resume and !workdir mark the picked model explicit', () => {
    const rpc = body('function journalStartSessionForRpc(', '\nfunction ');
    expect(rpc).toContain('model ? { model, ...explicitModelFlag(model) } : undefined');
    expect(index).toContain('startModel ? { model: startModel, ...explicitModelFlag(startModel) } : undefined');
    expect(index).toContain('{ model: restartModelFlag.model, ...explicitModelFlag(restartModelFlag.model) }');
    expect(index).toContain('...(resumeModelFlag.model ? explicitModelFlag(resumeModelFlag.model) : {}),');
    expect(index).toContain('workdirModel ? { model: workdirModel, ...explicitModelFlag(workdirModel) } : undefined');
  });

  it('applyModelSwitch takes an explicit option; implicit switches persist modelExplicit:false and park with --implicit', () => {
    const fn = body('function applyModelSwitch(', '\nfunction ');
    expect(fn).toContain('function applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit = true }) {');
    expect(fn).toContain("session._deferredCommandText = `!model ${decision.normalized}${explicit ? '' : ' --implicit'}`;");
    expect(fn.match(/explicit \? explicitModelFlag\([^)]*\) : \{ modelExplicit: false \}/g)).toHaveLength(3);
  });

  it('!model reads --implicit (the parked coordinator switch) and passes explicit through', () => {
    const block = body("case '!model': {", "case '!mode': {");
    expect(block).toContain("const implicit = parts.slice(2).includes('--implicit');");
    expect(block).toContain('applyModelSwitch(roomId, session, arg, { sendReply, sendHtml, explicit: !implicit });');
  });
});

describe('live coordinator events (source inspection)', () => {
  it('the router seam is wired to journalOnCoordinator with a catch', () => {
    expect(index).toMatch(/onCoordinatorEvent: \(convoId, ev\) => \{\s*journalOnCoordinator\(convoId, ev\)\.catch\(/);
  });

  it('journalOnCoordinator applies the event, re-reads the journal, then decides', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    const applyAt = fn.indexOf('coordinatorLookup.apply(convoId, role);');
    const refreshAt = fn.indexOf('await coordinatorLookup.refresh({ force: true });');
    const decideAt = fn.indexOf('decideCoordinatorEvent({');
    expect(applyAt).toBeGreaterThan(-1);
    expect(refreshAt).toBeGreaterThan(applyAt);
    expect(decideAt).toBeGreaterThan(refreshAt);
  });

  it('respawns idle sessions via recreateSession, switches a busy one via applyModelSwitch explicit:false, then delivers the turn', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain('planCoordinatorTransition({');
    expect(fn).toContain("recreateSession(roomId, plan.model ? { model: plan.model } : {}, ctx)");
    expect(fn).toContain('{ model: plan.model, modelExplicit: false }');
    expect(fn).toContain('applyModelSwitch(roomId, session, plan.model, { ...ctx, explicit: false });');
    expect(fn).toContain('await deliverCoordinatorTurn(sessions.get(roomId) || session, coordinatorTurnText(role, COORDINATOR_BLOCK));');
  });

  it("a user's parked /model pick is handed to the plan, so the implicit switch never overwrites it", () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain('parkedCommand: session._deferredCommandText,');
  });

  it('a busy session gets the turn queued, an idle one injected, neither mirrored to the journal', () => {
    const fn = body('async function deliverCoordinatorTurn(', '\nfunction ');
    expect(fn).toContain('sessionOccupiedForRoomDelivery(session)');
    expect(fn).toContain('mirrorToJournal: false');
    expect(fn).toContain('sendTextToSession(session, text, { skipJournalMirror: true })');
  });
});

describe('live coordinator events — busy session (fix round 1)', () => {
  it('a busy session records the pending role, the decision reads it, and a restart is parked when the slot is free', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain('pendingRole: session?._coordinatorPending ?? null,');
    expect(fn).toContain('session._coordinatorPending = role;');
    expect(fn).toContain("if (session.busy && !session._deferredCommandText) session._deferredCommandText = '!restart --force';");
  });

  it('recreateSession does not carry the pending role onto the replacement (the spawn applies it)', () => {
    const fn = body('function recreateSession(', '\nfunction ');
    expect(fn).not.toContain('_coordinatorPending');
  });
});

describe('live coordinator events — occupied but not busy (fix round 2)', () => {
  it('the plan is told whether the session is busy, not just occupied', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain('busy: !!session.busy,');
  });

  it('a restart is parked only on a busy session (a hold/prompt flush would strand the queue behind it)', () => {
    const fn = body('async function journalOnCoordinator(', '\nfunction ');
    expect(fn).toContain("if (session.busy && !session._deferredCommandText) session._deferredCommandText = '!restart --force';");
    expect(fn).not.toContain("if (!session._deferredCommandText) session._deferredCommandText = '!restart --force';");
  });

  it("a /model typed over the Coordinator's parked restart does not claim to replace a /restart the user never asked for", () => {
    const fn = body('function applyModelSwitch(', '\nfunction ');
    expect(fn).toContain("const parkedByCoordinator = !!session._coordinatorPending && previousParked === '!restart --force';");
    expect(fn).toMatch(/else if \(previousParked && !parkedByCoordinator\)/);
  });
});

describe('agent_session_start mission (source inspection)', () => {
  const askUser = readFileSync(new URL('../ask-user.js', import.meta.url), 'utf8');
  const tool = askUser.slice(askUser.indexOf("'agent_session_start',"), askUser.indexOf("'restart_session',"));
  it('exposes an optional positive-integer mission and forwards it', () => {
    expect(tool).toMatch(/mission: z\.number\(\)\.int\(\)\.min\(1\)\.optional\(\)/);
    expect(tool).toContain('async ({ device_id, workdir, task, topic, model, link, mission }) => {');
    expect(tool).toContain('...(mission ? { mission } : {})');
  });
  it('the ack says the new session joins the mission', () => {
    expect(tool).toContain('` The new session joins mission #${mission} from its first turn.`');
  });
});
