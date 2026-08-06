import { describe, it, expect } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { classifyContentType, createSendAttachmentHandler } from '../lib/send-attachment.js';

describe('classifyContentType', () => {
  it('classifies common image extensions as images', () => {
    expect(classifyContentType('shot.png')).toEqual({ contentType: 'image/png', isImage: true });
    expect(classifyContentType('IMG_001.JPG')).toEqual({ contentType: 'image/jpeg', isImage: true });
    expect(classifyContentType('anim.gif')).toEqual({ contentType: 'image/gif', isImage: true });
    expect(classifyContentType('pic.webp')).toEqual({ contentType: 'image/webp', isImage: true });
    expect(classifyContentType('photo.heic')).toEqual({ contentType: 'image/heic', isImage: true });
  });

  it('classifies documents and text as non-image files', () => {
    expect(classifyContentType('report.pdf')).toEqual({ contentType: 'application/pdf', isImage: false });
    expect(classifyContentType('build.log')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('notes.txt')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('README.md')).toEqual({ contentType: 'text/markdown', isImage: false });
    expect(classifyContentType('data.json')).toEqual({ contentType: 'application/json', isImage: false });
    expect(classifyContentType('data.csv')).toEqual({ contentType: 'text/csv', isImage: false });
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(classifyContentType('mystery.bin')).toEqual({ contentType: 'application/octet-stream', isImage: false });
    expect(classifyContentType('Makefile')).toEqual({ contentType: 'application/octet-stream', isImage: false });
  });
});

function makeFixture() {
  const workdir = mkdtempSync(path.join(tmpdir(), 'send-attach-'));
  writeFileSync(path.join(workdir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(path.join(workdir, 'report.pdf'), 'pdf-bytes');
  const published = [];
  const uploads = [];
  const publisher = {
    uploadMedia: async ({ filePath, contentType, name }) => {
      uploads.push({ filePath, contentType, name });
      return { media_id: 'blob-123', content_type: contentType, size: 4 };
    },
    publishImage: (convoId, payload) => published.push({ kind: 'image', convoId, payload }),
    publishFile: (convoId, payload) => published.push({ kind: 'file', convoId, payload }),
  };
  const sessions = new Map([['!room1', { workdir }]]);
  const handler = createSendAttachmentHandler({
    sessions, publisher, journalConvoIdFor: () => 'convo-abc',
  });
  return { workdir, publisher, published, uploads, sessions, handler };
}

describe('createSendAttachmentHandler', () => {
  it('uploads and publishes an image event with caption', async () => {
    const { handler, published, workdir } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'shot.png', caption: 'the bug' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, kind: 'image', name: 'shot.png', size: 4 });
    expect(published).toEqual([{
      kind: 'image',
      convoId: 'convo-abc',
      payload: { blob_ref: 'blob-123', content_type: 'image/png', name: 'shot.png', size: 4, caption: 'the bug' },
    }]);
    expect(published[0].payload.name).toBe('shot.png');
    void workdir;
  });

  it('publishes non-images as file events and omits empty caption', async () => {
    const { handler, published } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'report.pdf', caption: '' });
    expect(res.status).toBe(200);
    expect(published[0].kind).toBe('file');
    expect('caption' in published[0].payload).toBe(false);
  });

  it('resolves relative paths against the session workdir and passes filePath to uploadMedia', async () => {
    const { handler, workdir, uploads } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'report.pdf' });
    expect(res.status).toBe(200);
    expect(uploads).toEqual([{
      filePath: path.join(workdir, 'report.pdf'),
      contentType: 'application/pdf',
      name: 'report.pdf',
    }]);
  });

  it('rejects an unknown roomId', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!nope', path: 'shot.png' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no active session/i);
  });

  it('rejects when the journal conversation is not established', async () => {
    const { sessions, publisher } = makeFixture();
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => null });
    const res = await handler({ roomId: '!room1', path: 'shot.png' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/journal conversation/i);
  });

  it('refuses sensitive paths with guidance to share_sensitive_data', async () => {
    const { handler, workdir } = makeFixture();
    writeFileSync(path.join(workdir, '.env'), 'SECRET=1');
    const res = await handler({ roomId: '!room1', path: '.env' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/share_sensitive_data/);
  });

  it('refuses paths outside the session workdir', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!room1', path: '/etc/hosts' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/outside/i);
  });

  it('rejects missing files', async () => {
    const { handler } = makeFixture();
    const res = await handler({ roomId: '!room1', path: 'no-such.png' });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('rejects files over the size cap', async () => {
    const { workdir, sessions, publisher } = makeFixture();
    writeFileSync(path.join(workdir, 'big.bin'), Buffer.alloc(32));
    const handler = createSendAttachmentHandler({
      sessions, publisher, journalConvoIdFor: () => 'convo-abc', maxBytes: 16,
    });
    const res = await handler({ roomId: '!room1', path: 'big.bin' });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/50 MB|too large/i);
  });

  it('surfaces upload failure when uploadMedia fails open with null', async () => {
    const { workdir, sessions } = makeFixture();
    const publisher = {
      uploadMedia: async () => null,
      publishImage: () => { throw new Error('must not publish'); },
      publishFile: () => { throw new Error('must not publish'); },
    };
    const handler = createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor: () => 'convo-abc' });
    const res = await handler({ roomId: '!room1', path: 'shot.png' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/upload failed/i);
    void workdir;
  });

  it('rejects missing params', async () => {
    const { handler } = makeFixture();
    expect((await handler({ path: 'x.png' })).status).toBe(400);
    expect((await handler({ roomId: '!room1' })).status).toBe(400);
  });
});
