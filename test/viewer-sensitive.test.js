import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';

// /sensitive proxies the bridge API and renders a one-time page. These tests
// stub the bridge API and drive the real viewer server, mirroring
// viewer-view.test.js. The download affordance is client-side (Blob from the
// already-fetched content), so the one-time semantics stay at the API layer.

let server, port, apiServer, apiPort;
let apiResponse; // set per-test: { status, body }

function sensitiveToken(payload, secret = 'test-secret') {
  const body = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 60,
    ...payload,
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

beforeAll(async () => {
  apiServer = http.createServer((req, res) => {
    res.writeHead(apiResponse.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(apiResponse.body));
  });
  await new Promise(r => apiServer.listen(0, '127.0.0.1', r));
  apiPort = apiServer.address().port;

  process.env.HMAC_SECRET = 'test-secret';
  process.env.MATRON_BRIDGE_API_PORT = String(apiPort);
  const { startServer } = await import('../viewer/server.js');
  server = startServer(0);
  await new Promise(r => server.on('listening', r));
  port = server.address().port;
});

afterAll(() => {
  server?.close();
  apiServer?.close();
});

async function fetchSensitive(payload) {
  const token = sensitiveToken(payload);
  return fetch(`http://127.0.0.1:${port}/sensitive?token=${encodeURIComponent(token)}`);
}

describe('sensitiveFilename', () => {
  it('prefers an explicit filename, sanitized to a safe basename', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('any label', 'install-christina.sh')).toBe('install-christina.sh');
    const traversal = sensitiveFilename('any label', '../../evil.sh');
    expect(traversal).not.toContain('/');
    expect(traversal.startsWith('.')).toBe(false);
    expect(traversal.endsWith('evil.sh')).toBe(true);
  });

  it('falls back to a filename-looking token in the label', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('install-jack.sh — dev-j setup script', undefined))
      .toBe('install-jack.sh');
  });

  it('falls back to a label slug with .txt when nothing looks like a filename', async () => {
    const { sensitiveFilename } = await import('../viewer/server.js');
    expect(sensitiveFilename('Database Password', undefined)).toBe('database-password.txt');
    expect(sensitiveFilename('///', undefined)).toBe('sensitive-data.txt');
  });
});

describe('GET /sensitive', () => {
  it('renders a download button with the resolved filename', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'Setup script', content: '#!/bin/sh\necho hi\n', filename: 'setup.sh' },
    };
    const res = await fetchSensitive({ sensitiveId: 'abc', label: 'Setup script' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Download');
    expect(html).toContain('"setup.sh"');
    expect(html).toContain('echo hi');
  });

  it('derives the download filename from the label when the API sends none', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'install-christina.sh — dev-c setup', content: 'x' },
    };
    const res = await fetchSensitive({ sensitiveId: 'abc', label: 'install-christina.sh — dev-c setup' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"install-christina.sh"');
  });

  it('HTML-escapes hostile content and label', async () => {
    apiResponse = {
      status: 200,
      body: { label: '<img src=x onerror=alert(1)>', content: '<script>alert(2)</script>' },
    };
    const res = await fetchSensitive({ sensitiveId: 'abc', label: 'x' });
    const html = await res.text();
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(2)');
    expect(html).toContain('&lt;script&gt;alert(2)');
  });

  it('a hostile filename cannot break out of the inline script', async () => {
    apiResponse = {
      status: 200,
      body: { label: 'x', content: 'y', filename: '</script><script>alert(3)</script>.sh' },
    };
    const res = await fetchSensitive({ sensitiveId: 'abc', label: 'x' });
    const html = await res.text();
    expect(html).not.toContain('</script><script>alert(3)');
  });

  it('still surfaces bridge API errors as an error page', async () => {
    apiResponse = { status: 404, body: { error: 'Sensitive data not found or already viewed' } };
    const res = await fetchSensitive({ sensitiveId: 'gone', label: 'x' });
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('not found or already viewed');
  });
});
