// Inline images in tracker items (shared spec: "inline images").
//
// Stored form, in an item body or a comment body:
//   ![caption](attachment:<blob_ref>)
// A ref resolves only against THAT body's or comment's own attachments; the
// apps render it in place, and attachments no ref uses append at the end.
//
// Agents never see blob refs when they write, so they write the natural
// markdown — `![what it shows](./shot.png)` — and this module does the two
// translations around the journal:
//
//   rewriteLocalImageRefs  item_create / item_comment: a local path that was
//                          uploaded becomes attachment:<blob_ref>; a local file
//                          referenced but not listed in `attachments` is
//                          uploaded too (same guarded upload, same 20 cap).
//   localizeAttachmentRefs item_get: attachment:<blob_ref> becomes the absolute
//                          path the bridge downloaded that blob to, so the
//                          agent reads the body as it wrote it.
//
// Refs inside fenced code blocks and inline code spans are literal text on
// both sides, matching what the apps and the journal do.
import path from 'node:path';
import { realpath } from 'node:fs/promises';

export const ATTACHMENTS_MAX = 20;

// `![caption](target "title")`. The target is either <angle-bracketed> (may
// contain spaces and parens) or a run without whitespace/parens/angles. The
// optional title is dropped on rewrite: the stored grammar has no title.
const IMAGE_REF = /!\[([^\]\n]*)\]\(\s*(?:<([^<>\n]*)>|([^\s()<>]+))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;

// The spec's stored-form grammar, used on the way back out.
const ATTACHMENT_REF = /!\[([^\]\n]*)\]\(attachment:([A-Za-z0-9_-]{1,128})\)/g;

// [start, end) ranges of `text` that are code: fenced blocks (a line
// starting with ``` or ~~~, indented up to three spaces, up to a closing line of the same fence, or the
// end of the text) and inline code spans (a run of N backticks up to the
// next run of exactly N).
export function codeRanges(text) {
  const ranges = [];
  const lines = text.split('\n');
  let pos = 0;
  let fence = null; // { char, len, start }
  const prose = []; // [start, end) runs outside fences, scanned for spans below
  let proseStart = 0;
  for (const line of lines) {
    const lineEnd = pos + line.length;
    // Up to three spaces of indentation, as CommonMark allows.
    const m = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line); // [^\n], not ., so a CRLF line's \r still matches
    if (fence) {
      if (m && m[1][0] === fence.char && m[1].length >= fence.len && !m[2].trim()) {
        ranges.push([fence.start, lineEnd]);
        fence = null;
        proseStart = lineEnd + 1;
      }
    } else if (m) {
      if (pos > proseStart) prose.push([proseStart, pos]);
      fence = { char: m[1][0], len: m[1].length, start: pos };
    }
    pos = lineEnd + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  else if (text.length > proseStart) prose.push([proseStart, text.length]);

  for (const [s, e] of prose) {
    const chunk = text.slice(s, e);
    const runs = [...chunk.matchAll(/`+/g)];
    for (let i = 0; i < runs.length; i++) {
      const open = runs[i];
      const j = runs.findIndex((r, k) => k > i && r[0].length === open[0].length);
      if (j === -1) continue;
      ranges.push([s + open.index, s + runs[j].index + runs[j][0].length]);
      i = j;
    }
  }
  return ranges;
}

const inRanges = (ranges, i) => ranges.some(([s, e]) => i >= s && i < e);

// Every image ref outside code, in body order.
export function findImageRefs(text) {
  if (typeof text !== 'string' || !text.includes('![')) return [];
  const code = codeRanges(text);
  const out = [];
  for (const m of text.matchAll(IMAGE_REF)) {
    if (inRanges(code, m.index)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, caption: m[1], target: m[2] ?? m[3] });
  }
  return out;
}

// A URL (http:, data:, attachment:, file:, mailto: …), a protocol-relative
// //host or a #fragment is not a local file. A single letter before the
// colon is a Windows drive (C:\shot.png), which is.
export function isLocalTarget(t) {
  if (!t) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(t)) return false;
  if (t.startsWith('//') || t.startsWith('#')) return false;
  return true;
}

// (session, typedPath) -> the real absolute path, or null when nothing is
// there. Lexical only beyond realpath: confinement is the upload's job
// (resolveAndUploadLocalFile), so a match here never bypasses it.
export async function defaultResolveRealPath(session, p) {
  const workdir = session?.workdir ? path.resolve(session.workdir) : null;
  if (!path.isAbsolute(p) && !workdir) return null;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(workdir, p);
  try { return await realpath(abs); } catch { return null; }
}

// Markdown paths are often URL-encoded (shot%201.png); try the decoded form
// when the literal one is not there.
async function resolveTyped(resolveRealPath, session, t) {
  const real = await resolveRealPath(session, t);
  if (real) return real;
  let decoded;
  try { decoded = decodeURI(t); } catch { return null; }
  return decoded !== t ? resolveRealPath(session, decoded) : null;
}

const toAttachment = (media) => ({ blob_ref: media.blob_ref, mime: media.mime, name: media.name, size: media.size });

// Rewrite local image refs in `body` to attachment:<blob_ref>.
//   listedPaths  the `attachments` strings exactly as typed
//   attachments  what uploading them produced, index-aligned with listedPaths
//   upload       async (session, path) -> resolveAndUploadLocalFile's result
// Returns { body, attachments, warnings }. Never fails the write: a ref it
// cannot resolve, upload or fit under the cap stays as typed, with a warning.
export async function rewriteLocalImageRefs({ session, body, listedPaths = [], attachments = [], upload, resolveRealPath = defaultResolveRealPath, max = ATTACHMENTS_MAX }) {
  const refs = findImageRefs(body);
  const out = [...attachments];
  const warnings = [];
  if (!refs.length) return { body, attachments: out, warnings };

  const byTyped = new Map(listedPaths.map((p, i) => [p, attachments[i]]));
  const byReal = new Map();
  for (let i = 0; i < listedPaths.length; i++) {
    const real = await resolveTyped(resolveRealPath, session, listedPaths[i]);
    if (real && !byReal.has(real)) byReal.set(real, attachments[i]);
  }

  let result = '';
  let last = 0;
  for (const ref of refs) {
    const t = ref.target;
    if (!isLocalTarget(t)) continue;
    let att = byTyped.get(t);
    if (!att) {
      const real = await resolveTyped(resolveRealPath, session, t);
      if (!real) { warnings.push(`image ${t} not found — left as typed`); continue; }
      att = byReal.get(real);
      if (!att) {
        if (out.length >= max) { warnings.push(`image ${t} not attached — the journal allows at most ${max} attachments per write; left as typed`); continue; }
        const r = await upload(session, real);
        if (!r?.ok) { warnings.push(`image ${t} not attached — ${r?.body?.error || 'upload failed'}; left as typed`); continue; }
        att = toAttachment(r.media);
        out.push(att);
        byReal.set(real, att);
      }
    }
    result += body.slice(last, ref.start) + `![${ref.caption}](attachment:${att.blob_ref})`;
    last = ref.end;
  }
  return { body: result + body.slice(last), attachments: out, warnings };
}

// item_get: attachment:<blob_ref> -> the absolute path saveAttachments wrote
// that blob to, when it did (own attachments only, as the spec resolves).
// A path with whitespace or parens is angle-bracketed so it stays one target.
export function localizeAttachmentRefs(text, attachments) {
  if (typeof text !== 'string' || !text.includes('](attachment:') || !Array.isArray(attachments)) return text;
  const paths = new Map();
  for (const a of attachments) {
    if (a && typeof a.blob_ref === 'string' && typeof a.path === 'string' && a.path && !paths.has(a.blob_ref)) paths.set(a.blob_ref, a.path);
  }
  if (!paths.size) return text;
  const code = codeRanges(text);
  return text.replace(ATTACHMENT_REF, (whole, caption, ref, offset) => {
    const p = paths.get(ref);
    if (!p || inRanges(code, offset)) return whole;
    return `![${caption}](${/[\s()<>]/.test(p) ? `<${p}>` : p})`;
  });
}
