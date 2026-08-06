import path from 'path';
import { stat } from 'fs/promises';
import { checkFileLink } from './file-link-guard.js';

// Agent-outbound attachment support for the send_attachment MCP tool.
// classifyContentType is extension-based: the agent is sending a file it
// just produced (screenshot, plot, PDF), so the extension is trustworthy
// enough and avoids a content-sniffing dependency.

const EXT_CONTENT_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.zip': 'application/zip',
};

export function classifyContentType(fileName) {
  const ext = path.extname(String(fileName)).toLowerCase();
  const contentType = EXT_CONTENT_TYPES[ext] || 'application/octet-stream';
  return { contentType, isImage: contentType.startsWith('image/') };
}

// Journal server's POST /media per-file cap. Enforced client-side so the
// agent gets a crisp error instead of a failed-open null from uploadMedia.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const GUARD_ERRORS = {
  sensitive: 'Refused: that file looks sensitive (keys/credentials/env). Use share_sensitive_data instead.',
  'outside-workdir': 'Refused: path is outside the session workdir.',
  'relative-path': 'Refused: could not resolve the path to an absolute location.',
};

// HTTP-agnostic so it is fully unit-testable; index.js mounts it as a thin
// adapter on the loopback API server. Same shape as the other loopback
// routes: takes the parsed POST body, returns {status, body}.
export function createSendAttachmentHandler({ sessions, publisher, journalConvoIdFor, maxBytes = MAX_ATTACHMENT_BYTES }) {
  return async function handleSendAttachment(data) {
    const { roomId, path: reqPath, caption } = data || {};
    if (!roomId || !reqPath) return { status: 400, body: { error: 'roomId and path are required' } };

    const session = sessions.get(roomId);
    if (!session) return { status: 404, body: { error: `no active session for chat ${roomId}` } };

    const convoId = journalConvoIdFor(session);
    if (!convoId) return { status: 409, body: { error: 'journal conversation not established yet — try again shortly' } };

    const absWorkdir = session.workdir ? path.resolve(session.workdir) : null;
    const absTarget = path.isAbsolute(reqPath)
      ? path.resolve(reqPath)
      : (absWorkdir ? path.resolve(absWorkdir, reqPath) : null);
    if (!absTarget) return { status: 400, body: { error: 'relative path given but the session has no workdir' } };

    const gate = checkFileLink(absTarget, absWorkdir);
    if (!gate.ok) return { status: 403, body: { error: GUARD_ERRORS[gate.reason] || `Refused: ${gate.reason}` } };

    let info;
    try {
      info = await stat(absTarget);
    } catch {
      return { status: 404, body: { error: `file not found: ${absTarget}` } };
    }
    if (!info.isFile()) return { status: 400, body: { error: `not a regular file: ${absTarget}` } };
    if (info.size > maxBytes) {
      return { status: 413, body: { error: `file too large (${info.size} bytes; the journal caps attachments at 50 MB)` } };
    }

    const name = path.basename(absTarget);
    const { contentType, isImage } = classifyContentType(name);

    const media = await publisher.uploadMedia({ filePath: absTarget, contentType, name });
    if (!media) return { status: 502, body: { error: 'upload failed — journal unreachable or rejected the file' } };

    const payload = {
      blob_ref: media.media_id,
      content_type: media.content_type || contentType,
      name,
      size: media.size ?? info.size,
    };
    if (caption) payload.caption = caption;

    if (isImage) publisher.publishImage(convoId, payload);
    else publisher.publishFile(convoId, payload);

    return { status: 200, body: { ok: true, kind: isImage ? 'image' : 'file', name, size: payload.size } };
  };
}
