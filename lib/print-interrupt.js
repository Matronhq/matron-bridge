// Print-mode turn interrupt: builds and writes a `control_request` /
// `interrupt` line to the claude CLI's stream-json stdin. Same control
// protocol the Agent SDK uses; verified against claude 2.1.207 — the CLI
// answers with a control_response, ends the in-flight turn with a `result`
// event (is_error: true, subtype: 'error_during_execution'), and keeps the
// process alive for subsequent turns.
//
// Fail-open contract (same stance as lib/journal-publisher.js): nothing here
// may throw into a transport handler — a write failure reports through
// onError and arms no fallback timer.
import { randomUUID } from 'node:crypto';

// If the CLI never delivers the turn-ending `result` (wedged process, a
// version that ignores control_request), the caller's onWedge fires after
// this long so the bridge can clear busy state instead of queueing messages
// forever.
export const INTERRUPT_FALLBACK_MS = 10000;

export function buildInterruptRequest(requestId = randomUUID()) {
  return { type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } };
}

// Writes one interrupt line to `stdin` and arms the fallback timer. Returns
// { requestId, cancel } — callers MUST cancel when the turn's `result`
// arrives so a completed interrupt can't fire a stale onWedge into a later
// turn. Returns null when the write fails (onError already called, no timer
// armed). setTimeoutFn/clearTimeoutFn are injection seams for tests.
export function sendPrintInterrupt({
  stdin,
  onWedge,
  onError,
  timeoutMs = INTERRUPT_FALLBACK_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  const req = buildInterruptRequest();
  try {
    stdin.write(JSON.stringify(req) + '\n');
  } catch (err) {
    if (onError) onError(err);
    return null;
  }
  const timer = setTimeoutFn(onWedge, timeoutMs);
  return {
    requestId: req.request_id,
    cancel: () => clearTimeoutFn(timer),
  };
}
