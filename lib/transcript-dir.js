import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Single source of truth for mapping an absolute workdir to the transcript
// directory name Claude Code writes under ~/.claude/projects/. Claude derives
// that name from the session's realpathed cwd, so every bridge site that reads,
// tails, resumes, or lists a transcript must encode the workdir the exact same
// way — otherwise it points at a directory Claude never created.
//
// The encoder matches the CLI byte for byte:
//   1. Replace EVERY non-alphanumeric char with `-` (so `/`, `.`, `_`, space,
//      etc all collapse to a dash). Encoding only `/` was the original bug:
//      a path like `/home/dan/my_app` must become `-home-dan-my-app`, and a
//      dotted path like `/home/dan/.config/ws` becomes `-home-dan--config-ws`
//      (double dash), not `-home-dan-.config-ws`.
//   2. Only when the dashed segment exceeds 200 chars, truncate to 200 and
//      append `-<hash>`, where the hash is a base36 of the 32-bit string hash
//      of the ORIGINAL (pre-dash) path. Claude hashes the raw path, not the
//      dashed segment, so we must too.

const MAX_ENCODED_LEN = 200;

// 32-bit string hash matching Claude Code's cwd hash: h = (h * 31 + c) | 0,
// seeded at 0, iterating UTF-16 code units. Kept identical to the CLI so the
// truncation suffix lands on the same directory the CLI wrote.
function hashPath(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i) | 0;
  }
  return hash;
}

// Encode a path to Claude Code's project-dir segment, byte for byte. Operates
// on the string as given — callers that need symlink resolution should pass a
// realpathed path (see resolveWorkdir / encodeProjectDir).
export function encodeProjectSegment(absPath) {
  const dashed = absPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (dashed.length <= MAX_ENCODED_LEN) return dashed;
  return `${dashed.slice(0, MAX_ENCODED_LEN)}-${Math.abs(hashPath(absPath)).toString(36)}`;
}

// Resolve a workdir the way Claude Code does before encoding: it realpaths the
// cwd, so a symlinked workdir lands in the same transcript dir the CLI writes
// to. path.resolve alone does NOT resolve symlinks, so we realpath and fall
// back to path.resolve when the path does not exist yet (realpathSync throws
// ENOENT for a not-yet-created dir) — that still yields a stable absolute
// encoding, and a workdir Claude has never run in has no transcript anyway.
//
// Residual edge: because the canonical target is recomputed from the live
// filesystem on each call rather than persisted at session creation, a session
// started through a symlink that is later RETARGETED or DELETED can resolve to
// a different (or lexical-fallback) directory and miss its transcript. A full
// fix would persist the realpathed workdir with the session record and search
// transcript dirs by session ID for legacy records — a persistence-layer change
// left as a follow-up. For a stable symlink (the normal case) this matches the
// CLI exactly, which the prior `/`-only encoder never did.
export function resolveWorkdir(workdir) {
  const resolved = path.resolve(workdir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

// The encoded project-dir segment for a workdir (realpath + CLI encoding).
export function encodeProjectDir(workdir) {
  return encodeProjectSegment(resolveWorkdir(workdir));
}

// ~/.claude/projects/<encoded-workdir>
export function projectDirFor(workdir) {
  return path.join(os.homedir(), '.claude', 'projects', encodeProjectDir(workdir));
}

// ~/.claude/projects/<encoded-workdir>/<sessionId>.jsonl
export function transcriptPathFor(workdir, sessionId) {
  return path.join(projectDirFor(workdir), `${sessionId}.jsonl`);
}

// ~/.claude/projects/<encoded-workdir>/<sessionId>/subagents
export function subagentsDirFor(workdir, sessionId) {
  return path.join(projectDirFor(workdir), sessionId, 'subagents');
}
