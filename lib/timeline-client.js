// HTTP client for the journal's Projects timeline routes (journal
// docs/protocol.md "Projects timeline"): the week the Coordinator writes, one
// entry per project, and the raw week it writes it from. Uses the shared
// requester (lib/journal-http.js): Bearer against the journal HTTP base,
// bounded timeout, RETURNS {status, data} (status 0 = unreachable) so the tool layer
// can turn 400/403/404/409 into sentences. Never throws; never logs the token.
import { createJournalRequester, enc, qs } from './journal-http.js';

export function createTimelineClient(opts = {}) {
  const request = createJournalRequester(opts);
  return {
    // One week with the raw material it is written from, and what is
    // already stored for it, a page of projects at a time. The first page
    // (offset 0) is asked for without the parameter.
    readWeekRaw: (week, { offset } = {}) => request('GET', `/timeline/weeks/${enc(week)}?raw=1${Number.isSafeInteger(offset) && offset > 0 ? `&offset=${offset}` : ''}`),
    // Newest first; the first entry is the current week.
    listWeeks: ({ limit } = {}) => request('GET', `/timeline/weeks${qs({ limit })}`),
    // The Went quiet list, sieved the way the raw week read is (raw=1), since
    // the Coordinator may run on a private device.
    wentQuiet: () => request('GET', '/timeline/quiet?raw=1'),
    // One entry per project. An older journal has no such path and answers
    // 404, storing nothing.
    writeWeekEntries: (week, body) => request('POST', `/timeline/weeks/${enc(week)}/entries`, { body }),
  };
}
