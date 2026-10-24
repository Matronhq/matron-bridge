// The receiving bridge keeps a received room file for 7 days
// (lib/transfer-receiver.js records every saved path with its arrival
// time). This sweep, run on the idle reaper's tick, deletes what has been
// there longer, and the partial downloads nothing will resume.
//
// It deletes only:
//   - a file the receiver recorded (`arrived`) whose newest arrival at that
//     path is older than maxAgeMs, and which has not been changed since then
//     either (its mtime is older too);
//   - a `<name>.tr_<id>.part` older than maxAgeMs (by mtime) in an inbox the
//     state names (the directory of a recorded file, or of a pending entry),
//     whose transfer is no longer pending.
// Nothing else is touched: no other file in the inbox, no directory the
// state does not name, nothing through a symlink (lstat, regular files
// only), no saved copy a pending entry is still delivering. A file that is
// already gone just loses its record.
import nodeFs from 'fs';
import path from 'path';
import { atomicWriteFileSync } from './atomic-write.js';

export const INBOX_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// The .part names partPathFor() gives a journal transfer id (tr_ + 32 hex).
const ORPHAN_PART_RE = /\.(tr_[0-9a-f]{32})\.part$/;

const regularFile = (fsImpl, p) => {
  try {
    const st = fsImpl.lstatSync(p);
    if (st.isSymbolicLink?.() || !st.isFile()) return { st, ok: false };
    return { st, ok: true };
  } catch (e) {
    return { gone: e?.code === 'ENOENT', ok: false };
  }
};

// Sweep `state` ({pending, arrived}) in place. -> {deleted: [paths],
// changed: whether `state` was modified (and should be saved)}.
export function sweepInboxState(state, { now = Date.now(), maxAgeMs = INBOX_MAX_AGE_MS, fsImpl = nodeFs, log = console } = {}) {
  const deleted = [];
  if (!state || typeof state !== 'object') return { deleted, changed: false };
  const arrived = Array.isArray(state.arrived) ? state.arrived : [];
  const pending = state.pending && typeof state.pending === 'object' ? state.pending : {};
  const cutoff = now - maxAgeMs;
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };

  // Paths a pending entry still delivers from, and the inboxes the state knows.
  const inUse = new Set();
  const dirs = new Set();
  for (const entry of Object.values(pending)) {
    if (typeof entry?.dir === 'string' && entry.dir) dirs.add(entry.dir);
    for (const s of Array.isArray(entry?.saved) ? entry.saved : []) {
      const p = typeof s === 'string' ? s : s?.path;
      if (typeof p === 'string' && p) { inUse.add(p); dirs.add(path.dirname(p)); }
    }
  }
  const newest = new Map();
  for (const a of arrived) {
    if (typeof a?.path !== 'string' || !a.path || !Number.isFinite(a.arrivedAt)) continue;
    dirs.add(path.dirname(a.path));
    newest.set(a.path, Math.max(newest.get(a.path) ?? -Infinity, a.arrivedAt));
  }

  // Recorded files: decide once per path.
  const drop = new Set();
  for (const [p, at] of newest) {
    if (at > cutoff || inUse.has(p)) continue;
    const f = regularFile(fsImpl, p);
    if (f.gone) { drop.add(p); continue; }
    if (!f.ok) {
      // A symlink or directory now sits there: not ours to delete, and not
      // a file we keep any more either.
      if (f.st) drop.add(p);
      continue;
    }
    if (f.st.mtimeMs > cutoff) continue; // changed since it arrived
    try {
      fsImpl.unlinkSync(p);
      deleted.push(p);
      drop.add(p);
    } catch (e) {
      if (e?.code === 'ENOENT') drop.add(p);
      else warn(`[transfer] inbox sweep could not delete ${p}: ${e.message}`);
    }
  }
  const kept = arrived.filter((a) => !(typeof a?.path === 'string' && drop.has(a.path)));
  const changed = kept.length !== arrived.length;
  if (changed) state.arrived = kept;

  // Orphaned partial downloads in the inboxes the state names.
  for (const dir of dirs) {
    let names;
    try { names = fsImpl.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = ORPHAN_PART_RE.exec(String(name));
      if (!m || m[1] in pending) continue;
      const p = path.join(dir, String(name));
      const f = regularFile(fsImpl, p);
      if (!f.ok || f.st.mtimeMs > cutoff) continue;
      try {
        fsImpl.unlinkSync(p);
        deleted.push(p);
      } catch (e) {
        if (e?.code !== 'ENOENT') warn(`[transfer] inbox sweep could not delete ${p}: ${e.message}`);
      }
    }
  }
  return { deleted, changed };
}

const defaultSave = (stateFile, state) => atomicWriteFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });

// The same sweep over a receiver state file on disk. index.js sweeps through
// the live receiver (receiver.sweep()) instead, so its in-memory state and
// the file never disagree; this form is for a bridge with no receiver yet.
export function sweepInbox(stateFile, { now = Date.now(), maxAgeMs = INBOX_MAX_AGE_MS, fsImpl = nodeFs, save = defaultSave, log = console } = {}) {
  let state;
  try {
    state = JSON.parse(fsImpl.readFileSync(stateFile, 'utf-8'));
  } catch {
    return { deleted: [] };
  }
  if (!state || typeof state !== 'object') return { deleted: [] };
  const { deleted, changed } = sweepInboxState(state, { now, maxAgeMs, fsImpl, log });
  if (changed) {
    try { save(stateFile, state); } catch (e) { try { log.warn(`[transfer] saving inbox state failed: ${e.message}`); } catch { /* never throw */ } }
  }
  return { deleted };
}
