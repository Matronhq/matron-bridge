// Where the live Bash-output logs (`matron-cmd-<tool_use_id>.log`) live.
//
// The bridge (index.js) predicts the path from the tool_use_id, and the
// PreToolUse tee hook writes it, so both must agree on the directory. POSIX
// keeps the historical literal `/tmp` (the bridge and its sessions may have
// different TMPDIRs, and `/tmp` is the one place they are known to share).
// Windows has no /tmp: the user's temp dir (`os.tmpdir()`, from %TEMP%) is
// shared by the bridge, the Claude child and the hook, which all run as the
// same user.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function liveLogDir({ platform = process.platform, tmpdir = os.tmpdir } = {}) {
  return platform === 'win32' ? tmpdir() : '/tmp';
}

export function liveLogPath(toolUseId, opts = {}) {
  return path.join(liveLogDir(opts), `matron-cmd-${toolUseId}.log`);
}

// Reading a live log back. The tee creates it exclusively and owner-only,
// but the directory is shared, so before trusting what is at the predicted
// name the reader checks it is that file: opened without following a link,
// a regular file with one link, owned by this user. Anything else is not the
// command's output and is not read (the stream simply shows nothing).
// Windows has no O_NOFOLLOW or uid; there the temp dir is per-user anyway.
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);

export function isOwnLiveLog(st, { getuid = process.getuid } = {}) {
  if (!st || !st.isFile()) return false;
  if (typeof getuid !== 'function') return true;
  return st.nlink === 1 && st.uid === getuid();
}

// -> fd, or null when there is no log yet or it is not this user's own file.
export function openOwnLiveLogSync(logPath, opts = {}) {
  let fd;
  try { fd = fs.openSync(logPath, OPEN_FLAGS); } catch { return null; }
  let ok;
  try { ok = isOwnLiveLog(fs.fstatSync(fd), opts); } catch { ok = false; }
  if (ok) return fd;
  try { fs.closeSync(fd); } catch { /* best effort */ }
  return null;
}

// -> FileHandle, or null; same checks as openOwnLiveLogSync.
export async function openOwnLiveLog(logPath, opts = {}) {
  let handle;
  try { handle = await fs.promises.open(logPath, OPEN_FLAGS); } catch { return null; }
  let ok;
  try { ok = isOwnLiveLog(await handle.stat(), opts); } catch { ok = false; }
  if (ok) return handle;
  try { await handle.close(); } catch { /* best effort */ }
  return null;
}
