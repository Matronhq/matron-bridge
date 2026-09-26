// Guarded, atomic edit of an EXISTING file inside a pinned allowed root.
//
// Lets a journal client apply a small file edit (add a gitignored env var,
// tweak a config) from a phone or browser, with no SSH. This module is the
// guarded backend behind the `edit_file` agent RPC.
//
// This composes the two existing primitives rather than reinventing either:
//   - lib/file-link-guard.js `validateAndOpen` is THE path-safety boundary and
//     is reused verbatim: it opens the target O_NOFOLLOW (a symlink final
//     component fails ELOOP), resolves the fd's REAL path via /proc/self/fd
//     (immune to path swaps after open), then enforces containment in the
//     pinned allowed roots + non-sensitivity + is-a-regular-file + size. The
//     write targets the already-proven-in-scope real path it returns. It also
//     hands back the current bytes, which the targeted-edit mode needs. The
//     RPC-specific credential denylist (lib/file-rpc-policy.js) is layered on
//     top.
//   - `writeFileReplacing` (below) writes an exclusive, unpredictable temp
//     sibling then renames, so a kill / power loss / short write mid-edit
//     never corrupts or truncates the target (the original stays intact on
//     any failure).
//
// Scope is deliberately EXISTING files only. Creating a new file needs a
// parent-directory validation path `validateAndOpen` doesn't provide (it opens
// the target itself for read); that is out of scope here and would
// need its own guarded-create primitive.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { openSync, writeSync, fchmodSync, fsyncSync, closeSync, renameSync, unlinkSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { validateAndOpen, FileLinkDenied } from './file-link-guard.js';
import { isCredentialPath } from './file-rpc-policy.js';

// Bound the post-edit result. Config tweaks and env lines are tiny; this only
// exists so a full-content replace can't be used to write an unbounded blob.
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;

// Structured, fail-loud error. `.code` is the wire error code the RPC layer
// surfaces; for path rejections it is the guard's own reason verbatim
// (relative-path / symlink / outside-scope / path-race / sensitive /
// not-a-file / too-large / unreadable / bad-workdir) so the caller can tell escapes apart.
export class EditFileError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EditFileError';
    this.code = code;
    this.detail = detail;
  }
}

// Per-target serialization. Two edits of the same file must not both read the
// same snapshot, both pass the expected_sha256 check, and then overwrite each
// other: the second would silently undo the first while both report success.
// Every edit of a given real path runs one at a time and re-reads the file
// inside its turn, so the compare-and-swap is exact against every other edit
// made through this bridge process. Against writers outside it (an editor, an
// agent's own tools, another process) the check is best-effort: the window is
// the one synchronous stretch between the re-read and the rename.
const editQueues = new Map();
function withTargetLock(key, fn) {
  const prior = editQueues.get(key) || Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.catch(() => {});
  editQueues.set(key, tail);
  tail.then(() => { if (editQueues.get(key) === tail) editQueues.delete(key); });
  return run;
}

// Replace `target` with `data` atomically, with `mode` in place before the new
// content is visible. The temp file gets an unpredictable name and is created
// O_CREAT|O_EXCL|O_NOFOLLOW, so a name planted in the directory beforehand
// (including a symlink pointing outside the allowed roots) makes the create
// fail instead of being written through. Content is written, chmod'd and
// fsynced through the one descriptor, then renamed over the target.
export function writeFileReplacing(target, data, { mode } = {}) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(8).toString('hex')}.tmp`);
  const fd = openSync(
    tmp,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    mode === undefined ? 0o600 : mode & 0o777,
  );
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (mode !== undefined) fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw e;
  }
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count += 1;
    from = idx + needle.length;
  }
}

// applyFileEdit(input, opts) -> { path, bytes, mode }
//   input.path        absolute path to an existing file inside the pinned roots
//   input.content     full-content replacement (string)          -- mode "content"
//   input.old_string  unique substring to replace (non-empty)    -- mode "replace"
//   input.new_string  its literal replacement (string)           -- mode "replace"
//   input.expected_sha256  OPTIONAL compare-and-swap precondition: the sha256
//     (hex) the caller believes the file currently holds. When present the edit
//     applies ONLY if the live content still hashes to it, else -> "stale".
//     This is how a client makes a lost-response retry or a concurrent edit
//     safe (read -> hash -> edit-with-expected); absent = no precondition.
// Exactly one of { content } / { old_string (+ new_string) } is required.
// Throws EditFileError for every rejection; unexpected errors propagate raw.
export async function applyFileEdit(input, {
  allowedRoots,
  maxBytes = MAX_EDIT_BYTES,
  deps = { validateAndOpen, FileLinkDenied, atomicWrite: writeFileReplacing },
} = {}) {
  const params = input && typeof input === 'object' ? input : {};

  const filePath = params.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new EditFileError('bad_request', 'path must be a non-empty string');
  }

  // Exclusive, fail-loud mode selection. Both or neither is malformed.
  const hasContent = Object.prototype.hasOwnProperty.call(params, 'content');
  const hasOld = Object.prototype.hasOwnProperty.call(params, 'old_string');
  if (hasContent && hasOld) {
    throw new EditFileError('bad_request', 'supply either content or old_string, not both');
  }
  if (!hasContent && !hasOld) {
    throw new EditFileError('bad_request', 'one of content or old_string is required');
  }
  if (hasContent && typeof params.content !== 'string') {
    throw new EditFileError('bad_request', 'content must be a string');
  }
  if (hasOld) {
    if (typeof params.old_string !== 'string' || params.old_string.length === 0) {
      throw new EditFileError('bad_request', 'old_string must be a non-empty string');
    }
    if (typeof params.new_string !== 'string') {
      throw new EditFileError('bad_request', 'new_string must be a string');
    }
  }
  const hasExpected = Object.prototype.hasOwnProperty.call(params, 'expected_sha256');
  if (hasExpected && (typeof params.expected_sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(params.expected_sha256))) {
    throw new EditFileError('bad_request', 'expected_sha256 must be a 64-char hex digest');
  }

  // Fail CLOSED if scope was never established. validateAndOpen only enforces
  // containment when the pinned root set is non-empty; an empty/absent set
  // would let this write anywhere readable. Mirror shareAgentMedia's guard.
  if (!Array.isArray(allowedRoots?.roots) || allowedRoots.roots.length === 0) {
    throw new EditFileError('bad_workdir', 'no allowed roots pinned');
  }

  // The path-safety boundary AND our read of the current bytes, in one
  // fd-pinned step. `realPath` is the symlink-resolved, proven-in-scope path we
  // then write to — never the caller's original string. strictSnapshot: an
  // edit must start from a whole, coherent file, not a torn read.
  const open = async () => {
    try {
      const opened = await deps.validateAndOpen(filePath, {
        allowedRoots,
        maxBytes,
        strictSnapshot: true,
      });
      if (isCredentialPath(opened.realPath)) throw new EditFileError('sensitive', 'path rejected: sensitive');
      return opened;
    } catch (e) {
      if (e instanceof deps.FileLinkDenied) {
        throw new EditFileError(e.reason, `path rejected: ${e.reason}`);
      }
      throw e;
    }
  };
  // The first open only learns which file this is; the edit itself re-opens
  // and re-reads inside that file's turn (see withTargetLock).
  const { realPath: lockKey } = await open();
  return withTargetLock(lockKey, async () => {
    const { content: current, realPath } = await open();
    if (realPath !== lockKey) {
      throw new EditFileError('stale', 'file changed identity while the edit was queued');
    }

    // Compare-and-swap precondition (optional). Reject if the live content no
    // longer matches what the caller based its edit on — this is what makes a
    // lost-response retry or a concurrent edit safe (a replayed old->new edit
    // would otherwise re-apply, and two racing edits would lose the first write).
    if (hasExpected) {
      const actual = createHash('sha256').update(current).digest('hex');
      if (actual.toLowerCase() !== params.expected_sha256.toLowerCase()) {
        throw new EditFileError('stale', 'file no longer matches expected_sha256');
      }
    }

    let next;
    if (hasContent) {
      next = params.content;
    } else {
      const before = current.toString('utf8');
      // A targeted edit rewrites the WHOLE file from its decoded text, so bytes
      // that do not survive a UTF-8 round-trip (binary, latin1) would be
      // replaced with U+FFFD far from the edited span. Refuse, as read_file does.
      if (!Buffer.from(before, 'utf8').equals(current)) {
        throw new EditFileError('not_text', 'file is not valid utf-8 text (would not round-trip)');
      }
      const occurrences = countOccurrences(before, params.old_string);
      if (occurrences === 0) {
        throw new EditFileError('not_found', 'old_string not present in file');
      }
      if (occurrences > 1) {
        throw new EditFileError('ambiguous_match', `old_string occurs ${occurrences} times; must be unique`);
      }
      // Literal splice (indexOf + slice) — NOT String.replace, which would
      // interpret $&, $1, ${...} sequences in new_string.
      const idx = before.indexOf(params.old_string);
      next = before.slice(0, idx) + params.new_string + before.slice(idx + params.old_string.length);
    }

    const nextBytes = Buffer.byteLength(next, 'utf8');
    if (nextBytes > maxBytes) {
      throw new EditFileError('too_large', `result ${nextBytes} exceeds ${maxBytes} bytes`);
    }

    // Preserve the target's permission bits. The atomic writer replaces the
    // target with a freshly created inode, which would otherwise take default
    // umask perms — silently loosening a 0600 secret to 0644 or stripping +x
    // from a 0700 script. The mode is handed to the atomic writer, which sets it
    // on the TEMP file before the rename, so the new content is never published
    // under looser permissions, not even briefly. A mode we cannot read refuses
    // the edit rather than guessing. Owner is preserved implicitly: the bridge
    // process recreates the file as the same uid.
    let priorMode;
    try {
      priorMode = statSync(realPath).mode & 0o7777;
    } catch {
      throw new EditFileError('unreadable', 'could not read the file mode');
    }

    // NOTE (accepted residual, consistent with file-link-guard's own posture):
    // validateAndOpen is fd-pinned, but the writer commits through the
    // resolved PATHNAME, so a hostile local process that renames a PARENT
    // directory between validation and the temp-write+rename could redirect the
    // write. Pure Node exposes no openat/renameat to hold a directory capability
    // across the commit, and file-link-guard.js accepts this same parent-swap
    // window on the single-user Linux deployment. It
    // requires a second local principal with write access to a pinned-root
    // parent, which is outside this box's single-user threat model. Documented,
    // not silently ignored; revisit if a guarded-write openat primitive lands.
    deps.atomicWrite(realPath, next, { mode: priorMode });
    return { path: realPath, bytes: nextBytes, mode: hasContent ? 'content' : 'replace' };
  });
}
