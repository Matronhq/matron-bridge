// Recognise a usage-limit stall from the assistant record Claude Code
// writes when the account meter is exhausted (spec 2026-09-29 coordinator
// session control §3). Observed texts (journal search, Sept 2026):
//   "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
//   "Error during compaction: You've reached your Fable 5 limit. …"
// and the raw API form "Claude AI usage limit reached|<epoch>". Only a
// record whose ONLY content is that text counts — a model that quotes the
// sentence mid-answer is not stalled.
import { isSidechainEvent } from './session-status.js';

export const USAGE_LIMIT_RE = /^(?:error during compaction:\s*)?(?:you'?ve reached your .{1,40} limit\b|claude ai usage limit reached\b)/i;

export function stallFromAssistantEvent(event) {
  if (!event || event.type !== 'assistant' || isSidechainEvent(event)) return null;
  const content = event.message?.content;
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  if (blocks.length !== 1 || blocks[0]?.type !== 'text' || typeof blocks[0].text !== 'string') return null;
  if (!USAGE_LIMIT_RE.test(blocks[0].text.trim())) return null;
  const model = typeof event.message?.model === 'string' && event.message.model ? event.message.model : undefined;
  return { kind: 'usage_limit', ...(model ? { model } : {}) };
}

// The moment the stall lifts: the session (5-hour) meter's reset when it has
// one (lib/usage-limits.js derives its id as 'session'), else the first line
// carrying a reset. Undefined when nothing says.
export function stallResetsAt(lines) {
  if (!Array.isArray(lines)) return undefined;
  const session = lines.find((l) => l && l.id === 'session' && typeof l.resets_at === 'string');
  if (session) return session.resets_at;
  const any = lines.find((l) => l && typeof l.resets_at === 'string');
  return any ? any.resets_at : undefined;
}
