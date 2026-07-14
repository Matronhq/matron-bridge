import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { decodeByteExact, toolOutputSnippet, createToolStreamPump } from '../lib/tool-stream-pump.js';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, timeoutMs = 3000, intervalMs = 10) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
    await delay(intervalMs);
  }
}

// Collects streamAppend calls; content() reassembles the logical stream by
// offset so tests assert on WHAT arrived, not how it was chunked.
function makeSink() {
  const frames = [];
  const sink = (convoId, messageRef, offset, chunk, meta) => {
    frames.push({ convoId, messageRef, offset, chunk, meta, at: Date.now() });
  };
  sink.frames = frames;
  sink.content = () => {
    let out = '';
    for (const f of [...frames].sort((a, b) => a.offset - b.offset)) {
      // A resync re-send can overlap what we already have; overlay by offset.
      const bytes = Buffer.byteLength(out);
      if (f.offset <= bytes) {
        out = Buffer.concat([
          Buffer.from(out).subarray(0, f.offset),
          Buffer.from(f.chunk),
        ]).toString('utf-8');
      }
    }
    return out;
  };
  return sink;
}

describe('decodeByteExact', () => {
  it('decodes plain ASCII, consuming every byte', () => {
    const r = decodeByteExact(Buffer.from('hello world'));
    expect(r).toEqual({ text: 'hello world', consumed: 11, held: 0 });
  });

  it('decodes multi-byte UTF-8 with byte length preserved', () => {
    const buf = Buffer.from('a😀é');
    const r = decodeByteExact(buf);
    expect(r.text).toBe('a😀é');
    expect(r.consumed).toBe(buf.length);
    expect(Buffer.byteLength(r.text)).toBe(r.consumed);
  });

  it('holds back an incomplete trailing sequence', () => {
    const emoji = Buffer.from('😀'); // 4 bytes
    const buf = Buffer.concat([Buffer.from('ab'), emoji.subarray(0, 2)]);
    const r = decodeByteExact(buf);
    expect(r).toEqual({ text: 'ab', consumed: 2, held: 2 });
  });

  it('replaces invalid bytes 1:1 with ? so byte length never drifts', () => {
    const buf = Buffer.from([0x61, 0xff, 0xfe, 0x62]); // a <bad> <bad> b
    const r = decodeByteExact(buf);
    expect(r.text).toBe('a??b');
    expect(r.consumed).toBe(4);
    expect(Buffer.byteLength(r.text)).toBe(4);
  });

  it('replaces overlong encodings with per-byte ? (byte length preserved)', () => {
    const buf = Buffer.from([0xc0, 0x80, 0x61]); // overlong NUL + 'a'
    const r = decodeByteExact(buf);
    expect(r.text).toBe('??a');
    expect(Buffer.byteLength(r.text)).toBe(3);
  });

  it('treats a stray continuation byte as invalid, not a held tail', () => {
    const r = decodeByteExact(Buffer.from([0x80, 0x61]));
    expect(r.text).toBe('?a');
    expect(r.consumed).toBe(2);
  });
});

describe('toolOutputSnippet', () => {
  it('returns short output unchanged', () => {
    expect(toolOutputSnippet('one\ntwo\n')).toBe('one\ntwo\n');
  });

  it('keeps only the last 50 lines', () => {
    const text = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
    const snip = toolOutputSnippet(text);
    expect(snip.startsWith('line10')).toBe(true);
    expect(snip.endsWith('line59')).toBe(true);
    expect(snip.split('\n')).toHaveLength(50);
  });

  it('caps at 4096 bytes without splitting a multi-byte char', () => {
    const text = '😀'.repeat(2000); // 8000 bytes, one line
    const snip = toolOutputSnippet(text);
    expect(Buffer.byteLength(snip)).toBeLessThanOrEqual(4096);
    expect(snip.includes('�')).toBe(false);
    expect(Buffer.byteLength(snip)).toBe(4096); // 1024 emoji exactly — cut lands on a boundary
  });

  it('returns empty string for empty/non-string input', () => {
    expect(toolOutputSnippet('')).toBe('');
    expect(toolOutputSnippet(null)).toBe('');
  });

  it('walks the cut forward past continuation bytes when the naive cut lands mid-character', () => {
    // 'a' (1 byte) + 😀 (4 bytes: F0 9F 98 80) + 'bb' (2 bytes) = 7 bytes.
    // maxBytes=4 makes the naive cut (7-4=3) land on the emoji's THIRD byte
    // (a continuation byte) — unlike the existing 4096-byte-default test,
    // where the cut happens to land exactly on a character boundary. The
    // walk-forward `while` loop must advance past the two remaining
    // continuation bytes (indices 3 and 4) to land cleanly on 'b' at index
    // 5, dropping the whole torn character rather than emitting a
    // replacement char or a corrupted partial sequence.
    const text = 'a😀bb';
    const snip = toolOutputSnippet(text, { maxBytes: 4 });
    expect(snip).toBe('bb');
    expect(Buffer.byteLength(snip)).toBeLessThanOrEqual(4);
    expect(snip.includes('�')).toBe(false);
  });
});

describe('createToolStreamPump', () => {
  function setup({ preContent = null, throttleMs = 0, chunkBytes = 65536, maxBytesPerPass } = {}) {
    const dir = mkdtempSync(path.join(tmpdir(), 'tool-stream-pump-'));
    const logPath = path.join(dir, 'matron-cmd-tu1.log');
    if (preContent !== null) writeFileSync(logPath, preContent);
    const sink = makeSink();
    const pump = createToolStreamPump({
      logPath,
      convoId: 'c1',
      messageRef: 'tu1',
      meta: { tool: 'Bash', command: 'npm test' },
      streamAppend: sink,
      throttleMs,
      chunkBytes,
      ...(maxBytesPerPass !== undefined ? { maxBytesPerPass } : {}),
    });
    const cleanup = () => {
      pump.stop();
      rmSync(dir, { recursive: true, force: true });
    };
    return { dir, logPath, sink, pump, cleanup };
  }

  it('sends existing content on start, offset 0, with meta', async () => {
    const { sink, pump, cleanup } = setup({ preContent: 'hello\n' });
    try {
      pump.start();
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({
        convoId: 'c1', messageRef: 'tu1', offset: 0, chunk: 'hello\n',
        meta: { tool: 'Bash', command: 'npm test' },
      });
    } finally {
      cleanup();
    }
  });

  it('picks up appended bytes via the watcher, contiguous offsets, no meta after 0', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'aa' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'aa');
      appendFileSync(logPath, 'bb');
      await waitFor(() => sink.content() === 'aabb');
      const second = sink.frames.find((f) => f.offset === 2);
      expect(second.chunk).toBe('bb');
      expect(second.meta).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('starts against a log file that does not exist yet', async () => {
    const { logPath, sink, pump, cleanup } = setup();
    try {
      pump.start();
      await delay(50);
      expect(sink.frames).toHaveLength(0);
      writeFileSync(logPath, 'late\n');
      await waitFor(() => sink.content() === 'late\n');
      expect(sink.frames[0].offset).toBe(0);
      expect(sink.frames[0].meta).toEqual({ tool: 'Bash', command: 'npm test' });
    } finally {
      cleanup();
    }
  });

  it('keeps >=throttleMs between pump passes', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'a', throttleMs: 300 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'a');
      appendFileSync(logPath, 'b');
      await waitFor(() => sink.content() === 'ab', 5000);
      const gap = sink.frames[1].at - sink.frames[0].at;
      expect(gap).toBeGreaterThanOrEqual(290); // small tolerance for timer slop
    } finally {
      cleanup();
    }
  });

  it('slices a large backlog into chunkBytes frames on UTF-8 boundaries', async () => {
    // 2-byte char (é) with chunkBytes 7 (odd): cut at byte 7 lands mid-character,
    // forcing the tear-and-resume logic. Content is 24 bytes; each frame up to the
    // last will hold 3 complete chars (6 bytes), and the logic must hold back the
    // split char and resume it in the next pump cycle.
    const { sink, pump, cleanup } = setup({ preContent: 'ééé'.repeat(4), chunkBytes: 7 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'ééé'.repeat(4));
      // Verify we got more than one frame (the windowing actually engaged).
      expect(sink.frames.length).toBeGreaterThan(1);
      // Verify reassembled content has no U+FFFD replacement chars.
      expect(sink.content().includes('�')).toBe(false);
      // Offsets are contiguous and byte-exact.
      let expected = 0;
      for (const f of [...sink.frames].sort((a, b) => a.offset - b.offset)) {
        expect(f.offset).toBe(expected);
        expected += Buffer.byteLength(f.chunk);
      }
    } finally {
      cleanup();
    }
  });

  it('holds back a torn trailing multi-byte char until completed', async () => {
    const emoji = Buffer.from('😀');
    const { logPath, sink, pump, cleanup } = setup();
    try {
      writeFileSync(logPath, Buffer.concat([Buffer.from('x'), emoji.subarray(0, 2)]));
      pump.start();
      await waitFor(() => sink.content() === 'x');
      appendFileSync(logPath, emoji.subarray(2));
      await waitFor(() => sink.content() === 'x😀');
      for (const f of sink.frames) expect(f.chunk.includes('�')).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('resync(have) rewinds and re-sends from that byte, meta again at 0', async () => {
    const { sink, pump, cleanup } = setup({ preContent: 'abcdef' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'abcdef');
      sink.frames.length = 0;
      pump.resync(0);
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({
        offset: 0, chunk: 'abcdef', meta: { tool: 'Bash', command: 'npm test' },
      });
      sink.frames.length = 0;
      pump.resync(3);
      await waitFor(() => sink.frames.length === 1);
      expect(sink.frames[0]).toMatchObject({ offset: 3, chunk: 'def' });
      expect(sink.frames[0].meta).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('sends nothing after stop()', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'a' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'a');
      pump.stop();
      appendFileSync(logPath, 'b');
      pump.resync(0);
      await delay(80);
      expect(sink.content()).toBe('a');
    } finally {
      cleanup();
    }
  });

  it('drains a backlog over the per-pass byte budget across multiple passes, self-scheduled without further writes', async () => {
    // 500 bytes of preContent, all written before start() — no appendFileSync
    // ever happens in this test. With a 50-byte budget the pump can only
    // publish 50 bytes per pass, so full drain REQUIRES self-scheduling
    // follow-up passes; fs.watch will never fire again since nothing more is
    // written. throttleMs is small but nonzero so passes are genuinely
    // spaced out (not one synchronous unwind), exercising the real
    // self-schedule path.
    const content = 'x'.repeat(500);
    const { sink, pump, cleanup } = setup({ preContent: content, throttleMs: 5, maxBytesPerPass: 50 });
    try {
      pump.start();
      await waitFor(() => sink.content() === content, 5000);
      // Budget engaged: more than one pass was needed (500 / 50 == 10 passes).
      expect(sink.frames.length).toBeGreaterThan(1);
      // Byte-exact, contiguous offsets across every published frame — no
      // drops, no coalescing, no overlap — and the total matches exactly.
      let expected = 0;
      for (const f of [...sink.frames].sort((a, b) => a.offset - b.offset)) {
        expect(f.offset).toBe(expected);
        expected += Buffer.byteLength(f.chunk);
      }
      expect(expected).toBe(500);
    } finally {
      cleanup();
    }
  });

  it('flushFinal() publishes tail bytes written after stop(), byte-exact', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'aa', throttleMs: 0 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'aa');
      appendFileSync(logPath, 'bb');
      pump.stop(); // synchronous — the watcher's async notification for 'bb' can't have fired yet
      expect(sink.content()).toBe('aa'); // confirms the write hasn't streamed as a live append
      await pump.flushFinal();
      expect(sink.content()).toBe('aabb');
      const last = sink.frames[sink.frames.length - 1];
      expect(last.offset).toBe(2);
      expect(last.chunk).toBe('bb');
    } finally {
      cleanup();
    }
  });

  it('flushFinal(maxBytes) honors the cap when the un-flushed tail exceeds it', async () => {
    const { logPath, sink, pump, cleanup } = setup({ preContent: 'a', throttleMs: 0 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'a');
      appendFileSync(logPath, 'x'.repeat(200));
      pump.stop();
      expect(sink.content()).toBe('a');
      await pump.flushFinal(50);
      // Capped: only 50 of the 200 un-flushed bytes went out, not the whole tail.
      expect(Buffer.byteLength(sink.content())).toBe(1 + 50);
    } finally {
      cleanup();
    }
  });

  it('flushFinal() is safe to call on a pump with nothing left to flush (no-op)', async () => {
    const { sink, pump, cleanup } = setup({ preContent: 'done' });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'done');
      pump.stop();
      const framesBefore = sink.frames.length;
      await expect(pump.flushFinal()).resolves.toBeUndefined();
      expect(sink.frames.length).toBe(framesBefore);
    } finally {
      cleanup();
    }
  });

  it('clamps chunkBytes below 4 to prevent permanent stall on multi-byte splits', async () => {
    // Pass chunkBytes: 1 (narrower than any UTF-8 character); the clamping logic
    // must enforce a minimum of 4. Content 'aé' is 3 bytes (a=1, é=2), so even
    // a 4-byte window can hold it completely on the first pump call.
    const { sink, pump, cleanup } = setup({ preContent: 'aé', chunkBytes: 1 });
    try {
      pump.start();
      await waitFor(() => sink.content() === 'aé');
      expect(sink.frames.length).toBe(1);
      expect(sink.frames[0].chunk).toBe('aé');
      // Verify no corruption or replacement chars.
      expect(sink.content()).toBe('aé');
    } finally {
      cleanup();
    }
  });
});

// index.js can't be imported in-process (top-level side effects — starts
// express, connects to Matrix, etc; see test/showbashoutput.test.js's own
// note on this), so killSession's "finalize every open tool-stream pump
// belonging to a killed session" behavior (killSession calling
// sweepToolStreams, index.js ~6355) is pinned by source inspection instead —
// the same idiom test/busy-queue.test.js and test/journal-input-router.test.js
// already use for other index.js-only wiring this suite can't exercise
// directly.
describe('index.js killSession — tool-stream sweep wiring (source inspection)', () => {
  it('killSession calls sweepToolStreams(session) unconditionally, before the alive/kill-signal gate', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');
    const start = src.indexOf('function killSession(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toMatch(/\bsweepToolStreams\(session\)/);
    // Unconditional: the sweep must run BEFORE the `!session.alive` early
    // return, so a process that already died (or never went alive) still
    // gets its open tool-stream pumps finalized rather than orphaned.
    const sweepIdx = body.indexOf('sweepToolStreams(session)');
    const aliveGateIdx = body.indexOf('if (!session.alive)');
    expect(aliveGateIdx).toBeGreaterThan(-1);
    expect(sweepIdx).toBeLessThan(aliveGateIdx);
  });
});
