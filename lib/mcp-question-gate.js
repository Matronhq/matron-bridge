// Liveness detection for the ask_user MCP answer-gate.
//
// When Claude calls the ask_user MCP tool, the bridge sets
// `session.waitingForAnswer = 'mcp:<id>'` so the user's next chat message is
// routed back to the MCP server as the answer. The MCP server (ask-user.js)
// only POLLS for that answer for ~5 minutes (POLL_TIMEOUT_MS) and then silently
// returns "timed out" to Claude — it never tells the bridge it stopped waiting.
//
// Without liveness detection the gate stays armed forever after a timeout, so
// the next unrelated message gets swallowed as a stale answer and never reaches
// Claude. We detect that no poller is still waiting by how recently the
// question was polled: the poller hits GET /ask/:id every POLL_INTERVAL_MS
// (500ms) while alive, stamping `lastPolledAt`. If that stamp is stale (or the
// question is gone), nobody is waiting — release the gate and let the message
// through.

// How long without a poll before we consider the question abandoned. The MCP
// poller polls every 500ms, so 5s (10 intervals) tolerates transient delays
// while still catching a real timeout/crash on the very next message.
export const MCP_GATE_LIVENESS_MS = 5000;

// True when no MCP poller is still waiting for this question's answer, i.e. the
// answer-gate should be released rather than consuming the message. Defaults to
// abandoned when the question is missing or has no poll stamp — the safe
// direction is to let the message reach Claude, never to swallow it.
export function isMcpQuestionAbandoned(question, now, thresholdMs = MCP_GATE_LIVENESS_MS) {
  if (!question) return true;
  const last = question.lastPolledAt;
  if (typeof last !== 'number') return true;
  return (now - last) > thresholdMs;
}

// If the session's answer-gate is an ask_user MCP question whose poller has
// gone, clear the gate (and drop the orphaned question) so the caller treats
// the incoming message as a normal message rather than a stale answer. Returns
// true when it released a gate, false when there was nothing stale to release
// (no gate, a non-mcp gate, or a question still being actively polled).
// `pendingMcpQuestions` is the Map keyed by question id.
export function releaseAbandonedMcpGate(session, pendingMcpQuestions, now, thresholdMs = MCP_GATE_LIVENESS_MS) {
  const mode = session.waitingForAnswer;
  if (typeof mode !== 'string' || !mode.startsWith('mcp:')) return false;
  const questionId = mode.slice(4);
  if (!isMcpQuestionAbandoned(pendingMcpQuestions.get(questionId), now, thresholdMs)) return false;
  pendingMcpQuestions.delete(questionId);
  session.waitingForAnswer = null;
  session.pendingQuestions = null;
  session.currentQuestionIndex = 0;
  session.questionAnswers = [];
  return true;
}
