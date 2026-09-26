import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The viewer token now carries the session's pinned authorization roots. These
// tests pin down the serve-time contract for BOTH /view and /download:
//   - a token with valid pinnedRoots is contained by that pinned identity,
//     regardless of the token's workdir;
//   - an empty pinned set is a BROKEN capability, refused as a uniform 404
//     rather than falling back to the workdir check;
//   - a legacy token with no pinnedRoots field keeps the workdir behaviour.
let server, port, tmpDir, scopedRoot, inScopeFile, outOfScopeFile;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise((r) => server.on('listening', r));
  port = server.address().port;

  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-scope-pin-'));
  scopedRoot = path.join(tmpDir, 'scoped-root');
  mkdirSync(scopedRoot, { recursive: true });
  inScopeFile = path.join(scopedRoot, 'ok.txt');
  writeFileSync(inScopeFile, 'in scope content\n');
  // Sits inside the token workdir (tmpDir) but OUTSIDE the pinned root.
  outOfScopeFile = path.join(tmpDir, 'out.txt');
  writeFileSync(outOfScopeFile, 'out of scope content\n');
});
afterAll(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function viewUrl(extra) {
  const { generateSignedUrl } = await import('../viewer/server.js');
  return generateSignedUrl(`http://127.0.0.1:${port}`, extra.path, undefined, 60, extra);
}
async function downloadUrl(extra) {
  const { generateSignedUrl } = await import('../viewer/server.js');
  return generateSignedUrl(`http://127.0.0.1:${port}`, extra.path, undefined, 60, { ...extra, dl: true })
    .replace('/view', '/download');
}

describe('GET /view (pinned roots)', () => {
  it('serves an in-scope file when the token carries valid pinnedRoots', async () => {
    const res = await fetch(await viewUrl({ path: inScopeFile, workdir: scopedRoot, pinnedRoots: [scopedRoot] }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('in scope content');
  });

  it('404s a file outside the pinned roots even though the workdir contains it', async () => {
    // workdir=tmpDir contains outOfScopeFile, but pinnedRoots does not — the
    // pinned identity, not the workdir, is the authorization boundary.
    const res = await fetch(await viewUrl({ path: outOfScopeFile, workdir: tmpDir, pinnedRoots: [scopedRoot] }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('out of scope content');
  });

  it('404s a token carrying an EMPTY pinned set (broken capability, no workdir fallback)', async () => {
    // Even though workdir=scopedRoot would contain the file, an empty pinned
    // set must be refused rather than falling back to the workdir check.
    const res = await fetch(await viewUrl({ path: inScopeFile, workdir: scopedRoot, pinnedRoots: [] }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('in scope content');
  });

  it('legacy token with no pinnedRoots still serves via the workdir check', async () => {
    const res = await fetch(await viewUrl({ path: inScopeFile, workdir: scopedRoot }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('in scope content');
  });
});

describe('GET /download (pinned roots)', () => {
  it('serves an in-scope file when the token carries valid pinnedRoots', async () => {
    const res = await fetch(await downloadUrl({ path: inScopeFile, workdir: scopedRoot, pinnedRoots: [scopedRoot] }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('in scope content');
  });

  it('404s a file outside the pinned roots even though the workdir contains it', async () => {
    const res = await fetch(await downloadUrl({ path: outOfScopeFile, workdir: tmpDir, pinnedRoots: [scopedRoot] }));
    expect(res.status).toBe(404);
  });

  it('404s a token carrying an EMPTY pinned set (broken capability)', async () => {
    const res = await fetch(await downloadUrl({ path: inScopeFile, workdir: scopedRoot, pinnedRoots: [] }));
    expect(res.status).toBe(404);
  });

  it('legacy token with no pinnedRoots still serves via the workdir check', async () => {
    const res = await fetch(await downloadUrl({ path: inScopeFile, workdir: scopedRoot }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('in scope content');
  });
});
