// Gates the viewer links the bridge posts for files Claude writes/edits
// (spec: docs/superpowers/specs/2026-07-14-file-link-hardening-design.md).
// Denylist + scoping adapted from PR #54. Two layers:
//   - checkFileLink: cheap sync gate at link GENERATION (tool_use time; the
//     Write target may not exist yet, so containment is lexical) — UX so we
//     don't post links that will 404, not the security boundary.
//   - validateAndOpen: the serve-time boundary in the viewer — fd-pinned so
//     nothing can change between validation and read (Linux /proc/self/fd,
//     like the rest of this deployment).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_VIEW_BYTES = 5 * 1024 * 1024;

// Basename patterns: PR #54 verbatim plus ^secrets?$ added in review. config.json
// is deliberate: this ecosystem's config.json files hold tokens
// (~/.claude-matrix-config.json). Patterns apply to every path segment (directories
// with sensitive-shaped names deny their contents). Path patterns: original five
// dot-dirs from PR #54 verbatim, plus directory-segment patterns added in review
// to flag files inside sensitive directories (e.g., .env/apikey.dat, secrets/db.dat).
// Basename patterns vs. explicit SENSITIVE_PATH_PATTERNS are kept for
// readability/defense-in-depth even where the per-segment rule overlaps.
const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^secrets?$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /\/\.env(\.[^/]*)?\//i,
  /\/secrets?\//i,
  /\/credentials?\//i,
];

export function isSensitivePath(filePath) {
  const segments = String(filePath).split(path.sep).filter(Boolean);
  if (segments.some((seg) => SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(seg)))) return true;
  if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))) return true;
  return false;
}

// Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc.
function contains(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

export function checkFileLink(filePath, workdir) {
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, reason: 'sensitive' };
  if (workdir && !contains(path.resolve(workdir), resolved)) {
    return { ok: false, reason: 'outside-workdir' };
  }
  return { ok: true };
}

export class FileLinkDenied extends Error {
  constructor(reason) {
    super(`file link denied: ${reason}`);
    this.name = 'FileLinkDenied';
    this.reason = reason;
  }
}

// Serve-time boundary. Opens with O_NOFOLLOW (a symlink final component
// fails with ELOOP), resolves the fd's REAL path via /proc/self/fd (immune
// to path swaps after open — symlinked parent dirs land on their target
// here), then re-checks sensitivity, containment, type, and size before
// reading THROUGH THE FD. Throws FileLinkDenied for every rejection it
// detects; an unexpected system error (procfs missing, EIO) propagates raw —
// callers must 404 on ANY throw, not just FileLinkDenied.
export async function validateAndOpen(filePath, { workdir, maxBytes = MAX_VIEW_BYTES } = {}) {
  let fd;
  try {
    try {
      fd = await fsp.open(path.resolve(filePath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    const realPath = await fsp.readlink(`/proc/self/fd/${fd.fd}`);
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    if (workdir) {
      let realWorkdir;
      try {
        realWorkdir = await fsp.realpath(workdir);
      } catch {
        throw new FileLinkDenied('bad-workdir');
      }
      if (!contains(realWorkdir, realPath)) throw new FileLinkDenied('outside-workdir');
    }
    const stat = await fd.stat();
    if (!stat.isFile()) throw new FileLinkDenied('not-a-file');
    if (stat.size > maxBytes) throw new FileLinkDenied('too-large');
    const content = await fd.readFile();
    return { content, realPath };
  } finally {
    await fd?.close().catch(() => {});
  }
}
