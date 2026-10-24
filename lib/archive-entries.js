// Reads a zip file's members without loading the archive into memory: the
// central directory gives the member list, and each member is streamed from
// its local header (stored as is, deflate through zlib). Used by the secret
// scanner on files an agent sends into a room.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

// Members larger than this (uncompressed) are not opened.
export const ZIP_MEMBER_MAX_BYTES = 256 * 1024 * 1024;

// The central directory is read into memory, so it gets a bound of its own.
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;
// End of central directory record (22 bytes) plus the largest comment.
const EOCD_SEARCH_BYTES = 22 + 0xffff;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

export class ZipFormatError extends Error {
  constructor(message) {
    super(`zip: ${message}`);
    this.name = 'ZipFormatError';
  }
}

async function readAt(fh, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

function readUInt64LE(buf, off) {
  const v = buf.readBigUInt64LE(off);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError('size out of range');
  return Number(v);
}

async function findCentralDirectory(fh, fileSize) {
  const tailLen = Math.min(fileSize, EOCD_SEARCH_BYTES);
  const tailStart = fileSize - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError('no end of central directory');
  let count = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);

  // Zip64: the locator sits just before the classic record and points at the
  // zip64 end record, which carries the real 64-bit values.
  const loc = eocd - 20;
  if (loc >= 0 && tail.readUInt32LE(loc) === SIG_ZIP64_LOCATOR) {
    const recOffset = readUInt64LE(tail, loc + 8);
    const rec = await readAt(fh, recOffset, 56);
    if (rec.length < 56 || rec.readUInt32LE(0) !== SIG_ZIP64_EOCD) throw new ZipFormatError('bad zip64 record');
    count = readUInt64LE(rec, 32);
    size = readUInt64LE(rec, 40);
    offset = readUInt64LE(rec, 48);
  }
  if (size > MAX_CENTRAL_DIR_BYTES) throw new ZipFormatError('central directory too large');
  if (offset + size > fileSize) throw new ZipFormatError('central directory out of range');
  return { count, size, offset };
}

// Apply the zip64 extended-information extra field (id 0x0001): it holds
// the values whose 32-bit slot is 0xffffffff, in a fixed order.
function applyZip64Extra(entry, extra) {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    const body = extra.subarray(p + 4, p + 4 + len);
    if (id === 0x0001) {
      let q = 0;
      for (const field of ['uncompressedSize', 'compressedSize', 'localHeaderOffset']) {
        if (entry[field] === 0xffffffff) {
          if (q + 8 > body.length) throw new ZipFormatError('short zip64 extra');
          entry[field] = readUInt64LE(body, q);
          q += 8;
        }
      }
      return;
    }
    p += 4 + len;
  }
}

// -> [{name, method, flags, encrypted, compressedSize, uncompressedSize, localHeaderOffset}]
export async function readZipEntries(absPath) {
  const fh = await fsp.open(absPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    const { count, size, offset } = await findCentralDirectory(fh, fileSize);
    const cd = await readAt(fh, offset, size);
    if (cd.length < size) throw new ZipFormatError('short central directory');
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipFormatError('bad central entry');
      const flags = cd.readUInt16LE(p + 8);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      if (p + 46 + nameLen + extraLen + commentLen > cd.length) throw new ZipFormatError('bad central entry');
      const nameBuf = cd.subarray(p + 46, p + 46 + nameLen);
      const entry = {
        name: nameBuf.toString(flags & 0x0800 ? 'utf8' : 'latin1'),
        method: cd.readUInt16LE(p + 10),
        flags,
        encrypted: Boolean(flags & 0x0001),
        compressedSize: cd.readUInt32LE(p + 20),
        uncompressedSize: cd.readUInt32LE(p + 24),
        localHeaderOffset: cd.readUInt32LE(p + 42),
      };
      applyZip64Extra(entry, cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fh.close();
  }
}

// True when openZipEntry can read this member.
export function isReadableEntry(entry) {
  return !entry.encrypted
    && (entry.method === 0 || entry.method === 8)
    && entry.uncompressedSize <= ZIP_MEMBER_MAX_BYTES;
}

// A Readable of the member's uncompressed bytes. Throws ZipFormatError for a
// member isReadableEntry refuses or a bad local header. The output is not
// trusted to match the declared size: the caller counts what it reads.
export async function openZipEntry(absPath, entry) {
  if (!isReadableEntry(entry)) throw new ZipFormatError('unsupported member');
  const fh = await fsp.open(absPath, 'r');
  let dataStart;
  try {
    const local = await readAt(fh, entry.localHeaderOffset, 30);
    if (local.length < 30 || local.readUInt32LE(0) !== SIG_LOCAL) throw new ZipFormatError('bad local header');
    dataStart = entry.localHeaderOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  } finally {
    await fh.close();
  }
  const raw = entry.compressedSize === 0
    ? Readable.from([])
    : fs.createReadStream(absPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
  if (entry.method === 0) return raw;
  const inflate = zlib.createInflateRaw();
  raw.on('error', (err) => inflate.destroy(err));
  // A reader that stops early destroys the inflater; release the file too.
  inflate.on('close', () => raw.destroy());
  return raw.pipe(inflate);
}
