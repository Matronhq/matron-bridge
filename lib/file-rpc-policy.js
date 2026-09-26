// Extra credential denylist for the read_file / edit_file RPCs.
//
// Those RPCs return file content to (or write it from) a remote client, so
// they apply a stricter policy than the shared file-link-guard denylist,
// which also serves show_file and the viewer. On a box whose DEFAULT_WORKDIR
// is the home directory, the files below sit inside the allowed root and
// carry tokens or passwords in plain text. This is layered ON TOP of
// validateAndOpen's own isSensitivePath check, never instead of it.
import path from 'node:path';

// Directory names: any path segment matching one denies the whole subtree.
const CREDENTIAL_DIRS = new Set([
  '.ssh', '.aws', '.gnupg', '.kube', '.docker',
  '.codex', '.config', '.claude', '.gcloud', '.azure',
]);

const CREDENTIAL_BASENAMES = [
  /^\.envrc$/i,
  /^auth\.json$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^\.claude\.json$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.htpasswd$/i,
  /^\.pypirc$/i,
  /^\.[a-z0-9]*_history$/i,
];

// A denylist is a backstop for well-known locations, not a guarantee that
// nothing secret is reachable; the opt-in and narrow roots are the real
// boundary.
export function isCredentialPath(filePath) {
  const segments = path.resolve(String(filePath)).split(path.sep).filter(Boolean);
  if (segments.some((segment) => CREDENTIAL_DIRS.has(segment.toLowerCase()))) return true;
  const base = segments[segments.length - 1] || '';
  // A repository's .git/config can carry credentials in a remote URL.
  if (base.toLowerCase() === 'config' && (segments[segments.length - 2] || '').toLowerCase() === '.git') return true;
  return CREDENTIAL_BASENAMES.some((re) => re.test(base));
}
