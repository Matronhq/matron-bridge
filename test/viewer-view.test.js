import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let server, port, tmpDir;
beforeAll(async () => {
  process.env.HMAC_SECRET = 'test-secret';
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0); // 0 = ephemeral port
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
  tmpDir = mkdtempSync(path.join(tmpdir(), 'viewer-view-test-'));
});
afterAll(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe('GET /view', () => {
  it('HTML-escapes the filename (title, header, language class)', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const evilName = 'x<img src=q onerror=alert(1)>.j"s';
    const filePath = path.join(tmpDir, evilName);
    writeFileSync(filePath, 'hello world\n');

    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<img');
    expect(body).toContain('&lt;img');
    // The dirty extension must not leak into the class attribute.
    expect(body).not.toContain('language-j"s');
    expect(body).toContain('hello world');
  });

  it('still renders a normal file with its language class', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'plain.js');
    writeFileSync(filePath, 'const a = 1;\n');

    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('language-js');
    expect(body).toContain('plain.js');
    expect(body).toContain('const a = 1;');
  });

  it('rejects a repeated token query param (array) without crashing', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const filePath = path.join(tmpDir, 'plain2.js');
    writeFileSync(filePath, 'ok\n');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, filePath, undefined, 60);
    const token = url.split('token=')[1];

    const res = await fetch(`http://127.0.0.1:${port}/view?token=${token}&token=${token}`);
    expect(res.status).toBe(403);
    // Server must still be alive and serving.
    const ok = await fetch(url);
    expect(ok.status).toBe(200);
  });
});

describe('GET /secret', () => {
  it('HTML-escapes the label in the secret form', async () => {
    const { generateSignedUrl } = await import('../viewer/server.js');
    const url = generateSignedUrl(`http://127.0.0.1:${port}`, null, undefined, 60, {
      secretId: 's1',
      label: '"><script>alert(1)</script>',
    }).replace('/view', '/secret');

    const res = await fetch(url);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});
