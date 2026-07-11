// Origin-aware queue flushing for the bridge's queued-while-busy (and
// resume-hold) message paths. Pure — no I/O, no session state — so the
// merge/grouping rules are unit-testable without index.js.
//
// Why origin matters: sendToSession's journal mirror is the single choke
// point that records a user's message in the journal. Matrix-originated
// messages MUST mirror there (the journal has no other way of learning
// them); journal-originated messages (Matron client `send` rows routed back
// in through the return path) must NOT — the journal already has the user's
// own row, and re-mirroring on flush would surface a duplicate in every
// journal client. Immediate sends carry that distinction as a call-site
// flag (skipJournalMirror), but a queued/held message outlives its call
// site — so the origin travels WITH the queued blocks (markJournalOrigin)
// and planQueueFlush turns a mixed queue into per-origin sends that each
// carry the right flag.

const JOURNAL_ORIGIN_KEY = '_journalOrigin';

// Tag a blocks array as journal-originated. A non-enumerable property so it
// never leaks into JSON.stringify (stdin frames, debug dumps) or block
// iteration; the tag rides along wherever the same array object goes
// (queuedMessages, _resumeOutbox, cross-restart carry).
export function markJournalOrigin(blocks) {
  try {
    Object.defineProperty(blocks, JOURNAL_ORIGIN_KEY, { value: true, enumerable: false });
  } catch { /* frozen/exotic array — treat as unmarked rather than throw */ }
  return blocks;
}

export function isJournalOrigin(blocks) {
  return !!(blocks && blocks[JOURNAL_ORIGIN_KEY]);
}

// Turn a queue of blocks-arrays (each entry one queued message, possibly
// origin-marked) into an ordered list of sends: `[{ blocks, journalOrigin }]`.
//
// Within one contiguous same-origin run this reproduces flushQueue's
// original merge exactly — consecutive text-only entries merge into a single
// text block ('\n' within an entry, '\n\n' between entries), media entries
// flush accumulated text first and then ride in the same send. An origin
// flip ends the run and starts a new send: origins are never merged into
// one send, because a single send can only mirror-or-not as a whole.
export function planQueueFlush(queued) {
  const sends = [];
  if (!Array.isArray(queued) || queued.length === 0) return sends;

  let run = null; // { blocks: [], journalOrigin, textAccum: [] }

  const flushText = () => {
    if (!run || run.textAccum.length === 0) return;
    const combined = run.textAccum.map(blocks => blocks.map(b => b.text).join('\n')).join('\n\n');
    run.blocks.push({ type: 'text', text: combined });
    run.textAccum = [];
  };

  const endRun = () => {
    if (!run) return;
    flushText();
    if (run.blocks.length > 0) sends.push({ blocks: run.blocks, journalOrigin: run.journalOrigin });
    run = null;
  };

  for (const blocks of queued) {
    const origin = isJournalOrigin(blocks);
    if (!run || run.journalOrigin !== origin) {
      endRun();
      run = { blocks: [], journalOrigin: origin, textAccum: [] };
    }
    const isTextOnly = blocks.every(b => b.type === 'text');
    if (isTextOnly) {
      run.textAccum.push(blocks);
    } else {
      flushText();
      run.blocks.push(...blocks);
    }
  }
  endRun();

  return sends;
}
