// Context is public to the request's readers, never a place for the value.
// It also travels in the signed form URL, so keep the explanation bounded.
export const SECRET_CONTEXT_MAX_LENGTH = 2000;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only Markdown HTTP(S) links get markup. Everything else stays escaped
// text, including HTML and links with executable or custom URL schemes.
export function formatSecretContextHtml(context) {
  if (typeof context !== 'string') return '';
  let html = '';
  let offset = 0;
  for (const match of context.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^()\s<>]+)\)/g)) {
    html += escapeHtml(context.slice(offset, match.index));
    html += `<a href="${escapeHtml(match[2])}" rel="noreferrer">${escapeHtml(match[1])}</a>`;
    offset = match.index + match[0].length;
  }
  return html + escapeHtml(context.slice(offset));
}
