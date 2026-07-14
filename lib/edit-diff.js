// Unified-diff snippets for Edit/Write/MultiEdit tool_use events, published
// as journal `diff` events (spec: matron-apple docs/superpowers/specs/
// 2026-07-14-diff-cards-design.md). The output is a display snippet of
// intent — hunk headers use positions within the tool-input strings, not
// file line numbers, and `replace_all` still diffs one occurrence.
import { structuredPatch } from 'diff';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_LINES = 400;
const MAX_BYTES = 64 * 1024;

// Render structuredPatch hunks as unified-diff text WITHOUT ---/+++ file
// headers (the card header carries the filename), counting +/- lines
// before any truncation so the header counts stay honest.
function renderHunks(hunks) {
  const lines = [];
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
    for (const l of h.lines) {
      lines.push(l);
      if (l.startsWith('+')) added += 1;
      else if (l.startsWith('-')) removed += 1;
    }
  }
  return { lines, added, removed };
}

function capText(lines) {
  const out = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + newline
    if (out.length >= MAX_LINES || bytes + lineBytes > MAX_BYTES) {
      return { text: out.join('\n'), truncated: true };
    }
    out.push(line);
    bytes += lineBytes;
  }
  return { text: out.join('\n'), truncated: false };
}

function fromHunks(hunks, newFile) {
  if (!hunks.length) return null; // no-op edit — nothing to show
  const { lines, added, removed } = renderHunks(hunks);
  const { text, truncated } = capText(lines);
  return { diff: text, added, removed, truncated, newFile };
}

function patchHunks(oldStr, newStr) {
  return structuredPatch('a', 'b', oldStr, newStr, '', '', { context: 3 }).hunks;
}

// Returns {diff, added, removed, truncated, newFile} or null when the tool
// input has no usable content (unknown tool, missing fields, no-op edit).
// Never throws — callers fire-and-forget from the Matrix hot path.
export async function computeEditDiff(toolName, input, workdir) {
  try {
    if (!input || typeof input !== 'object') return null;
    if (toolName === 'Edit'
        && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      return fromHunks(patchHunks(input.old_string, input.new_string), false);
    }
    if (toolName === 'MultiEdit' && Array.isArray(input.edits)) {
      const hunks = [];
      for (const e of input.edits) {
        if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') continue;
        hunks.push(...patchHunks(e.old_string, e.new_string));
      }
      return fromHunks(hunks, false);
    }
    if (toolName === 'Write' && typeof input.content === 'string' && input.file_path) {
      const abs = path.isAbsolute(input.file_path)
        ? input.file_path
        : path.join(workdir || '', input.file_path);
      let old = null;
      try {
        old = await fs.readFile(abs, 'utf8');
      } catch {
        old = null; // absent or unreadable -> treat as new file (fail open)
      }
      return fromHunks(patchHunks(old ?? '', input.content), old === null);
    }
    return null;
  } catch {
    return null;
  }
}
