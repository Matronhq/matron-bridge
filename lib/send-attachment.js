import path from 'path';

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
