import fs from 'fs';
import path from 'path';

// --- T-1.1: MIME type lookup table ---

const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.jsx': 'application/javascript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.rb': 'text/x-ruby',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.h': 'text/x-c',
  '.json': 'application/json',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.sh': 'application/x-sh',
  '.sql': 'application/sql',
  '.csv': 'text/csv',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

export function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// --- T-1.2: Sensitive-file denylist + workdir scope gate ---

const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
];

export function isSensitivePath(filePath) {
  const basename = path.basename(filePath);
  if (SENSITIVE_BASENAME_PATTERNS.some(re => re.test(basename))) return true;
  if (SENSITIVE_PATH_PATTERNS.some(re => re.test(filePath))) return true;
  return false;
}

export async function resolveInWorkdir(filePath, workdir) {
  const normalizedWorkdir = workdir.replace(/\/+$/, '');
  let resolvedPath;
  try {
    resolvedPath = await fs.promises.realpath(filePath);
  } catch {
    resolvedPath = filePath;
  }
  let resolvedWorkdir;
  try {
    resolvedWorkdir = await fs.promises.realpath(normalizedWorkdir);
  } catch {
    resolvedWorkdir = normalizedWorkdir;
  }
  if (resolvedPath === resolvedWorkdir || resolvedPath.startsWith(resolvedWorkdir + '/')) {
    return resolvedPath;
  }
  return null;
}

// --- T-1.5: Structured logging helper ---

export function logUploadDecision({ toolUseId, filePath, decision, size = null, eventId = null, error = null }) {
  console.log(JSON.stringify({
    tag: 'file-upload',
    tool_use_id: toolUseId || null,
    file: filePath ? path.basename(filePath) : null,
    decision,
    size,
    event_id: eventId,
    error,
  }));
}

// --- T-1.3: Concurrency semaphore ---

let activeUploads = 0;
const MAX_CONCURRENT_UPLOADS = 3;
const uploadQueue = [];

async function enqueueUpload(fn) {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    await new Promise(resolve => uploadQueue.push(resolve));
  }
  activeUploads++;
  try {
    return await fn();
  } finally {
    activeUploads--;
    if (uploadQueue.length > 0) uploadQueue.shift()();
  }
}

// --- T-1.4: uploadFileToRoom ---

const DEFAULT_MAX_BYTES = 5242880; // 5MB

export async function uploadFileToRoom(client, roomId, filePath, opts = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, encrypt = false, toolUseId, workdir } = opts;

  return enqueueUpload(async () => {
    // Step 1: workdir-scope gate
    if (workdir) {
      const resolvedPath = await resolveInWorkdir(filePath, workdir);
      if (!resolvedPath) {
        logUploadDecision({ toolUseId, filePath, decision: 'denied-out-of-scope' });
        return null;
      }
      filePath = resolvedPath;
    }

    // Step 2: sensitive-file gate
    if (isSensitivePath(filePath)) {
      logUploadDecision({ toolUseId, filePath, decision: 'denied-sensitive' });
      return null;
    }

    // Step 3: open, stat-gate, then read from the same fd (avoids TOCTOU)
    let fh;
    let buffer;
    try {
      fh = await fs.promises.open(filePath, 'r');
      const stat = await fh.stat();
      if (!stat.isFile()) {
        logUploadDecision({ toolUseId, filePath, decision: 'skipped-not-regular' });
        await fh.close();
        return null;
      }
      if (stat.size > maxBytes) {
        logUploadDecision({ toolUseId, filePath, decision: 'skipped-size', size: stat.size });
        await fh.close();
        return null;
      }
      buffer = await fh.readFile();
      await fh.close();
    } catch (err) {
      if (fh) await fh.close().catch(() => {});
      logUploadDecision({ toolUseId, filePath, decision: 'skipped-missing', error: err.message });
      return null;
    }

    // Step 5: MIME detection
    const mime = mimeForPath(filePath);
    const filename = path.basename(filePath);

    // Step 6: encrypt → upload → send (wrapped in try/catch)
    try {
      let uploadBuf = buffer;
      let fileContent;

      if (encrypt) {
        const encrypted = await client.crypto.encryptMedia(buffer);
        uploadBuf = encrypted.buffer;
        const mxcUri = await client.uploadContent(uploadBuf, mime, filename);
        fileContent = {
          msgtype: 'm.file',
          body: filename,
          filename,
          info: { mimetype: mime, size: buffer.length },
          file: { ...encrypted.file, url: mxcUri },
        };
      } else {
        const mxcUri = await client.uploadContent(uploadBuf, mime, filename);
        fileContent = {
          msgtype: 'm.file',
          body: filename,
          filename,
          info: { mimetype: mime, size: buffer.length },
          url: mxcUri,
        };
      }

      const eventId = await client.sendMessage(roomId, fileContent);

      // Step 7: log success
      logUploadDecision({ toolUseId, filePath, decision: 'uploaded', size: buffer.length, eventId });
      return eventId;
    } catch (err) {
      logUploadDecision({ toolUseId, filePath, decision: 'skipped-error', size: buffer.length, error: err.message });
      return null;
    }
  });
}
