# File-Link Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the viewer links posted for files Claude writes/edits — denylist + workdir scoping at link generation, and an fd-pinned symlink/sensitivity/containment/size boundary at serve time in the viewer.

**Architecture:** New `lib/file-link-guard.js` holds both layers (sync `checkFileLink` for generation, async `validateAndOpen` for serving). `viewer/server.js`'s `/view` route swaps its raw `readFile` for `validateAndOpen` with uniform 404 on any denial. `index.js`'s `generateFileLink` gains the generation gate and embeds `workdir` in the signed token.

**Tech Stack:** Node ESM, vitest, Linux-only `/proc/self/fd` realpath (matches deployment), no new dependencies.

**Spec:** docs/superpowers/specs/2026-07-14-file-link-hardening-design.md

## Global Constraints

- Denylist regexes are copied from PR #54 verbatim (basename + path-segment lists in Task 1) — do not "improve" them.
- `MAX_VIEW_BYTES = 5 * 1024 * 1024`.
- Serve-time rejections are a uniform `404` / `File not found` — the response must not distinguish denied / missing / oversize / symlink (no information leak). Existing 400 (missing token) and 403 (bad token) behavior unchanged.
- Legacy tokens (payload without `workdir`) still get denylist + symlink + size checks; only containment is skipped.
- Denied link generation returns `null` — both call sites already render plain non-link text on `null`; do not change that fallback.
- Containment must be path-boundary-safe: `/a/b` contains `/a/b/c` but NOT `/a/bc`.
- All reads in the viewer go through the validated fd (never re-open by path after checking).
- Commits use conventional messages with trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `lib/file-link-guard.js`

**Files:**
- Create: `lib/file-link-guard.js`
- Create: `test/file-link-guard.test.js`
- Modify: `package.json` (check script)

**Interfaces:**
- Produces: `isSensitivePath(filePath)` → bool; `checkFileLink(filePath, workdir)` → `{ok:true} | {ok:false, reason:'sensitive'|'outside-workdir'}`; `validateAndOpen(filePath, {workdir, maxBytes?})` → `Promise<{content: Buffer, realPath: string}>` throwing `FileLinkDenied` (has `.reason`); `MAX_VIEW_BYTES`. Task 2 consumes `validateAndOpen` + `FileLinkDenied`; Task 3 consumes `checkFileLink`.

- [ ] **Step 1: Write the failing tests** — `test/file-link-guard.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isSensitivePath, checkFileLink, validateAndOpen, FileLinkDenied, MAX_VIEW_BYTES,
} from '../lib/file-link-guard.js';

describe('isSensitivePath', () => {
  it.each([
    '/w/.env', '/w/.env.local', '/w/prod.env', '/w/secrets.yaml', '/w/secret.json',
    '/w/credentials', '/w/credentials.json', '/w/server.pem', '/w/app.key',
    '/w/id_rsa', '/w/id_ed25519.pub', '/w/.npmrc', '/w/.netrc', '/w/tokens.json',
    '/w/service-account-prod.json', '/w/.htpasswd', '/w/config.json',
    '/home/u/.aws/anything.txt', '/home/u/.ssh/known_hosts', '/home/u/.kube/cfg',
    '/home/u/.docker/x', '/home/u/.gnupg/x',
  ])('flags %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it.each([
    '/w/index.js', '/w/env.md', '/w/configuration.json', '/w/package.json',
    '/w/README.md', '/w/awsome/notes.txt', '/w/keyboard.js',
  ])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

describe('checkFileLink', () => {
  it('denies sensitive names with reason', () => {
    expect(checkFileLink('/w/proj/.env', '/w/proj')).toEqual({ ok: false, reason: 'sensitive' });
  });

  it('denies paths outside the workdir, boundary-safe', () => {
    expect(checkFileLink('/w/proj-evil/a.js', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
    expect(checkFileLink('/etc/hosts', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
  });

  it('allows the workdir itself and files under it', () => {
    expect(checkFileLink('/w/proj/src/a.js', '/w/proj')).toEqual({ ok: true });
    expect(checkFileLink('/w/proj', '/w/proj')).toEqual({ ok: true });
  });

  it('resolves relative segments before checking', () => {
    expect(checkFileLink('/w/proj/src/../../other/a.js', '/w/proj')).toEqual({ ok: false, reason: 'outside-workdir' });
  });

  it('skips containment without a workdir but keeps the denylist', () => {
    expect(checkFileLink('/anywhere/a.js', null)).toEqual({ ok: true });
    expect(checkFileLink('/anywhere/.env', null)).toEqual({ ok: false, reason: 'sensitive' });
  });
});

describe('validateAndOpen', () => {
  let dir, outside;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'flg-work-'));
    outside = mkdtempSync(path.join(tmpdir(), 'flg-outside-'));
    writeFileSync(path.join(dir, 'ok.txt'), 'hello guard\n');
    writeFileSync(path.join(dir, '.env'), 'SECRET=1\n');
    writeFileSync(path.join(outside, 'target.txt'), 'outside content\n');
    symlinkSync(path.join(outside, 'target.txt'), path.join(dir, 'sneaky.txt'));
    writeFileSync(path.join(outside, 'config.json'), '{"token":"x"}\n');
    symlinkSync(path.join(outside, 'config.json'), path.join(dir, 'innocent.txt'));
    writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(64));
    mkdirSync(path.join(dir, 'sub'));
  });
  afterAll(() => {
    for (const d of [dir, outside]) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
  });

  const denied = async (p, opts) => {
    try {
      await validateAndOpen(p, opts);
    } catch (err) {
      expect(err).toBeInstanceOf(FileLinkDenied);
      return err.reason;
    }
    throw new Error('expected FileLinkDenied');
  };

  it('returns content and realPath for a normal file in the workdir', async () => {
    const { content, realPath } = await validateAndOpen(path.join(dir, 'ok.txt'), { workdir: dir });
    expect(content.toString('utf-8')).toBe('hello guard\n');
    expect(path.basename(realPath)).toBe('ok.txt');
  });

  it('rejects a symlink at the final component', async () => {
    expect(await denied(path.join(dir, 'sneaky.txt'), { workdir: dir })).toBe('symlink');
  });

  it('rejects a sensitive file', async () => {
    expect(await denied(path.join(dir, '.env'), { workdir: dir })).toBe('sensitive');
  });

  it('rejects a file over maxBytes', async () => {
    expect(await denied(path.join(dir, 'big.txt'), { workdir: dir, maxBytes: 16 })).toBe('too-large');
  });

  it('rejects a directory', async () => {
    expect(await denied(path.join(dir, 'sub'), { workdir: dir })).toMatch(/not-a-file|unreadable/);
  });

  it('rejects a missing file', async () => {
    expect(await denied(path.join(dir, 'nope.txt'), { workdir: dir })).toBe('unreadable');
  });

  it('rejects content outside the workdir even without a symlink', async () => {
    expect(await denied(path.join(outside, 'target.txt'), { workdir: dir })).toBe('outside-workdir');
  });

  it('skips containment for legacy calls without a workdir', async () => {
    const { content } = await validateAndOpen(path.join(outside, 'target.txt'), {});
    expect(content.toString('utf-8')).toBe('outside content\n');
  });

  it('exports a 5MB default cap', () => {
    expect(MAX_VIEW_BYTES).toBe(5 * 1024 * 1024);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/file-link-guard.test.js`
Expected: FAIL — cannot find module `../lib/file-link-guard.js`

- [ ] **Step 3: Implement** — `lib/file-link-guard.js`:

```js
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

// PR #54's lists, verbatim. config.json is deliberate: this ecosystem's
// config.json files hold tokens (~/.claude-matrix-config.json).
const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
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
];

export function isSensitivePath(filePath) {
  const basename = path.basename(filePath);
  if (SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(basename))) return true;
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
// reading THROUGH THE FD. Throws FileLinkDenied for every rejection; the
// caller maps all failures to one uniform response.
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
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/file-link-guard.test.js`
Expected: PASS

- [ ] **Step 5: Add to check script** — in `package.json`'s `"check"` script, insert `node --check lib/file-link-guard.js && ` immediately before `node --check lib/print-interrupt.js`. Run `npm run check` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/file-link-guard.js test/file-link-guard.test.js package.json
git commit -m "feat: file-link guard — denylist, workdir scoping, fd-pinned serve-time validation"
```

---

### Task 2: viewer `/view` serve-time boundary

**Files:**
- Modify: `viewer/server.js` (the `/view` route only)
- Modify: `test/viewer-view.test.js` (append a describe block)

**Interfaces:**
- Consumes: `validateAndOpen`, `FileLinkDenied` from Task 1.
- Produces: `/view` serves only validated files; token payloads may carry `workdir` (Task 3 will start embedding it). `generateSignedUrl(baseUrl, filePath, secret, expiry, extra)` already supports extra payload fields — tests use `extra = { path, workdir }`.

- [ ] **Step 1: Write the failing tests** — append to `test/viewer-view.test.js` (inside the file, after the existing describe; it already has `server`, `port`, `tmpDir` from `beforeAll`, and imports `generateSignedUrl` from `../viewer/server.js` per test):

```js
describe('GET /view (hardened)', () => {
  it('serves a normal file inside the token workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'guarded-ok.js');
    writeFileSync(filePath, 'const ok = true;\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('const ok = true;');
  });

  it('404s a sensitive file even inside the workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, '.env');
    writeFileSync(filePath, 'SECRET=1\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('SECRET');
  });

  it('404s a file outside the token workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const inner = path.join(tmpDir, 'inner-workdir');
    mkdirSync(inner, { recursive: true });
    const filePath = path.join(tmpDir, 'outside-inner.txt');
    writeFileSync(filePath, 'outside inner\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: inner });
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('404s a symlink pointing outside the workdir', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const inner = path.join(tmpDir, 'sym-workdir');
    mkdirSync(inner, { recursive: true });
    const target = path.join(tmpDir, 'sym-target.txt');
    writeFileSync(target, 'reached through symlink\n');
    const linkPath = path.join(inner, 'link.txt');
    symlinkSync(target, linkPath);
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, linkPath, undefined, 60, { path: linkPath, workdir: inner });
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('reached through symlink');
  });

  it('404s an oversized file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'huge.txt');
    writeFileSync(filePath, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60, { path: filePath, workdir: tmpDir });
    const res = await fetch(url);
    expect(res.status).toBe(404);
  });

  it('legacy token without workdir: still serves a normal file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'legacy-ok.txt');
    writeFileSync(filePath, 'legacy fine\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('legacy fine');
  });

  it('legacy token without workdir: still 404s a sensitive file', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'service-account-prod.json');
    writeFileSync(filePath, '{"private_key":"x"}\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('private_key');
  });
});
```

Extend the file's `node:fs` import line with `symlinkSync` and `mkdirSync` (keep existing names).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/viewer-view.test.js`
Expected: the sensitive/outside/symlink/oversize cases FAIL (route serves them today); the two "serves" cases pass.

- [ ] **Step 3: Implement** — in `viewer/server.js`: add to the lib imports `import { validateAndOpen, FileLinkDenied } from '../lib/file-link-guard.js';` and replace the body of `app.get('/view', …)` with:

```js
app.get('/view', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).send('Missing token');

  const data = verifyToken(token);
  if (!data) return res.status(403).send('Invalid or expired token');

  try {
    // Serve-time boundary (lib/file-link-guard.js): fd-pinned symlink,
    // sensitivity, workdir-containment, and size checks. Legacy tokens
    // without a workdir still get everything but containment. Every
    // rejection — denied, missing, oversize — is a uniform 404 so the
    // response leaks nothing about why.
    const { content, realPath } = await validateAndOpen(data.path, { workdir: data.workdir });
    res.type('html').send(renderHtml(path.basename(realPath), content.toString('utf-8')));
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) console.error('Error reading file:', err);
    res.status(404).send('File not found');
  }
});
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/viewer-view.test.js test/file-link-guard.test.js`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add viewer/server.js test/viewer-view.test.js
git commit -m "feat(viewer): /view serves only guard-validated files, uniform 404 on denial"
```

---

### Task 3: index.js generation gate + workdir-bearing tokens

**Files:**
- Modify: `index.js` only.

**Interfaces:**
- Consumes: `checkFileLink` from Task 1.
- Produces: `generateFileLink(filePath, workdir)`; token payload `{path, exp, workdir}`.

- [ ] **Step 1: Import** — add to index.js's lib imports (near the other `./lib/` imports, ~line 30-50):

```js
import { checkFileLink } from './lib/file-link-guard.js';
```

- [ ] **Step 2: Gate the generator** — replace `function generateFileLink(filePath) { … }` (~index.js:267) with:

```js
function generateFileLink(filePath, workdir) {
  if (!HMAC_SECRET || !VIEWER_BASE_URL) return null;
  // Generation-time gate (UX — the viewer re-validates at serve time with
  // the fd-pinned checks): sensitive names and out-of-workdir targets never
  // get a link; callers render plain text on null.
  const gate = checkFileLink(filePath, workdir);
  if (!gate.ok) {
    console.log(`file-link denied (${gate.reason}): ${filePath}`);
    return null;
  }
  const exp = Math.floor((Date.now() + LINK_EXPIRY_MS) / 1000);
  const payload = Buffer.from(JSON.stringify({ path: filePath, exp, workdir: workdir || null })).toString('base64url');
  const sig = createHmac('sha256', HMAC_SECRET).update(payload).digest('base64url');
  return `${VIEWER_BASE_URL}/view?token=${payload}.${sig}`;
}
```

- [ ] **Step 3: Pass workdir at both call sites** — in the `Write` and `Edit` branches of the tool_use seam (~index.js:2233 and ~2246), change `const link = generateFileLink(absPath);` to:

```js
            const link = generateFileLink(absPath, session.workdir);
```

(both occurrences; they are inside branches that already reference `session.workdir` for `absPath`).

- [ ] **Step 4: Verify**

Run: `npm run check` — exit 0.
Run: `npx vitest run test/file-link-guard.test.js test/viewer-view.test.js` — PASS.
Run: `npm run ci` — full suite green (pre-existing skips OK), audit clean.

- [ ] **Step 5: Commit**

```bash
git add index.js
git commit -m "feat: gate Write/Edit viewer links — denylist + workdir scoping, workdir-bearing tokens"
```
