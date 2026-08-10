import fs from 'node:fs';
import path from 'node:path';
import { projectDirFor } from './transcript-dir.js';

export function codexRunsDirFor(workdir, sessionId) {
  // Compose from the canonical project-dir helper so a future change to the
  // ~/.claude/projects layout lands in one place (producer + watcher stay in
  // sync). projectDirFor already realpath-resolves the workdir.
  return path.join(projectDirFor(workdir), sessionId, 'codex-runs') + path.sep;
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
