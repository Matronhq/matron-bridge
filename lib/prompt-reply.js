// Parsing for replies the user types to a surfaced TUI prompt.
//
// A reply may be a bare option pick ("1", "1.", "2)", "a") OR an option pick
// with an appended remark ("1. also use compiled css in the editor too"). The
// old resolver ran `parseInt(reply, 10)`, which happily returned 1 from
// "1. also …" and then DISCARDED the rest of the message — so anything the user
// added after the number was silently dropped (issue #82). parseOptionReply
// splits the leading option token from the remainder so the caller can route
// the choice AND the remark to claude.

// A leading option token is a run of digits OR a single letter, optionally
// followed by a `.`/`)` separator. Anything after that (once whitespace is
// consumed) is the remark. The token must be followed by end-of-string, the
// separator, or whitespace — so free-form prose that merely starts with a
// letter ("also …", "yes do it") does NOT parse as a token.
const OPTION_TOKEN_RE = /^(\d+|[A-Za-z])[.)]?(?:\s+([\s\S]+))?$/;

export function parseOptionReply(userText) {
  const trimmed = (userText || '').trim();
  const m = trimmed.match(OPTION_TOKEN_RE);
  if (!m) return { token: null, extra: '' };
  return { token: m[1], extra: (m[2] || '').trim() };
}
