import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The bridge-shipped producer shim launcher, resolved once. detectProducer
// compares each on-PATH `codex` realpath against this to recognise the shim.
const SHIPPED_SHIM_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'shim', 'codex',
);

function safeRealpath(p) {
  try { return fs.realpathSync(p); } catch { return null; }
}

// T-1.6: is there an event PRODUCER for the sessions this bridge launches?
// A producer exists when EITHER (return true on first match):
//   1. MATRON_CODEX_REAL_BIN is set — the son-of-anton integration point is
//      active, which means codex_execute.sh is the launcher and is itself a
//      redaction-aware producer (G1). This is the key correctness point: the
//      wrapper-only deployment (shim dir unset) has a valid producer and MUST
//      NOT be treated as "no producer".
//   2. `codex` resolves on env.PATH to the bridge shim (realpath equals the
//      shipped shim launcher).
// Only when NEITHER holds (bare stock codex on PATH, no MATRON_CODEX_REAL_BIN,
// no shim) is there truly no producer — the silent-empty-view condition.
export function detectProducer({ env = process.env, shimPath = SHIPPED_SHIM_PATH } = {}) {
  const realBin = typeof env.MATRON_CODEX_REAL_BIN === 'string' ? env.MATRON_CODEX_REAL_BIN.trim() : '';
  // Only a REAL_BIN that actually resolves counts as a producer — a set-but-
  // missing path would otherwise enable the watcher with no producer behind it,
  // restoring the silent empty-view this guard exists to prevent. Fall through
  // to the shim-on-PATH check when it doesn't resolve.
  if (realBin && safeRealpath(realBin)) {
    return true;
  }
  const shimReal = safeRealpath(shimPath);
  if (shimReal) {
    for (const dir of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
      if (safeRealpath(path.join(dir, 'codex')) === shimReal) return true;
    }
  }
  return false;
}

// The codex-viz sink dir. It MUST live outside Claude Code's managed
// `~/.claude/projects/<encoded-cwd>/<sessionId>/` tree.
//
// Root cause: the sink used to be a sibling of the session's `subagents/` dir
// under the encoded-cwd project tree. When a session changes its cwd mid-flight
// — most commonly `EnterWorktree`, which moves the session from its launch dir
// into a `.../.claude/worktrees/<name>` checkout — Claude Code RE-HOMES the whole
// `projects/<encoded-cwd>/<sessionId>/` directory to the new cwd's encoding,
// carrying `codex-runs/` with it. But `MATRON_CODEX_SINK_DIR`
// is frozen in the child's environment at spawn time and cannot be updated in a
// running process, so the producer (codex_execute.sh) keeps writing to the old,
// now-vanished path and fails with "[codex-viz] meta write failed; viz off" —
// no sink lands where the watcher looks, no card renders.
//
// Anchoring the sink to the sessionId alone (never the cwd) makes producer-write
// == watcher-watch by construction and immune to any post-spawn cwd change:
// sessionIds are globally unique, so per-session isolation is preserved without
// the volatile encoded-cwd component. `workdir` is retained in the signature for
// call-site compatibility but is deliberately no longer part of the path.
export function codexRunsDirFor(workdir, sessionId) {
  // sessionId is a single path segment under the sinks root. Reject traversal /
  // separators / NUL so a `..` can't escape the root (session ids are UUIDs; an
  // absolute-looking segment stays under the root via path.join, so only these
  // matter). Throwing is safe: the watcher-setup + sink-env paths catch it.
  if (typeof sessionId !== 'string' || sessionId === '' || sessionId === '.' || sessionId === '..'
    || /[/\\\0]/.test(sessionId) || sessionId.includes('..')) {
    throw new Error(`[codex-paths] unsafe sessionId: ${JSON.stringify(sessionId)}`);
  }
  return path.join(os.homedir(), '.claude', 'matron', 'codex-sinks', sessionId, 'codex-runs') + path.sep;
}

export function configureCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  env = process.env,
  mkdirSync = fs.mkdirSync,
  warn = console.warn,
}) {
  try {
    if (env.MATRON_CODEX_VIZ === '1') {
      const dir = codexRunsDirFor(workdir, sessionId);
      mkdirSync(dir, { recursive: true });
      spawnEnv.MATRON_CODEX_SINK_DIR = dir;
      return dir;
    }
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
  } catch (error) {
    delete spawnEnv.MATRON_CODEX_SINK_DIR;
    try {
      warn(`[codex-viz] sink dir setup failed, viz disabled for this session: ${error.message}`);
    } catch { /* logging must never block the shared session spawn path */ }
  }
  return null;
}

export function launchWithCodexSinkEnv({
  spawnEnv,
  workdir,
  sessionId,
  launch,
  configureOptions = {},
}) {
  configureCodexSinkEnv({
    ...configureOptions,
    spawnEnv,
    workdir,
    sessionId,
  });
  return launch(spawnEnv);
}
