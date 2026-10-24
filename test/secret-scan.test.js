import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanFile, SECRET_PATTERNS, secretKindsIn } from '../lib/secret-scan.js';
import { readZipEntries, ZIP_MEMBER_MAX_BYTES } from '../lib/archive-entries.js';

// Fake secrets are assembled from pieces so no key-shaped literal sits in
// this file for the repository's own secret scanners to trip on.
const FAKE = {
  aws: 'AK' + 'IA' + 'EXAMPLE0' + 'EXAMPLE1',
  jwt: 'ey' + 'J' + 'hbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'J' + 'zdWIiOiJhbGljZSJ9' + '.' + 'c2lnbmF0dXJlLXZhbHVl',
  pgUrl: 'postgres' + '://' + 'u' + ':' + 'p' + '@' + 'db.example.com/app',
  privateKeyHeader: '-----' + 'BEGIN RSA ' + 'PRIVATE KEY' + '-----',
  github: 'gh' + 'p_' + 'a1B2c3D4e5'.repeat(4),
  githubPat: 'github' + '_pat_' + '11ABCDEFG0' + 'x'.repeat(40),
  slack: 'xo' + 'xb-' + '1234567890-abcdef',
  stripe: 's' + 'k_live_' + 'Zz09'.repeat(6),
  google: 'AI' + 'za' + 'Sy' + 'A1b2C3d4E5'.repeat(3) + '_-abc',
  anthropic: 'sk' + '-ant-' + 'api03-' + 'q'.repeat(30),
  openai: 'sk' + '-' + 'Ab12'.repeat(10),
  password: 'pass' + 'word' + ' = "' + 'hunter2' + 'hunter2' + '"',
};

let dir;
beforeAll(() => { dir = mkdtempSync(path.join(tmpdir(), 'secret-scan-')); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

let n = 0;
function fixture(name, content) {
  const p = path.join(dir, `${n++}-${name}`);
  writeFileSync(p, content);
  return p;
}

// --- tar fixtures (ustar, built by hand) ---
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100, 'ascii');
  h.write('0001750\0', 108, 'ascii');
  h.write('0001750\0', 116, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
  h.write('00000000000\0', 136, 'ascii');
  h.write('        ', 148, 'ascii');
  h.write(type, 156, 'ascii');
  h.write('ustar\0', 257, 'ascii');
  h.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
  return h;
}
function makeTar(entries) {
  const parts = [];
  for (const { name, data = '', type = '0' } of entries) {
    const body = Buffer.from(data);
    parts.push(tarHeader(name, body.length, type), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

// --- zip fixtures (built by hand) ---
let crcTable;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = '', method = 8 } of entries) {
    const raw = Buffer.from(data);
    const comp = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]),
  Buffer.from('IHDR'),
  Buffer.alloc(64, 0),
]);

describe('SECRET_PATTERNS', () => {
  it('has every kind from the spec', () => {
    const kinds = new Set(SECRET_PATTERNS.map((p) => p.kind));
    for (const k of ['private_key', 'aws_access_key', 'github_token', 'slack_token', 'stripe_key',
      'google_api_key', 'anthropic_key', 'openai_key', 'jwt', 'url_credentials', 'password_assignment']) {
      expect(kinds.has(k), k).toBe(true);
    }
  });
});

describe('secretKindsIn', () => {
  const J = 'ey' + 'J';
  // The scanner uses linear-time matchers for url_credentials and jwt; they
  // must agree with the published regexes.
  const samples = [
    ...Object.values(FAKE),
    'plain words only', 'http' + '://example.com/path', 'HTTP' + '://u:p@example.com',
    'x' + '://u:p@h', '1' + '://u:p@h', 'a' + '://u:p/@h', 'a' + '://:p@h', 'a' + '://u:@h',
    'see ' + 'ftp' + '://u:p@h and ' + 'https' + '://bob:pw@example.com',
    'a' + '://b:c a' + '://d:e@f', J, J + 'a.b', J + 'a.b.c', J + '.b.c', 'x' + J + 'a.b.c',
    J + J + '.' + J, J + 'a.' + J.repeat(5), J + 'a-b_c.d.e', J + 'a'.repeat(10) + '.x.',
  ];
  it.each(samples)('agrees with SECRET_PATTERNS on %j', (text) => {
    const expected = SECRET_PATTERNS.filter(({ re }) => re.test(text)).map(({ kind }) => kind);
    expect(secretKindsIn(text)).toEqual(expected);
  });

  // A synchronous regex blocks the event loop, so a quadratic match would
  // hang rather than time out; keep the inputs big enough to notice.
  it('stays linear on long runs that defeat the plain regexes', () => {
    const t = Date.now();
    expect(secretKindsIn('a'.repeat(1 << 20))).toEqual([]);
    expect(secretKindsIn(J.repeat(1 << 18))).toEqual([]);
    expect(secretKindsIn(J + 'a.' + J.repeat(1 << 18))).toEqual([]);
    expect(secretKindsIn('a' + '://b:'.repeat(1 << 17))).toEqual([]);
    expect(Date.now() - t).toBeLessThan(5000);
  });
});

describe('scanFile: plain text', () => {
  it('clean text is clean', async () => {
    const p = fixture('notes.md', '# Notes\n\nalice met bob at example.com\npassword: short\n');
    expect(await scanFile(p)).toEqual({ verdict: 'clean', findings: [] });
  });

  it('empty file is clean', async () => {
    expect(await scanFile(fixture('empty.txt', ''))).toEqual({ verdict: 'clean', findings: [] });
  });

  it('flags a fake AWS key with the right 1-based line', async () => {
    const p = fixture('deploy.sh', `#!/bin/sh\necho hi\nexport KEY_ID=${FAKE.aws}\n`);
    const r = await scanFile(p);
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toEqual([{ kind: 'aws_access_key', line: 3 }]);
  });

  it.each([
    ['private_key', FAKE.privateKeyHeader],
    ['github_token', FAKE.github],
    ['github_token', FAKE.githubPat],
    ['slack_token', FAKE.slack],
    ['stripe_key', FAKE.stripe],
    ['google_api_key', FAKE.google],
    ['anthropic_key', FAKE.anthropic],
    ['openai_key', FAKE.openai],
    ['jwt', FAKE.jwt],
    ['url_credentials', FAKE.pgUrl],
    ['password_assignment', FAKE.password],
  ])('detects %s', async (kind, secret) => {
    const r = await scanFile(fixture('x.txt', `line one\n  value ${secret} tail\n`));
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toContainEqual({ kind, line: 2 });
  });

  it('password_assignment is case-insensitive', async () => {
    const r = await scanFile(fixture('x.yml', 'API' + '_KEY: abcdefgh12345\n'));
    expect(r.findings).toEqual([{ kind: 'password_assignment', line: 1 }]);
  });

  it('never includes the matched value in the findings', async () => {
    const all = Object.values(FAKE).join('\n');
    const r = await scanFile(fixture('all.txt', all));
    expect(r.verdict).toBe('flagged');
    const json = JSON.stringify(r);
    for (const v of Object.values(FAKE)) expect(json).not.toContain(v);
    for (const f of r.findings) expect(Object.keys(f).sort()).toEqual(['kind', 'line']);
  });

  it('finds secrets well past the 8 KiB sniff window, counting lines across chunks', async () => {
    const filler = 'just some ordinary text here\n'.repeat(5000);
    const r = await scanFile(fixture('big.log', filler + `token ${FAKE.aws}\n`));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 5001 }] });
  });

  it('finds a secret on a single very long line', async () => {
    const r = await scanFile(fixture('min.js', 'a'.repeat(3 * 1024 * 1024) + ' ' + FAKE.aws + ' ' + 'b'.repeat(1000)));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 1 }] });
  });

  it('reports each kind once per line', async () => {
    const r = await scanFile(fixture('dup.txt', `${FAKE.aws} ${FAKE.aws}\n`));
    expect(r.findings).toEqual([{ kind: 'aws_access_key', line: 1 }]);
  });

  it('caps findings at 50', async () => {
    const r = await scanFile(fixture('many.txt', `${FAKE.aws}\n`.repeat(200)));
    expect(r.verdict).toBe('flagged');
    expect(r.findings).toHaveLength(50);
  });

  it('PNG bytes are not_scanned', async () => {
    expect(await scanFile(fixture('pic.png', PNG))).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('invalid UTF-8 in the first 8 KiB is not_scanned', async () => {
    const r = await scanFile(fixture('latin.txt', Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x41, 0x0a])));
    expect(r.verdict).toBe('not_scanned');
  });

  it('a multibyte character cut by the 8 KiB window still counts as text', async () => {
    const body = 'a'.repeat(8191) + 'é' + '\n' + FAKE.aws + '\n';
    const r = await scanFile(fixture('utf8.txt', body));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 2 }] });
  });

  it('maxScanBytes stops early: not_scanned when nothing found before the limit', async () => {
    const p = fixture('long.txt', 'ok\n'.repeat(10000) + FAKE.aws + '\n');
    expect(await scanFile(p, { maxScanBytes: 1024 })).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('maxScanBytes: a finding before the limit still flags', async () => {
    const p = fixture('long2.txt', FAKE.aws + '\n' + 'ok\n'.repeat(10000));
    const r = await scanFile(p, { maxScanBytes: 1024 });
    expect(r.verdict).toBe('flagged');
  });

  it('rejects for a missing file', async () => {
    await expect(scanFile(path.join(dir, 'nope.txt'))).rejects.toThrow();
  });
});

describe('scanFile: gzip', () => {
  it('flags gzipped SQL with a credentialed URL', async () => {
    const sql = `-- dump\nCREATE TABLE t (id int);\n-- source ${FAKE.pgUrl}\n`;
    const r = await scanFile(fixture('dump.sql.gz', zlib.gzipSync(sql)));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'url_credentials', line: 3 }] });
  });

  it('clean gzipped text is clean', async () => {
    expect(await scanFile(fixture('a.txt.gz', zlib.gzipSync('hello\nworld\n'))))
      .toEqual({ verdict: 'clean', findings: [] });
  });

  it('gzipped binary is not_scanned', async () => {
    expect((await scanFile(fixture('p.png.gz', zlib.gzipSync(PNG)))).verdict).toBe('not_scanned');
  });

  it('large gzipped binary stops at the sniff and is not_scanned', async () => {
    const bin = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < bin.length; i += 4) bin.writeUInt32LE((i * 2654435761) >>> 0, i);
    const r = await scanFile(fixture('blob.bin.gz', zlib.gzipSync(bin, { level: 1 })));
    expect(r).toEqual({ verdict: 'not_scanned', findings: [] });
  });

  it('maxScanBytes under the sniff window still scans what was read', async () => {
    const p = fixture('short.txt.gz', zlib.gzipSync(FAKE.aws + '\n' + 'ok\n'.repeat(10000)));
    expect(await scanFile(p, { maxScanBytes: 512 })).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 1 }] });
  });

  it('corrupt gzip is not_scanned', async () => {
    expect((await scanFile(fixture('bad.gz', Buffer.from('not gzip at all')))).verdict).toBe('not_scanned');
  });
});

describe('scanFile: tar', () => {
  it('flags a .env member as sensitive_file', async () => {
    const tar = makeTar([{ name: 'app/README.md', data: 'hi\n' }, { name: 'app/.env', data: 'FOO=bar\n' }]);
    const r = await scanFile(fixture('bundle.tar', tar));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'sensitive_file', line: 'app/.env' }] });
  });

  it('flags a member inside a sensitive directory', async () => {
    const tar = makeTar([{ name: 'home/.ssh/', type: '5' }, { name: 'home/.ssh/known_hosts', data: 'x\n' }]);
    const r = await scanFile(fixture('ssh.tar', tar));
    expect(r.findings).toContainEqual({ kind: 'sensitive_file', line: 'home/.ssh/known_hosts' });
  });

  it('scans text members and reports member:line', async () => {
    const tar = makeTar([
      { name: 'src/a.js', data: 'x'.repeat(700) + '\n' },
      { name: 'src/b.js', data: `const a = 1;\nconst k = '${FAKE.aws}';\n` },
    ]);
    const r = await scanFile(fixture('src.tar', tar));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'aws_access_key', line: 'src/b.js:2' }] });
  });

  it('clean tar is clean; a binary member makes it not_scanned', async () => {
    expect(await scanFile(fixture('ok.tar', makeTar([{ name: 'a.txt', data: 'hello\n' }]))))
      .toEqual({ verdict: 'clean', findings: [] });
    const r = await scanFile(fixture('bin.tar', makeTar([{ name: 'a.txt', data: 'hello\n' }, { name: 'p.png', data: PNG }])));
    expect(r.verdict).toBe('not_scanned');
  });

  it('handles .tar.gz and .tgz', async () => {
    const tar = makeTar([{ name: 'conf/settings.ini', data: `[db]\nurl=${FAKE.pgUrl}\n` }]);
    for (const ext of ['tar.gz', 'tgz']) {
      const r = await scanFile(fixture(`b.${ext}`, zlib.gzipSync(tar)));
      expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'url_credentials', line: 'conf/settings.ini:2' }] });
    }
  });

  it('uses a GNU long name for the next member', async () => {
    const longName = 'deep/'.repeat(25) + 'prod.env';
    const tar = makeTar([{ name: '././@LongLink', type: 'L', data: longName + '\0' }, { name: longName.slice(0, 99), data: 'x\n' }]);
    const r = await scanFile(fixture('long.tar', tar));
    expect(r.findings).toEqual([{ kind: 'sensitive_file', line: longName }]);
  });

  it('a corrupt or truncated tar is not_scanned', async () => {
    const good = makeTar([{ name: 'a.txt', data: 'hello world\n'.repeat(100) }]);
    expect((await scanFile(fixture('trunc.tar', good.subarray(0, 700)))).verdict).toBe('not_scanned');
    expect((await scanFile(fixture('junk.tar', Buffer.alloc(2048, 0x41)))).verdict).toBe('not_scanned');
  });
});

describe('scanFile: zip', () => {
  it('flags a JWT inside a deflated member with member:line', async () => {
    const zip = makeZip([
      { name: 'notes/readme.txt', data: `hello\nalice\nauth: Bearer ${FAKE.jwt}\n` },
    ]);
    const r = await scanFile(fixture('docs.zip', zip));
    expect(r).toEqual({ verdict: 'flagged', findings: [{ kind: 'jwt', line: 'notes/readme.txt:3' }] });
    expect(JSON.stringify(r)).not.toContain(FAKE.jwt);
  });

  it('scans stored members too', async () => {
    const zip = makeZip([{ name: 'a.txt', data: `k=${FAKE.aws}\n`, method: 0 }]);
    expect((await scanFile(fixture('stored.zip', zip))).findings).toEqual([{ kind: 'aws_access_key', line: 'a.txt:1' }]);
  });

  it('flags sensitive member names', async () => {
    const zip = makeZip([{ name: 'keys/server.pem', data: 'nothing\n' }]);
    expect((await scanFile(fixture('k.zip', zip))).findings).toEqual([{ kind: 'sensitive_file', line: 'keys/server.pem' }]);
  });

  it('clean zip is clean; an unsupported method member makes it not_scanned', async () => {
    expect(await scanFile(fixture('ok.zip', makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'd/', data: '', method: 0 }]))))
      .toEqual({ verdict: 'clean', findings: [] });
    const bz = makeZip([{ name: 'a.txt', data: 'hi\n' }, { name: 'b.txt', data: 'raw', method: 0 }]);
    // Rewrite the second member's method to 12 (bzip2) in its central entry.
    const cdStart = bz.readUInt32LE(bz.length - 22 + 16);
    const secondCentral = cdStart + 46 + 'a.txt'.length;
    bz.writeUInt16LE(12, secondCentral + 10);
    expect((await scanFile(fixture('bz.zip', bz))).verdict).toBe('not_scanned');
  });

  it('a skipped member does not hide a finding in another', async () => {
    const bz = makeZip([{ name: 'a.txt', data: `${FAKE.aws}\n` }, { name: 'b.txt', data: 'raw', method: 0 }]);
    const cdStart = bz.readUInt32LE(bz.length - 22 + 16);
    bz.writeUInt16LE(12, cdStart + 46 + 'a.txt'.length + 10);
    expect((await scanFile(fixture('bz2.zip', bz))).verdict).toBe('flagged');
  });

  it('not a zip at all is not_scanned', async () => {
    expect((await scanFile(fixture('fake.zip', 'hello'))).verdict).toBe('not_scanned');
  });
});

describe('readZipEntries', () => {
  it('lists members from the central directory', async () => {
    const p = fixture('l.zip', makeZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.txt', data: 'x', method: 0 }]));
    const entries = await readZipEntries(p);
    expect(entries.map((e) => [e.name, e.method, e.uncompressedSize])).toEqual([['a.txt', 8, 5], ['b/c.txt', 0, 1]]);
    expect(ZIP_MEMBER_MAX_BYTES).toBe(256 * 1024 * 1024);
  });
});
