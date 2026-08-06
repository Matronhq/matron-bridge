// Core request logic for the bridge's POST /show-file endpoint, extracted from
// index.js so it can be driven directly in tests without standing up the whole
// bridge (journal WS, spawns, port binds). index.js keeps only the thin
// req/res plumbing (method + body-size gating) and translates the returned
// { status, headers, body } into an HTTP response.
//
// State that the endpoint mutates is injected, not module-global:
//   - `sessions`  the live session Map (token -> session lookup + per-session
//                 in-flight counter on `session._showFileInFlight`).
//   - `budget`    a mutable { inFlight, reservedBytes } object reserved before
//                 the upload and always released in the finally.
// This keeps the concurrency/budget accounting observable from a test.

export async function processShowFile({ body, sessions, budget, limits, deps }) {
  const {
    validateShowFileBody,
    auditShowFile,
    shareAgentMedia,
    validateAndOpen,
    FileLinkDenied,
    uploadMedia,
    journalPublish,
    denialToStatus,
  } = deps;

  let data;
  try {
    data = JSON.parse(body);
  } catch (error) {
    auditShowFile({ result: 'invalid-json', error });
    return { status: 400, body: { error: 'invalid JSON' } };
  }

  const validationError = validateShowFileBody(data);
  const filePath = typeof data?.path === 'string' ? data.path : undefined;
  if (validationError) {
    auditShowFile({ result: validationError.reason, filePath });
    return { status: 400, body: { error: validationError.error } };
  }

  const { caption, token } = data;

  let session;
  for (const candidate of sessions.values()) {
    if (candidate.showFileToken && candidate.showFileToken === token) {
      session = candidate;
      break;
    }
  }
  if (!session) {
    auditShowFile({ result: 'invalid-token', filePath });
    return { status: 403, body: { error: 'invalid token' } };
  }

  if ((session._showFileInFlight || 0) >= limits.maxInFlightPerSession
      || budget.inFlight >= limits.maxInFlight
      || budget.reservedBytes + limits.maxBytes > limits.globalByteBudget) {
    auditShowFile({ result: 'saturated', roomId: session.roomId, filePath });
    return { status: 429, headers: { 'Retry-After': '1' }, body: { error: 'saturated' } };
  }

  // Reserve immediately before the try so the finally always releases exactly
  // what was reserved — no budgetHeld guard needed, unlike the pre-extraction
  // inline handler where reservation and the try/finally spanned parse errors.
  session._showFileInFlight = (session._showFileInFlight || 0) + 1;
  budget.inFlight += 1;
  budget.reservedBytes += limits.maxBytes;
  try {
    const result = await shareAgentMedia({
      filePath,
      caption,
      pinnedRoots: session.showFilePinnedRoots,
      maxBytes: limits.maxBytes,
      uploadTimeoutMs: limits.uploadTimeoutMs,
      deps: {
        validateAndOpen,
        FileLinkDenied,
        uploadMedia,
        publish: (method, payload) => journalPublish(session, method, payload),
      },
    });

    if (result.ok) {
      auditShowFile({
        result: 'ok',
        roomId: session.roomId,
        realPath: result.realPath,
        kind: result.kind,
        size: result.size,
        media_id: result.media_id,
        sha256: result.sha256,
      });
      return { status: 200, body: { ok: true, media_id: result.media_id, kind: result.kind } };
    }

    auditShowFile({ result: result.denied, roomId: session.roomId, filePath });
    return { status: denialToStatus(result.denied), body: { error: result.denied } };
  } catch (error) {
    auditShowFile({ result: 'internal-error', roomId: session.roomId, filePath, error });
    return { status: 502, body: { error: 'internal error' } };
  } finally {
    session._showFileInFlight -= 1;
    budget.inFlight -= 1;
    budget.reservedBytes -= limits.maxBytes;
  }
}
