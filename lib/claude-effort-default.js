// Keep a bridge-typed `/effort` to the chat it was sent in.
//
// Claude Code's interactive `/effort <level>` also saves the level as the
// default for NEW sessions, in the user's settings.json
// (`modelSettings.<model>.effortLevel`, or a top-level `effortLevel`). When
// the bridge types `/effort` for one chat (the print-mode route, an
// interactive chat, the Coordinator's switch), that turns one chat's choice
// into the box-wide default for every later Claude Code session — the
// user's own terminal included. The chat itself does not need the saved default: the
// bridge persists the level per room and passes it as `--effort` on every
// restart and resume (spawnEffortFor).
//
// So the bridge snapshots the saved effort defaults just before it types
// `/effort`, and puts them back once that write has settled (committed,
// declined, or the session gone). Writes overlap across chats, so the
// snapshot is box-wide: the first in-flight write takes it, the last one to
// settle restores it. A deliberate `/effort` typed straight into a terminal
// during that window is reverted too — the accepted cost of the shared file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOP = '';

export function claudeSettingsPath(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

// { [model]: level } for every saved effort default; '' is the top-level key.
export function readEffortDefaults(settings) {
  const out = {};
  if (!settings || typeof settings !== 'object') return out;
  if (settings.effortLevel !== undefined) out[TOP] = settings.effortLevel;
  const models = settings.modelSettings;
  if (models && typeof models === 'object') {
    for (const [model, cfg] of Object.entries(models)) {
      if (cfg && typeof cfg === 'object' && cfg.effortLevel !== undefined) out[model] = cfg.effortLevel;
    }
  }
  return out;
}

// Put the snapshot's effort defaults back into `settings` (mutated), leaving
// every other key alone. Returns true when anything changed. A model entry
// emptied by the restore is dropped, as is an emptied modelSettings.
export function restoreEffortDefaults(settings, snapshot) {
  if (!settings || typeof settings !== 'object') return false;
  const current = readEffortDefaults(settings);
  let changed = false;
  for (const key of new Set([...Object.keys(current), ...Object.keys(snapshot)])) {
    if (current[key] === snapshot[key]) continue;
    changed = true;
    if (key === TOP) {
      if (snapshot[key] === undefined) delete settings.effortLevel;
      else settings.effortLevel = snapshot[key];
      continue;
    }
    if (snapshot[key] === undefined) {
      const cfg = settings.modelSettings?.[key];
      if (!cfg) continue;
      delete cfg.effortLevel;
      if (Object.keys(cfg).length === 0) delete settings.modelSettings[key];
      if (Object.keys(settings.modelSettings).length === 0) delete settings.modelSettings;
    } else {
      if (!settings.modelSettings || typeof settings.modelSettings !== 'object') settings.modelSettings = {};
      if (!settings.modelSettings[key] || typeof settings.modelSettings[key] !== 'object') settings.modelSettings[key] = {};
      settings.modelSettings[key].effortLevel = snapshot[key];
    }
  }
  return changed;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    return null; // unreadable or mid-write: never overwrite what we can't parse
  }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.matron-${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// The box-wide guard. `acquire(isSettled)` is called right after the bridge
// types `/effort`; the guard polls isSettled() and, once it holds, waits
// `graceMs` more (Claude writes settings.json as it applies the change) before
// releasing. When the last holder releases, the snapshot is restored.
// `maxMs` bounds a hold whose write never settles.
export function createEffortDefaultGuard({
  file = claudeSettingsPath(),
  pollMs = 2000,
  graceMs = 3000,
  maxMs = 30 * 60 * 1000,
  read = readJson,
  write = writeJsonAtomic,
  log = (msg) => console.log(msg),
  timers = { setTimeout, clearTimeout, setInterval, clearInterval },
} = {}) {
  let snapshot = null;
  const holders = new Set();

  function restore() {
    const settings = read(file);
    if (!settings) { log(`[effort] left ${file} alone: could not parse it`); return; }
    if (!restoreEffortDefaults(settings, snapshot || {})) return;
    try {
      write(file, settings);
      log('[effort] restored the saved effort default after a chat-scoped /effort');
    } catch (err) {
      log(`[effort] could not restore the saved effort default: ${err?.message || err}`);
    }
  }

  function release(token) {
    if (!holders.delete(token)) return;
    timers.clearInterval(token.poll);
    timers.clearTimeout(token.max);
    if (holders.size === 0) {
      restore();
      snapshot = null;
    }
  }

  function acquire(isSettled) {
    if (holders.size === 0) {
      const settings = read(file);
      if (!settings) { log(`[effort] not guarding ${file}: could not parse it`); return null; }
      snapshot = readEffortDefaults(settings);
    }
    const token = { settledAt: null };
    holders.add(token);
    token.poll = timers.setInterval(() => {
      let settled;
      try { settled = !!isSettled(); } catch { settled = true; }
      if (!settled) { token.settledAt = null; return; }
      if (token.settledAt === null) { token.settledAt = 0; return; }
      token.settledAt += pollMs;
      if (token.settledAt >= graceMs) release(token);
    }, pollMs);
    token.max = timers.setTimeout(() => release(token), maxMs);
    for (const t of [token.poll, token.max]) if (typeof t?.unref === 'function') t.unref();
    return token;
  }

  return { acquire, release, get holding() { return holders.size; } };
}
