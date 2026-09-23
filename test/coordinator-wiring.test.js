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
