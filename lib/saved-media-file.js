// Install a complete attachment without replacing an existing upload.
import fs from 'fs';
import path from 'path';
import { randomBytes } from 'node:crypto';

function fsyncFileStrict(fsImpl, p) {
  const fd = fsImpl.openSync(p, 'r+');
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    try { fsImpl.closeSync(fd); } catch { /* ignore close error — fsync result already decided */ }
  }
}

function fsyncDirBestEffort(fsImpl, dir) {
  let fd = null;
  try {
    fd = fsImpl.openSync(dir, 'r');
    fsImpl.fsyncSync(fd);
  } catch { /* non-fatal — file data is already durable; dir entry is secondary */ }
  finally {
    if (fd !== null) { try { fsImpl.closeSync(fd); } catch { /* ignore */ } }
  }
}

export function writeSavedMediaFile(finalPath, buffer, { fsImpl = fs, reselectPath = null, maxAttempts = 8 } = {}) {
  const dir = path.dirname(finalPath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(finalPath)}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  try {
    fsImpl.writeFileSync(tmpPath, buffer, { flag: 'wx' });
    fsyncFileStrict(fsImpl, tmpPath);
  } catch (err) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* nothing to remove */ }
    throw err;
  }
  // Capture our own inode before publishing the final name.
  let identity = null;
  try {
    const st = fsImpl.lstatSync(tmpPath, { bigint: true });
    identity = { dev: st.dev, ino: st.ino };
  } catch { /* unknown identity disables destructive cleanup */ }
  let target = finalPath;
  let attempt = 0;
  for (;;) {
    try {
      fsImpl.linkSync(tmpPath, target);
      break;
    } catch (err) {
      if (err && err.code === 'EEXIST' && reselectPath && ++attempt < maxAttempts) {
        try { target = reselectPath(); } catch (selectError) {
          try { fsImpl.unlinkSync(tmpPath); } catch { /* best-effort */ }
          throw selectError;
        }
        continue;
      }
      try { fsImpl.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
  try { fsImpl.unlinkSync(tmpPath); } catch { /* removed later via cleanup's tmpPath */ }
  fsyncDirBestEffort(fsImpl, dir);
  return { path: target, identity, tmpPath };
}

export function makeIdentityAwareCleanup(filePath, identity, { fsImpl = fs, tmpPath = null } = {}) {
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    if (tmpPath) { try { fsImpl.unlinkSync(tmpPath); } catch { /* already gone */ } }
    if (!filePath || !identity) return; // fail closed on missing target/identity
    try {
      const st = fsImpl.lstatSync(filePath, { bigint: true });
      if (st.dev !== identity.dev || st.ino !== identity.ino) {
        return;
      }
      fsImpl.unlinkSync(filePath);
    } catch { /* already gone / never written / stat failed — nothing to do */ }
  };
}
