import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { findImageRefs, isLocalTarget, rewriteLocalImageRefs, localizeAttachmentRefs } from '../lib/item-inline-images.js';
import { resolveAndUploadLocalFile } from '../lib/send-attachment.js';
import { createItemsHandlers } from '../lib/items-tools.js';
import { formatItemDetail, withImageWarnings } from '../lib/items-format.js';

// A real temp workdir and the real guarded upload (realpath + workdir
// confinement + sensitive-file guard) against a fake publisher that hands
// out blob refs blob-1, blob-2, … in upload order.
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'inline-img-'));
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  writeFileSync(path.join(dir, 'a.png'), png);
  writeFileSync(path.join(dir, 'b.png'), png);
  writeFileSync(path.join(dir, 'with space.png'), png);
  mkdirSync(path.join(dir, 'shots'));
  writeFileSync(path.join(dir, 'shots', 'c.png'), png);
  const outside = mkdtempSync(path.join(tmpdir(), 'inline-out-'));
  writeFileSync(path.join(outside, 'secret.png'), png);
  let n = 0;
  const publisher = { uploadMedia: vi.fn(async ({ contentType }) => ({ media_id: `blob-${++n}`, content_type: contentType, size: 4 })) };
  const session = { roomId: '!r:s', workdir: dir, journalConvoId: 'c1' };
  const upload = vi.fn((s, reqPath) => resolveAndUploadLocalFile({ session: s, reqPath, publisher }));
  return { dir, outside, session, upload, publisher };
}

// Upload the listed paths the way items-tools does, then rewrite.
async function run(f, body, listedPaths = []) {
  const attachments = [];
  for (const p of listedPaths) {
    const r = await f.upload(f.session, p);
    if (!r.ok) throw new Error(r.body.error);
    attachments.push({ blob_ref: r.media.blob_ref, mime: r.media.mime, name: r.media.name, size: r.media.size });
  }
  return rewriteLocalImageRefs({ session: f.session, body, listedPaths, attachments, upload: f.upload });
}

describe('findImageRefs / isLocalTarget', () => {
  it('parses plain, angle-bracket and titled targets', () => {
    const refs = findImageRefs('![a](./a.png) ![b](<with space.png>) ![c](c.png "Title") ![d](<d.png> \'t\')');
    expect(refs.map((r) => [r.caption, r.target])).toEqual([['a', './a.png'], ['b', 'with space.png'], ['c', 'c.png'], ['d', 'd.png']]);
  });

  it('skips refs in fenced code and inline code', () => {
    const body = '```\n![a](a.png)\n```\n~~~md\n![b](b.png)\n~~~\n`![c](c.png)` ``x ![d](d.png) x`` ![e](e.png)';
    expect(findImageRefs(body).map((r) => r.target)).toEqual(['e.png']);
  });

  it('recognises fences indented up to three spaces, opening and closing', () => {
    expect(findImageRefs('   ```\n![a](a.png)\n  ```\n![b](b.png)').map((r) => r.target)).toEqual(['b.png']);
    expect(findImageRefs(' ~~~\n![a](a.png)\n   ~~~\n![b](b.png)').map((r) => r.target)).toEqual(['b.png']);
  });

  it('recognises fences in a CRLF body', () => {
    expect(findImageRefs('```md\r\n![a](a.png)\r\n```\r\n![b](b.png)').map((r) => r.target)).toEqual(['b.png']);
  });

  it('treats an unclosed fence as code to the end', () => {
    expect(findImageRefs('```\n![a](a.png)')).toEqual([]);
  });

  it('classifies URLs as non-local and Windows drives as local', () => {
    for (const t of ['https://x/a.png', 'http://x/a.png', 'data:image/png;base64,AA', 'attachment:abc', 'file:///a.png', '//cdn/a.png', '#frag']) expect(isLocalTarget(t)).toBe(false);
    for (const t of ['a.png', './a.png', '/abs/a.png', 'C:\\shots\\a.png', '../a.png']) expect(isLocalTarget(t)).toBe(true);
  });
});

describe('rewriteLocalImageRefs', () => {
  it('rewrites a plain ref that names a listed path exactly as typed', async () => {
    const f = fixture();
    const r = await run(f, 'Before\n\n![login](./a.png)\n\nAfter', ['./a.png']);
    expect(r.body).toBe('Before\n\n![login](attachment:blob-1)\n\nAfter');
    expect(r.attachments.map((a) => a.blob_ref)).toEqual(['blob-1']);
    expect(r.warnings).toEqual([]);
  });

  it('rewrites an angle-bracket ref with a title, dropping the title', async () => {
    const f = fixture();
    const r = await run(f, '![shot](<with space.png> "the title")', ['with space.png']);
    expect(r.body).toBe('![shot](attachment:blob-1)');
  });

  it('matches workdir-relative and absolute spellings of the same file', async () => {
    const f = fixture();
    const abs = path.join(f.dir, 'shots', 'c.png');
    const r1 = await run(f, '![c](shots/c.png)', [abs]);
    expect(r1.body).toBe('![c](attachment:blob-1)');
    expect(r1.attachments).toHaveLength(1);
    const g = fixture();
    const r2 = await run(g, `![c](${path.join(g.dir, 'shots', 'c.png')})`, ['./shots/../shots/c.png']);
    expect(r2.body).toBe('![c](attachment:blob-1)');
    expect(r2.attachments).toHaveLength(1);
  });

  it('matches through a symlink to the same real file', async () => {
    const f = fixture();
    symlinkSync(path.join(f.dir, 'a.png'), path.join(f.dir, 'link.png'));
    const r = await run(f, '![a](link.png)', ['a.png']);
    expect(r.body).toBe('![a](attachment:blob-1)');
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it('uploads an unlisted file inside the workdir and appends it in body order', async () => {
    const f = fixture();
    const r = await run(f, '![b](b.png) then ![c](./shots/c.png) and ![a](a.png) and ![b again](b.png)', ['a.png']);
    expect(r.body).toBe('![b](attachment:blob-2) then ![c](attachment:blob-3) and ![a](attachment:blob-1) and ![b again](attachment:blob-2)');
    expect(r.attachments.map((a) => [a.blob_ref, a.name])).toEqual([['blob-1', 'a.png'], ['blob-2', 'b.png'], ['blob-3', 'c.png']]);
    expect(r.warnings).toEqual([]);
  });

  it('decodes a URL-encoded path', async () => {
    const f = fixture();
    const r = await run(f, '![s](with%20space.png)');
    expect(r.body).toBe('![s](attachment:blob-1)');
  });

  it('leaves a missing file as typed, with a warning', async () => {
    const f = fixture();
    const r = await run(f, '![x](./nope.png) ![a](a.png)', ['a.png']);
    expect(r.body).toBe('![x](./nope.png) ![a](attachment:blob-1)');
    expect(r.warnings).toEqual(['image ./nope.png not found — left as typed']);
  });

  it('refuses a file outside the workdir (same confinement as attachments)', async () => {
    const f = fixture();
    const p = path.join(f.outside, 'secret.png');
    const r = await run(f, `![s](${p})`);
    expect(r.body).toBe(`![s](${p})`);
    expect(r.attachments).toEqual([]);
    expect(r.warnings[0]).toMatch(/outside the session workdir/);
    expect(f.publisher.uploadMedia).not.toHaveBeenCalled();
  });

  it('leaves remote, data and attachment URLs alone', async () => {
    const f = fixture();
    const body = '![r](https://example.com/a.png) ![d](data:image/png;base64,AAAA) ![k](attachment:blob-9)';
    const r = await run(f, body);
    expect(r).toEqual({ body, attachments: [], warnings: [] });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it('leaves refs inside a code fence and inline code alone', async () => {
    const f = fixture();
    const body = 'Use this:\n```md\n![a](a.png)\n```\nor `![b](b.png)`';
    const r = await run(f, body, ['a.png']);
    expect(r.body).toBe(body);
    expect(r.attachments).toHaveLength(1);
  });

  it('stops at 20 attachments: later unlisted refs stay as typed, with a warning', async () => {
    const f = fixture();
    const listed = [];
    for (let i = 0; i < 19; i++) {
      writeFileSync(path.join(f.dir, `l${i}.png`), Buffer.from([1]));
      listed.push(`l${i}.png`);
    }
    const r = await run(f, '![a](a.png) ![b](b.png) ![l0](l0.png)', listed);
    expect(r.attachments).toHaveLength(20);
    expect(r.body).toBe('![a](attachment:blob-20) ![b](b.png) ![l0](attachment:blob-1)');
    expect(r.warnings).toEqual(['image b.png not attached — the journal allows at most 20 attachments per write; left as typed']);
  });
});

describe('localizeAttachmentRefs (item_get)', () => {
  it('points a downloaded blob at its local path, angle-bracketing spaces', () => {
    const atts = [{ blob_ref: 'aa11', path: '/home/u/matron-files/r/a.png' }, { blob_ref: 'bb22', path: '/home/u/matron-files/r/b c.png' }, { blob_ref: 'cc33' }];
    const text = '![a](attachment:aa11) ![b](attachment:bb22) ![c](attachment:cc33) ![z](attachment:zz99) `![a](attachment:aa11)`';
    expect(localizeAttachmentRefs(text, atts)).toBe('![a](/home/u/matron-files/r/a.png) ![b](</home/u/matron-files/r/b c.png>) ![c](attachment:cc33) ![z](attachment:zz99) `![a](attachment:aa11)`');
  });
});

describe('items handlers: inline images end to end', () => {
  function handlers(f, client, extra = {}) {
    return createItemsHandlers({ sessions: new Map([['!r:s', f.session]]), journalConvoIdFor: () => 'c1', client, uploadLocalFile: f.upload, ...extra });
  }

  it('create: sends the rewritten body and the appended attachments; warnings ride on the result', async () => {
    const f = fixture();
    const client = { create: vi.fn(async () => ({ status: 201, data: { item: { id: 'it_1', num: 1, title: 'T' } } })) };
    const r = await handlers(f, client).create({ roomId: '!r:s', kind: 'notice', title: 'T', body: 'x\n\n![a](./a.png)\n\n![b](b.png) ![m](gone.png)', attachments: ['./a.png'] });
    const sent = client.create.mock.calls[0][0];
    expect(sent.body).toBe('x\n\n![a](attachment:blob-1)\n\n![b](attachment:blob-2) ![m](gone.png)');
    expect(sent.attachments.map((a) => a.blob_ref)).toEqual(['blob-1', 'blob-2']);
    expect(r.body.image_warnings).toEqual(['image gone.png not found — left as typed']);
    expect(withImageWarnings('#1 T — open', r.body)).toBe('#1 T — open\n  · image gone.png not found — left as typed');
  });

  it('comment: an unlisted referenced file alone satisfies "body or attachments"', async () => {
    const f = fixture();
    const client = { comment: vi.fn(async () => ({ status: 201, data: { item: {}, comment: { id: 'ic_1' } } })) };
    const r = await handlers(f, client).comment({ roomId: '!r:s', id: 'it_1', body: '![a](a.png)' });
    expect(r.status).toBe(201);
    expect(client.comment.mock.calls[0][1]).toEqual({ as_convo_id: 'c1', body: '![a](attachment:blob-1)', attachments: [{ blob_ref: 'blob-1', mime: 'image/png', name: 'a.png', size: 4 }] });
    expect(r.body.image_warnings).toBeUndefined();
  });

  it('get: downloads body and comment attachments and rewrites each text against its own attachments', async () => {
    const f = fixture();
    const client = { get: vi.fn(async () => ({ status: 200, data: {
      item: { id: 'it_1', num: 1, title: 'T', state: 'open', body: 'See ![login](attachment:aa11)', attachments: [{ blob_ref: 'aa11', mime: 'image/png', name: 'login.png', size: 1 }] },
      comments: [
        { author: 'agent', created_at: 0, body: '![b](attachment:bb22) ![x](attachment:aa11)', attachments: [{ blob_ref: 'bb22', mime: 'image/png', name: 'b.png', size: 1 }] },
        { author: 'user', created_at: 0, body: 'no files' },
      ],
    } })) };
    const saveAttachments = vi.fn(async (_s, atts) => atts.map((a) => ({ ...a, path: `/dl/${a.name}` })));
    const r = await handlers(f, client, { saveAttachments }).get({ roomId: '!r:s', id: 'it_1' });
    expect(r.body.item.body).toBe('See ![login](/dl/login.png)');
    expect(r.body.comments[0].body).toBe('![b](/dl/b.png) ![x](attachment:aa11)');
    expect(r.body.comments[1].body).toBe('no files');
    const text = formatItemDetail(r.body);
    expect(text).toContain('See ![login](/dl/login.png)');
    expect(text).toContain('login.png (image/png) — saved to /dl/login.png');
  });

  it('get: a failed download leaves the ref as stored', async () => {
    const f = fixture();
    const client = { get: vi.fn(async () => ({ status: 200, data: { item: { id: 'it_1', body: '![a](attachment:aa11)', attachments: [{ blob_ref: 'aa11', mime: 'image/png', name: 'a.png', size: 1 }] }, comments: [] } })) };
    const saveAttachments = vi.fn(async () => { throw new Error('boom'); });
    const r = await handlers(f, client, { saveAttachments }).get({ roomId: '!r:s', id: 'it_1' });
    expect(r.body.item.body).toBe('![a](attachment:aa11)');
  });
});

describe('formatItemDetail: a shared item lists its description attachments', () => {
  it('names the saved path of a body attachment on another person\'s item', () => {
    const text = formatItemDetail({
      item: { id: 'it_9', num: 3, kind: 'task', title: 'Theirs', state: 'open', owner: { name: 'alice' }, body: 'See ![a](/dl/a.png)', attachments: [{ blob_ref: 'aa11', name: 'a.png', mime: 'image/png', path: '/dl/a.png' }] },
      comments: [],
    });
    expect(text).toContain('a.png (image/png) — saved to /dl/a.png');
  });
});
