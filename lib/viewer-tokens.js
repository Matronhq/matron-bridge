import crypto from 'crypto';

const DEFAULT_TOKEN_EXPIRY_SECONDS = parseInt(process.env.TOKEN_EXPIRY || '3600', 10);

// Generate a signed token for a file path or arbitrary payload.
// Token format: base64url(json({path, exp})) + '.' + hmac
export function generateSignedUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, extra = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = extra ? { ...extra, exp } : { path: filePath, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/view?token=${payload}.${sig}`;
}

// Signed /download link: same token scheme as /view, distinguished by the
// dl flag so a leaked /view token can't be replayed as a raw download (and
// vice versa — /view ignores dl tokens' looser size budget).
export function generateDownloadUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = { path: filePath, workdir, dl: true, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/download?token=${payload}.${sig}`;
}

// A /page link is made to be passed on (a report, a demo pack), and a
// signed payload is only encoded, not hidden: anyone holding the link could
// read the box's home directory, user name and repository path out of it.
// So the path and workdir ride sealed (AES-256-GCM under a key derived from
// the HMAC secret, which the bridge and the viewer share); the signature
// still covers the sealed blob, the flag and the expiry.
function pageKey(secret) {
  return crypto.createHash('sha256').update(`matron-page:${secret}`).digest();
}

export function sealPagePayload({ path: filePath, workdir }, secret = process.env.HMAC_SECRET) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', pageKey(secret), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify({ path: filePath, workdir }), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

export function openPagePayload(sealed, secret = process.env.HMAC_SECRET) {
  if (typeof sealed !== 'string') return null;
  try {
    const buf = Buffer.from(sealed, 'base64url');
    if (buf.length < 12 + 16) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', pageKey(secret), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
    const inner = JSON.parse(plain);
    if (!inner || typeof inner.path !== 'string') return null;
    return { path: inner.path, workdir: typeof inner.workdir === 'string' ? inner.workdir : null };
  } catch {
    return null;
  }
}

// Signed /page link: renders one HTML file from the workdir as a sandboxed
// web page. The page flag ties the token to that route, as dl does for
// /download, so a short-lived /view token cannot be replayed onto /page and
// a page token cannot become a raw download. The path and workdir are
// sealed (above), never in the clear.
export function generatePageUrl(baseUrl, filePath, secret = process.env.HMAC_SECRET, expiry = DEFAULT_TOKEN_EXPIRY_SECONDS, workdir = null) {
  const exp = Math.floor(Date.now() / 1000) + expiry;
  const payloadObj = { p: sealPagePayload({ path: filePath, workdir }, secret), page: true, exp };
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${baseUrl}/page?token=${payload}.${sig}`;
}

// A /page token's contents: the signed outer data with the sealed path and
// workdir opened, or null for anything that is not a valid, unexpired page
// token. A token minted before paths were sealed (path in the clear) still
// opens, so links handed out earlier keep working until they expire.
export function readPageToken(token, secret = process.env.HMAC_SECRET) {
  const data = verifyToken(token, secret);
  if (!data || data.page !== true) return null;
  if (typeof data.p === 'string') {
    const inner = openPagePayload(data.p, secret);
    if (!inner) return null;
    const { p: _sealed, ...rest } = data;
    return { ...rest, ...inner };
  }
  return typeof data.path === 'string' ? data : null;
}

export function verifyToken(token, secret = process.env.HMAC_SECRET) {
  // Express query/body params can arrive as arrays or objects
  // (?token=a&token=b). Only a plain string can be a valid token; reject
  // anything else before doing string/Buffer work on it.
  if (typeof token !== 'string') return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payload = token.slice(0, dotIdx);
  const sig = token.slice(dotIdx + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBytes = Buffer.from(sig);
  const expectedBytes = Buffer.from(expectedSig);
  if (sigBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(sigBytes, expectedBytes)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
