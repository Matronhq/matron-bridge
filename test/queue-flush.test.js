import { describe, it, expect } from 'vitest';
import { markJournalOrigin, isJournalOrigin, planQueueFlush } from '../lib/queue-flush.js';

const text = (t) => [{ type: 'text', text: t }];
const media = (name) => [{ type: 'image', source: name }];

describe('markJournalOrigin / isJournalOrigin', () => {
  it('marks and detects a blocks array', () => {
    const blocks = text('hi');
    expect(isJournalOrigin(blocks)).toBe(false);
    expect(markJournalOrigin(blocks)).toBe(blocks); // returns the same array
    expect(isJournalOrigin(blocks)).toBe(true);
  });

  it('is safe on null/undefined', () => {
    expect(isJournalOrigin(null)).toBe(false);
    expect(isJournalOrigin(undefined)).toBe(false);
  });
});

describe('planQueueFlush', () => {
  it('returns [] for an empty queue', () => {
    expect(planQueueFlush([])).toEqual([]);
    expect(planQueueFlush(null)).toEqual([]);
  });

  it('merges all-Matrix-origin text entries into one unmarked send (existing behavior)', () => {
    const sends = planQueueFlush([text('one'), text('two'), text('three')]);
    expect(sends.length).toBe(1);
    expect(sends[0].journalOrigin).toBe(false);
    expect(sends[0].blocks).toEqual([{ type: 'text', text: 'one\n\ntwo\n\nthree' }]);
  });

  it('merges all-journal-origin text entries into one send flagged journalOrigin', () => {
    const sends = planQueueFlush([markJournalOrigin(text('a')), markJournalOrigin(text('b'))]);
    expect(sends.length).toBe(1);
    expect(sends[0].journalOrigin).toBe(true);
    expect(sends[0].blocks).toEqual([{ type: 'text', text: 'a\n\nb' }]);
  });

  it('mixed origin: splits into separate sends, preserving order, each with its own flag', () => {
    const sends = planQueueFlush([
      text('matrix-1'),
      markJournalOrigin(text('matron-1')),
      markJournalOrigin(text('matron-2')),
      text('matrix-2'),
    ]);
    expect(sends.map(s => s.journalOrigin)).toEqual([false, true, false]);
    expect(sends[0].blocks).toEqual([{ type: 'text', text: 'matrix-1' }]);
    expect(sends[1].blocks).toEqual([{ type: 'text', text: 'matron-1\n\nmatron-2' }]);
    expect(sends[2].blocks).toEqual([{ type: 'text', text: 'matrix-2' }]);
  });

  it('media entries flush accumulated text first, then ride in the same send (within one origin run)', () => {
    const sends = planQueueFlush([text('caption'), media('pic.png'), text('after')]);
    expect(sends.length).toBe(1);
    expect(sends[0].journalOrigin).toBe(false);
    expect(sends[0].blocks).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', source: 'pic.png' },
      { type: 'text', text: 'after' },
    ]);
  });

  it('multiple text blocks within one entry merge with \\n, entries with \\n\\n (existing behavior)', () => {
    const twoBlocks = [{ type: 'text', text: 'l1' }, { type: 'text', text: 'l2' }];
    const sends = planQueueFlush([twoBlocks, text('next')]);
    expect(sends.length).toBe(1);
    expect(sends[0].blocks).toEqual([{ type: 'text', text: 'l1\nl2\n\nnext' }]);
  });

  it('an origin flip next to a media entry still keeps origins strictly separated', () => {
    const sends = planQueueFlush([
      media('a.png'),
      markJournalOrigin(text('matron')),
    ]);
    expect(sends.map(s => s.journalOrigin)).toEqual([false, true]);
    expect(sends[0].blocks).toEqual([{ type: 'image', source: 'a.png' }]);
    expect(sends[1].blocks).toEqual([{ type: 'text', text: 'matron' }]);
  });
});
