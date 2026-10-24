// The receive half of agent-to-agent file transfer. When the journal
// releases a room file (approved and fully uploaded) it sends this device a
// `ready` frame; a bridge that was asleep finds the same transfers with
// GET /transfers?for=me on hello (catchUp). For each one:
//
//   download into <inbox>/<name>.<id>.part, resuming from the .part's length
//   -> sha256 over the whole file, against the sha256 the card showed
//   -> rename to <inbox>/<name> (or <name>-1, -2 ... if taken)
//   -> POST /transfers/:id/received {sha256}
//   -> one room line to each bound session that did not send it
//
// The inbox is the session's download dir (index.js: sessionDownloadDir +
// /inbox), outside any working tree, so a received file is never committed.
//
// A transfer is persisted in the state file from the moment it is seen
// until it is confirmed and delivered, so a restart picks it up again; the
// .part file stays across retries and restarts, so a resume never starts
// from zero. A sha mismatch deletes the .part and starts over once; a
// second mismatch is reported to the room and nothing is kept. Every saved
// path is recorded with its arrival time for the inbox sweep.

import crypto from 'crypto';
import nodeFs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { atomicWriteFileSync } from './atomic-write.js';
import { safeAttachmentFilename } from './item-attachments.js';

const RETRY_BACKOFF_MS = [2000, 8000, 30000];
// No bytes for this long aborts the download (a transient failure: the
// retry resumes from the .part).
const STALL_MS = 2 * 60_000;
const MAX_ARRIVED = 2000;

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
const transientStatus = (s) => s === 0 || s === 429 || s >= 500;

export function humanSize(bytes) {
  const units = ['KB', 'MB', 'GB', 'TB'];
  if (bytes < 1024) return `${bytes} B`;
  let v = bytes;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u += 1; }
  return `${v.toFixed(1)} ${units[u]}`;
}

function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = nodeFs.createReadStream(absPath);
    s.on('data', (b) => h.update(b));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

async function sizeOf(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}
async function unlinkQuiet(p) {
  try { await fsp.unlink(p); } catch { /* already gone */ }
}

function freePath(dir, filename) {
  let target = path.join(dir, filename);
  if (!nodeFs.existsSync(target)) return target;
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  for (let i = 1; ; i++) {
    target = path.join(dir, `${base}-${i}${ext}`);
    if (!nodeFs.existsSync(target)) return target;
  }
}

function validTransfer(t) {
  return !!t && typeof t === 'object'
    && typeof t.id === 'string' && t.id !== ''
    && typeof t.room_id === 'string' && t.room_id !== ''
    && typeof t.name === 'string' && t.name !== ''
    && Number.isSafeInteger(t.size) && t.size > 0
    && typeof t.sha256 === 'string' && /^[0-9a-f]{64}$/.test(t.sha256);
}

// Thrown inside a download attempt: `transient` retries (from the .part),
// otherwise the transfer is gone (404, refused) and is dropped.
class DownloadError extends Error {
  constructor(message, { transient }) { super(message); this.transient = transient; }
}

// client: lib/transfer-client.js. dirFor(session) -> abs inbox dir.
// sessionsForRoom(roomId, fromConvoId) -> the bound sessions that should
// receive it (the first one's inbox gets the download; the rest a link).
// isMuted(roomId, session) -> true: save and confirm, but no line.
// deliver(session, line, {roomId, fromName, transferId}) -> the room line.
export function createTransferReceiver({
  client,
  dirFor,
  deliver = () => {},
  sessionsForRoom,
  isMuted = () => false,
  stateFile,
  log = console,
  now = Date.now,
  sleep = defaultSleep,
  stallMs = STALL_MS,
} = {}) {
  const state = load();
  const running = new Map(); // transfer id -> promise
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };

  function load() {
    try {
      const raw = JSON.parse(nodeFs.readFileSync(stateFile, 'utf-8'));
      return {
        pending: raw && typeof raw.pending === 'object' && raw.pending ? raw.pending : {},
        arrived: Array.isArray(raw?.arrived) ? raw.arrived : [],
      };
    } catch {
      return { pending: {}, arrived: [] };
    }
  }
  function save() {
    try {
      atomicWriteFileSync(stateFile, JSON.stringify(state), { mode: 0o600 });
    } catch (e) {
      warn(`[transfer] saving inbox state failed: ${e.message}`);
    }
  }
  function drop(id) {
    if (!(id in state.pending)) return;
    delete state.pending[id];
    save();
  }

  const safeName = (t) => safeAttachmentFilename(t.name, 'file');
  // The id is in the .part name so two transfers of the same file name never
  // share one partial file.
  function partPathFor(dir, t) {
    const idSeg = String(t.id).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return path.join(dir, `${safeName(t)}.${idSeg}.part`);
  }

  function targetsFor(t) {
    try {
      const list = sessionsForRoom(t.room_id, t.from_convo_id ?? null);
      return Array.isArray(list) ? list.filter(Boolean) : [];
    } catch (e) {
      warn(`[transfer] finding sessions for room ${t.room_id} failed: ${e.message}`);
      return [];
    }
  }

  function tell(t, session, line) {
    try {
      if (isMuted(t.room_id, session)) return;
      deliver(session, line, { roomId: t.room_id, fromName: t.from_name || null, transferId: t.id });
    } catch (e) {
      warn(`[transfer] delivering the line for ${t.id} failed: ${e.message}`);
    }
  }

  // One request: append the body to `part` (or start it over on a 200).
  // Resolves when the .part holds exactly t.size bytes.
  async function fetchOnce(t, part) {
    let start = await sizeOf(part);
    if (start > t.size) { await unlinkQuiet(part); start = 0; }
    const controller = new AbortController();
    let timer = null;
    const bump = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { try { controller.abort(); } catch { /* best effort */ } }, stallMs);
      timer.unref?.();
    };
    bump();
    try {
      let res;
      try {
        res = await client.download(t.id, { start, signal: controller.signal });
      } catch (e) {
        throw new DownloadError(`download failed: ${e?.message ?? e}`, { transient: true });
      }
      if (res.status === 416) {
        // The journal says the range starts past the end. If the .part is
        // already the whole file, that is a finished download.
        const m = /^bytes \*\/(\d+)$/.exec(String(res.headers.get('content-range') || '').trim());
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        if (m && Number(m[1]) === t.size && start === t.size) return;
        await unlinkQuiet(part);
        throw new DownloadError('range not satisfiable; starting over', { transient: true });
      }
      if (res.status === 206) {
        const m = /^bytes (\d+)-\d+\/\d+$/.exec(String(res.headers.get('content-range') || '').trim());
        if (!m || Number(m[1]) !== start) {
          try { await res.body?.cancel(); } catch { /* nothing to drain */ }
          await unlinkQuiet(part);
          throw new DownloadError('unexpected content-range; starting over', { transient: true });
        }
      } else if (res.status !== 200) {
        try { await res.body?.cancel(); } catch { /* nothing to drain */ }
        throw new DownloadError(`HTTP ${res.status}`, { transient: transientStatus(res.status) });
      }
      // A 200 is the whole file whatever was asked: never append it.
      const flags = res.status === 206 ? 'a' : 'w';
      if (!res.body) throw new DownloadError('empty body', { transient: true });
      // Each chunk is awaited onto disk, so whatever arrived before a
      // dropped connection is in the .part for the resume.
      const fh = await fsp.open(part, flags, 0o600);
      try {
        for await (const chunk of res.body) {
          bump();
          await fh.write(chunk);
        }
      } catch (e) {
        throw new DownloadError(`download interrupted: ${e?.message ?? e}`, { transient: true });
      } finally {
        await fh.close();
      }
      const got = await sizeOf(part);
      if (got < t.size) throw new DownloadError(`short download (${got} of ${t.size} bytes)`, { transient: true });
      // Longer than declared: the sha check below fails it.
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -> 'done' | 'gone' | 'stalled'
  async function fetchWithRetries(t, part) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fetchOnce(t, part);
        return 'done';
      } catch (e) {
        if (!(e instanceof DownloadError)) throw e;
        if (!e.transient) { log.log?.(`[transfer] ${t.id} is no longer downloadable (${e.message})`); return 'gone'; }
        if (attempt >= RETRY_BACKOFF_MS.length) {
          warn(`[transfer] download of ${t.id} stalled (${e.message}); kept for the next catch-up`);
          return 'stalled';
        }
        await sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }

  async function receiptWithRetries(t) {
    let r = await client.received(t.id, t.sha256);
    for (const wait of RETRY_BACKOFF_MS) {
      if (r.ok || !transientStatus(r.status)) break;
      await sleep(wait);
      r = await client.received(t.id, t.sha256);
    }
    return r;
  }

  // Saved: confirm to the journal, then tell each session where its copy is.
  // Each step is recorded, so a restart in between repeats only what is left.
  async function finish(entry) {
    const t = entry.transfer;
    if (!entry.receipted) {
      const r = await receiptWithRetries(t);
      if (r.ok || !transientStatus(r.status)) {
        if (!r.ok) warn(`[transfer] receipt for ${t.id} refused (HTTP ${r.status}); the file is kept`);
        entry.receipted = true;
      } else {
        warn(`[transfer] receipt for ${t.id} failed (HTTP ${r.status}); will retry on the next catch-up`);
      }
      save();
    }
    if (!entry.delivered) {
      const caption = typeof (t.reason ?? t.caption) === 'string' ? (t.reason ?? t.caption).trim() : '';
      const byDir = new Map((entry.saved || []).map((p) => [path.dirname(p), p]));
      for (const session of targetsFor(t)) {
        let dir;
        try { dir = dirFor(session); } catch { dir = null; }
        const p = dir && byDir.get(dir);
        if (!p) continue;
        tell(t, session, `[sent file "${safeName(t)}" — saved to ${p} (${humanSize(t.size)}, sha256 ${t.sha256.slice(0, 12)}…)]${caption ? `: ${caption}` : ''}`);
      }
      entry.delivered = true;
      save();
    }
    if (entry.receipted) drop(t.id);
  }

  async function receive(id) {
    const entry = state.pending[id];
    if (!entry) return;
    if (entry.saved) return finish(entry);
    const t = entry.transfer;
    const targets = targetsFor(t);
    if (targets.length === 0) {
      log.log?.(`[transfer] ${t.id}: no session in room ${t.room_id} to receive it`);
      drop(id);
      return;
    }
    const dir = dirFor(targets[0]);
    await fsp.mkdir(dir, { recursive: true });
    const part = partPathFor(dir, t);

    for (let mismatches = 0; ;) {
      const outcome = await fetchWithRetries(t, part);
      if (outcome === 'gone') { await unlinkQuiet(part); drop(id); return; }
      if (outcome === 'stalled') return;
      const digest = await sha256File(part);
      if (digest === t.sha256) break;
      await unlinkQuiet(part);
      mismatches += 1;
      if (mismatches > 1) {
        warn(`[transfer] ${t.id} failed verification twice; not saved`);
        for (const session of targets) tell(t, session, `[file "${safeName(t)}" failed verification and was not saved]`);
        drop(id);
        return;
      }
    }

    const finalPath = freePath(dir, safeName(t));
    await fsp.rename(part, finalPath);
    const saved = [finalPath];
    for (const session of targets.slice(1)) {
      try {
        const d = dirFor(session);
        if (!d || d === dir) continue;
        await fsp.mkdir(d, { recursive: true });
        const p = freePath(d, safeName(t));
        try { await fsp.link(finalPath, p); } catch { await fsp.copyFile(finalPath, p); }
        saved.push(p);
      } catch (e) {
        warn(`[transfer] copying ${t.id} into a second inbox failed: ${e.message}`);
      }
    }
    for (const p of saved) state.arrived.push({ path: p, arrivedAt: now(), transferId: t.id });
    if (state.arrived.length > MAX_ARRIVED) state.arrived.splice(0, state.arrived.length - MAX_ARRIVED);
    entry.saved = saved;
    save();
    return finish(entry);
  }

  function launch(id) {
    if (running.has(id)) return running.get(id);
    const p = receive(id)
      .catch((e) => warn(`[transfer] receiving ${id} failed: ${e?.message ?? e}`))
      .finally(() => running.delete(id));
    running.set(id, p);
    return p;
  }

  const alreadyArrived = (id) => state.arrived.some((a) => a.transferId === id);

  function onReady(transfer) {
    if (!validTransfer(transfer)) {
      warn('[transfer] ignoring a ready transfer without id, room, name, size or sha256');
      return;
    }
    const id = transfer.id;
    if (running.has(id)) return;
    if (!state.pending[id]) {
      if (alreadyArrived(id)) return;
      state.pending[id] = { transfer };
      save();
    }
    launch(id);
  }

  // On every journal hello: whatever the journal says is waiting for this
  // device, plus whatever the state file still holds (a download a restart
  // or a long outage interrupted, or a receipt that never got through).
  async function catchUp() {
    let listed = null;
    try {
      const r = await client.listPending();
      if (r?.ok && Array.isArray(r.body?.transfers)) listed = r.body.transfers;
      else warn(`[transfer] catch-up list failed (HTTP ${r?.status ?? 0}); resuming local downloads only`);
    } catch (e) {
      warn(`[transfer] catch-up list failed: ${e.message}`);
    }
    const ids = new Set();
    for (const t of listed || []) {
      if (!validTransfer(t)) continue;
      ids.add(t.id);
      onReady(t);
    }
    for (const [id, entry] of Object.entries(state.pending)) {
      if (ids.has(id) || running.has(id)) continue;
      // Not on the journal's list any more: a saved copy still finishes
      // (receipt, line); an unfinished download is no longer servable.
      if (listed && !entry.saved) {
        const targets = targetsFor(entry.transfer);
        if (targets[0]) {
          try { await unlinkQuiet(partPathFor(dirFor(targets[0]), entry.transfer)); } catch { /* best effort */ }
        }
        drop(id);
        continue;
      }
      launch(id);
    }
  }

  // Downloads (and their retry waits) in flight: what keeps the box awake.
  const active = () => running.size;

  async function idle() {
    while (running.size) await Promise.all([...running.values()]);
  }

  return { onReady, catchUp, active, idle, partPathFor };
}
