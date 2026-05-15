import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DEFAULT_PATH = path.join(os.homedir(), '.claude.json');

// Pre-write `~/.claude.json` so claude's first-run "Do you trust this folder?"
// dialog does not appear when we spawn it in a PTY. The trust dialog is auto-
// skipped in --print mode but not when stdout is a TTY, so the bridge must
// register trust itself before driving an interactive session.
export function ensureWorkspaceTrusted(workdir, claudeJsonPath = DEFAULT_PATH) {
  const abs = path.resolve(workdir);
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
  } catch (_) {
    // File doesn't exist or is unreadable — start fresh.
  }
  config.projects = config.projects || {};
  const existing = config.projects[abs] || {};
  if (existing.hasTrustDialogAccepted === true && existing.hasCompletedProjectOnboarding === true) {
    return;
  }
  config.projects[abs] = {
    ...existing,
    hasTrustDialogAccepted: true,
    hasCompletedProjectOnboarding: true,
  };
  fs.writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
}
