// MATRON.md: a repository's instructions for Matron sessions only.
//
// CLAUDE.md and AGENTS.md are read by every Claude Code or Codex run in a
// repository, inside Matron or not, so instructions about the tracker, rooms
// or missions put there confuse a plain run that has none of those tools. A
// repository puts them in MATRON.md instead, and the bridge adds them to the
// instructions it already gives each session (lib/coordinator.js), so only a
// Matron session ever sees them.
//
// Which files: every MATRON.md from the repository root down to the
// session's workdir, root first, so the deeper (more specific) file reads
// last. The root is the nearest ancestor holding a `.git` entry (a directory
// in a clone, a file in a worktree or submodule); a workdir outside any
// repository reads only its own MATRON.md. There is no lazy loading of
// nested files the way Claude Code loads a nested CLAUDE.md on first touch:
// the bridge cannot see which files a session opens, so a subdirectory's
// MATRON.md applies only to a session whose workdir is inside it.
//
// When: read afresh on every spawn (start, resume, respawn, restart), never
// cached, so an edit takes effect at the session's next restart. A `cd`
// inside a session changes nothing, as with CLAUDE.md.
//
// Synchronous because createSession is, and it never throws: an unreadable
// file is skipped with a warning, and the session starts without it.
import fs from 'node:fs';
import path from 'node:path';

export const MATRON_MD_NAME = 'MATRON.md';
export const MATRON_MD_MAX_BYTES = 24 * 1024;
// Ancestors walked looking for the repository root before giving up; a
// workdir nested deeper than this inside a repository is not a real case.
const MAX_DEPTH = 64;

const HEADING = '## Repository instructions for Matron sessions (MATRON.md)';
const INTRO = [
  "These come from the repository you are working in, like its CLAUDE.md or AGENTS.md, and are given only to Matron sessions.",
  'They add to CLAUDE.md and AGENTS.md, and where the two disagree in a Matron session, follow these.',
  "The user's memories (below) take precedence over them, and so do the bridge's rules on sensitive data and on turns started by another person.",
  'Files are listed from the repository root down to your working directory; a deeper file is the more specific one.',
].join(' ');
export const MATRON_MD_TRUNCATED = `[MATRON.md instructions truncated: more than ${MATRON_MD_MAX_BYTES / 1024} KB in total. The rest was not loaded.]`;

const isEntry = (fsImpl, p) => {
  try {
    fsImpl.statSync(p);
    return true;
  } catch {
    return false;
  }
};

// The directories to read, root first: from the repository root (nearest
// ancestor with `.git`) down to workdir, or just workdir outside a repo.
export function matronMdDirs(workdir, { fsImpl = fs } = {}) {
  if (typeof workdir !== 'string' || !workdir) return [];
  const start = path.resolve(workdir);
  const chain = [];
  let dir = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    chain.push(dir);
    if (isEntry(fsImpl, path.join(dir, '.git'))) return chain.reverse();
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return [start];
}

// Cut text to at most maxBytes of UTF-8 without splitting a character.
function cutToBytes(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

// { files: [{ path, rel, bytes }], block, truncated }. `rel` is the file's
// path relative to the repository root (or just `MATRON.md`), `bytes` its
// size on disk, `block` the prompt section ('' when nothing was found).
export function loadMatronMd(workdir, { fsImpl = fs, maxBytes = MATRON_MD_MAX_BYTES, log = console } = {}) {
  const warn = (msg) => { try { log.warn(msg); } catch { /* logging must never throw */ } };
  const dirs = matronMdDirs(workdir, { fsImpl });
  const root = dirs[0];
  const files = [];
  const sections = [];
  let budget = maxBytes;
  let truncated = false;
  for (const dir of dirs) {
    const file = path.join(dir, MATRON_MD_NAME);
    let text;
    try {
      if (!fsImpl.statSync(file).isFile()) continue;
      text = String(fsImpl.readFileSync(file, 'utf8')).trim();
    } catch (e) {
      if (e?.code !== 'ENOENT' && e?.code !== 'ENOTDIR') warn(`[matron-md] could not read ${file}: ${e.message} — skipped`);
      continue;
    }
    const rel = path.relative(root, file) || MATRON_MD_NAME;
    const bytes = Buffer.byteLength(text, 'utf8');
    files.push({ path: file, rel, bytes });
    if (!text) continue;
    if (truncated) continue;
    let body = text;
    if (bytes > budget) {
      body = cutToBytes(text, budget);
      truncated = true;
      warn(`[matron-md] ${file} takes MATRON.md instructions over ${maxBytes} bytes — truncated`);
    }
    budget -= Buffer.byteLength(body, 'utf8');
    if (body) sections.push(`### ${rel}\n\n${body}`);
  }
  if (!sections.length) return { files, block: '', truncated };
  if (truncated) sections.push(MATRON_MD_TRUNCATED);
  return { files, block: [HEADING, INTRO, ...sections].join('\n\n'), truncated };
}

const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

// 'MATRON.md (3.1 KB), editor/MATRON.md (410 B)', with ', truncated' when
// the cap cut it; '' when the spawn found no file.
export function matronMdFileList(loaded) {
  const files = Array.isArray(loaded?.files) ? loaded.files : [];
  if (!files.length) return '';
  const list = files.map((f) => `${f.rel} (${size(f.bytes)})`).join(', ');
  return `${list}${loaded.truncated ? ', truncated' : ''}`;
}

// The line the start, resume and restart messages and /status carry:
// 'MATRON.md: MATRON.md (3.1 KB)'. '' when no file was found.
export function matronMdStatusLine(loaded) {
  const list = matronMdFileList(loaded);
  return list ? `MATRON.md: ${list}` : '';
}
