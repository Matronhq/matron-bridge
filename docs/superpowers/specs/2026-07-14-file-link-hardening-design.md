# File-Link Hardening — Design

**Decision (2026-07-14):** gate the viewer links the bridge posts for files
Claude writes/edits, at both ends. Today `generateFileLink` (index.js) signs
a link for ANY `Write`/`Edit` target with no checks, and the viewer's
`/view` route serves whatever the signed token names — following symlinks,
any size, any path. Tool output became ephemeral for exactly this class of
risk (24h journal purge); file links are the same "sensitive material leaks
by default" hole on the file path. The checks are adapted from closed PR #54
(easelyte), whose denylist/scoping/serve-time-revalidation ideas were sound;
the PR itself was 167 commits stale and built pre-journal.

Threat model: the links land in the user's own E2E Matrix room, so the
audience is link holders within the 15-minute expiry (`LINK_EXPIRY_MS`
default). The gate is against accidental exposure — a `.env` or key file
Claude touches becoming a click-to-view URL over the public tunnel — and
against the file at the linked path changing between link-post and click
(symlink swap, replacement). Not in scope: authenticating the viewer itself
(Cloudflare tunnel policy exists), binary rendering, a `/download` route, a
per-session toggle or env kill-switch (denied links just fall back to the
existing plain-text rendering — that IS the off state).

## Components

### `lib/file-link-guard.js` (new)

- `isSensitivePath(filePath)` — pure denylist test. Basename patterns:
  `.env(.*)`, `secrets.(json|yaml|yml|toml|txt)`, `credentials(.ext)`,
  `*.pem/key/p12/pfx/jks/keystore`, `id_rsa`/`id_ed25519`/`id_ecdsa`,
  `.npmrc`, `.netrc`, `token(s).(json|txt)`, `service[-_]account*.json`,
  `.htpasswd`, `config.json` (this ecosystem's config.json files hold
  tokens — `~/.claude-matrix-config.json`). Path patterns: any segment under
  `/.aws/`, `/.docker/`, `/.kube/`, `/.ssh/`, `/.gnupg/`. All
  case-insensitive. Same lists as PR #54.
- `checkFileLink(filePath, workdir)` — sync generation-time gate. Returns
  `{ ok: true }` or `{ ok: false, reason: 'sensitive' | 'outside-workdir' }`.
  Containment is lexical (`path.resolve` prefix with a `/` boundary so
  `/home/x/proj-evil` is not inside `/home/x/proj`): at `tool_use` time the
  Write target may not exist yet, so realpath is impossible — the hard
  boundary is serve time; this gate is UX (don't post links that will 404).
  No workdir (falsy) → containment check is skipped, denylist still applies.
- `MAX_VIEW_BYTES = 5 * 1024 * 1024`.
- `validateAndOpen(filePath, { workdir, maxBytes = MAX_VIEW_BYTES })` —
  async serve-time boundary, used by the viewer:
  1. `fsp.open(filePath, O_RDONLY | O_NOFOLLOW)` — a symlink at the final
     component fails (ELOOP).
  2. `readlink('/proc/self/fd/<fd>')` → the file's REAL path (Linux; this
     service is Linux-only) — immune to races between check and read since
     every later step uses the fd.
  3. Re-check `isSensitivePath(realPath)`; if `workdir` given, realpath the
     workdir and require containment of `realPath` (covers symlinked parent
     dirs, which O_NOFOLLOW does not).
  4. `fd.stat()` — regular file, `size <= maxBytes`.
  5. Read content from the fd. Return `{ content, realPath }`. Close the fd
     in a `finally`.
  - Every rejection throws `FileLinkDenied` (carries `reason`); callers map
    ANY failure — denied, missing, oversize — to a uniform 404 (no
    information leak about why; matches matron-journal's 404-not-403
    stance).

### `index.js`

- `generateFileLink(filePath, workdir)` gains the workdir param and the
  generation gate: `checkFileLink` first — denied returns `null` (both call
  sites already render a plain non-link line on null, which becomes the
  denied UX) and logs one greppable line
  `file-link denied (<reason>): <path>`. The signed payload gains `workdir`
  (`{path, exp, workdir}`) so the viewer can enforce containment at serve
  time. Both call sites (`Write`/`Edit` tool_use seam) pass
  `session.workdir`.

### `viewer/server.js`

- `/view` replaces its `fs.readFile(path.resolve(data.path))` body with
  `validateAndOpen(data.path, { workdir: data.workdir })`; `FileLinkDenied`
  and all fs errors → 404 `File not found` (existing 400/403 token handling
  unchanged). Legacy tokens without `workdir` (pre-upgrade links, ≤15 min
  old at deploy) still get the denylist + symlink + size checks — only
  containment is skipped.
- Content renders through the existing `renderHtml` (utf-8), unchanged.

## Testing

- `test/file-link-guard.test.js` (new, unit): denylist table (positive:
  `.env`, `.env.local`, `x.pem`, `id_rsa`, `~/.aws/credentials`,
  `secrets.yaml`, `config.json`; negative: `index.js`, `env.md`,
  `configuration.json`); lexical containment incl. the `proj` vs
  `proj-evil` prefix case and relative→absolute resolution; `checkFileLink`
  reason values; `validateAndOpen` against tmpdir fixtures: normal file OK
  (content + realPath), symlink-to-outside rejected, symlink final
  component rejected (O_NOFOLLOW), oversize rejected (small maxBytes
  override), directory rejected, missing rejected, sensitive real path
  rejected even when reached via an innocent-named symlink.
- `test/viewer-view.test.js` (extend, real-server integration): workdir
  token for a normal file → 200 with content; sensitive file in workdir →
  404; file outside the token's workdir → 404; symlink inside workdir →
  outside file → 404; legacy token (no workdir) normal file → 200; legacy
  token sensitive file → 404.
- index.js seam has no unit harness (established); `npm run check` + full
  suite + the viewer integration tests carry it.
- `lib/file-link-guard.js` joins the `check` script.

## Out of scope (recorded)

- `/download` route, `!file_link` toggle, env kill-switch (PR #54 had
  these; YAGNI here).
- Journal `file` events as the strategic replacement for viewer file links —
  future client work.
- Binary/media rendering in the viewer.
