// Incremental prompt window for the title/summary pass. The old pass sent
// chatHistory.slice(-50) every 5 messages — ~45 of the 50 were re-sends, so
// each message was billed ~10x over its lifetime and the prompt never carried
// the prior summary text at all. Now: only messages since the last SUCCESSFUL
// pass (cursor advances on success only, in index.js), capped at 200 with the
// oldest overflow dropped-but-skipped, plus the previous ROSTER paragraph as
// an explicitly fenced context preamble.

// 1, not higher: a conversation that goes idle before reaching a bigger
// threshold would leave its last messages unsummarized forever. The floor
// only exists to skip turn ends with nothing new at all.
export const SUMMARY_MIN_NEW = 1;
export const SUMMARY_WINDOW_CAP = 200;

export function summaryWindow(chatHistory, lastCount, { cap = SUMMARY_WINDOW_CAP } = {}) {
  const history = Array.isArray(chatHistory) ? chatHistory : [];
  const since = Math.max(0, Math.min(lastCount || 0, history.length));
  const fresh = history.slice(since);
  return {
    messages: fresh.slice(-cap),
    newCount: fresh.length,
    nextCount: history.length,
  };
}

// The two spoken lines for voice mode (matron-apple spec
// 2026-10-03-voice-mode-carplay-design.md §1). The wording is the spec's, word
// for word — it was approved as written, so change it there first. The apps
// say SPOKEN aloud when a turn ends and SPOKEN_MORE when the listener asks
// for more.
const SPOKEN_FORMAT = 'SPOKEN: <what someone listening while driving should hear about the agent\'s latest reply, 40 words at most. First, anything the agent is asking or needs decided, naming the options. Then the outcome in one sentence. Then what it will do next, only if that matters. Plain spoken English. No code, file paths, URLs, PR or issue numbers, markdown or lists, and never a password, key, token or other secret value. If the reply has a table, a diff or a long list, say it is in the chat instead of reading it.>';
const SPOKEN_MORE_FORMAT = 'SPOKEN_MORE: <the next thing that listener would want if they said "tell me more", 150 words at most. Do not repeat SPOKEN. Give the reasoning behind the question or result, what each option would mean, and any risk or caveat the agent raised. Same plain spoken style and the same exclusions. Write NONE if SPOKEN already says everything.>';

export function buildSummaryPrompt({ messages, priorRoster, hasCumulative }) {
  const rendered = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  // Triple-quote fencing: the roster is model output and could contain lines
  // like "TITLE:" — fencing keeps it visually distinct from the format block.
  const preamble = priorRoster
    ? `Context — previous rolling summary of this conversation:\n"""\n${priorRoster}\n"""\n\nThe messages below are what happened AFTER that summary.\n\n`
    : '';
  // ROSTER must stay the LAST format line in both variants:
  // parseTitlePassResponse's multi-line capture stops at the next KEY: line
  // or end-of-text, so a field placed after it would be swallowed. The two
  // spoken lines therefore sit just before it.
  const shared = 'a 3-5 word title (max 34 chars) describing the overall topic/feature being worked on';
  const spokenItem = 'Two spoken versions of the agent\'s latest reply, for someone listening instead of reading';
  const spokenLines = `${SPOKEN_FORMAT}\n${SPOKEN_MORE_FORMAT}`;
  const format = hasCumulative
    ? `Based on these recent messages, provide:\n1. ${shared}, e.g. "infrastructure documentation refinement" or "plan mode fix"\n2. A brief 1-sentence summary of what just happened\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nNEW: <1 sentence>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific and concise.`
    : `Based on these messages, provide:\n1. ${shared}, e.g. "bridge room name truncation" or "voice note support"\n2. A 1-2 sentence summary (what's been done, current status)\n3. ${spokenItem}\n4. A 2-3 sentence rolling summary of what this session is working on right now\n\nFormat:\nTITLE: <title>\nSUMMARY: <summary>\n${spokenLines}\nROSTER: <2-3 sentences describing what this session is working on right now, for other agents deciding whether to contact it>\n\nNo quotes. Be specific.`;
  return `${preamble}${format}\n\nMessages:\n${rendered}`;
}
