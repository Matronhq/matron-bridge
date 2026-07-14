import { describe, it, expect, vi } from 'vitest';
import { createJournalMediaRouter } from '../lib/journal-media.js';

const silentLog = { warn: () => {}, error: () => {} };

// Fully-injected orchestrator: every I/O boundary (fetchMedia, transcribe, the
// save/build + inject sinks) is a mock, so the fetch -> transcribe/save ->
// inject flow is exercised without a journal server, whisper, or a real claude
// session. The returned routeMedia is async and must never throw/reject.
function makeRouter(overrides = {}) {
  const deps = {
    fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes'), contentType: 'application/pdf' })),
    transcribe: vi.fn(async () => 'hello world'),
    buildSavedBlocks: vi.fn(() => [{ type: 'text', text: 'File saved to /w/report.pdf' }]),
    injectText: vi.fn(() => true),
    injectBlocks: vi.fn(() => true),
    echoToRoom: vi.fn(),
    publishNotice: vi.fn(),
    escapeHtml: (s) => String(s),
    log: silentLog,
    ...overrides,
  };
  return { route: createJournalMediaRouter(deps), deps };
}

const session = { claudeSessionId: 'convo-1', roomId: '!r:s' };
const ctx = { username: 'dan' };

describe('createJournalMediaRouter — file/image', () => {
  it('fetches the blob and injects saved-media blocks WITHOUT re-mirroring (injectBlocks)', async () => {
    const { route, deps } = makeRouter();
    await route(session, { type: 'file', blobRef: 'blob-1', contentType: 'application/pdf', name: 'report.pdf' }, ctx);

    expect(deps.fetchMedia).toHaveBeenCalledWith('blob-1');
    expect(deps.buildSavedBlocks).toHaveBeenCalledTimes(1);
    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs).toMatchObject({ mime: 'application/pdf', isImage: false, name: 'report.pdf' });
    expect(deps.injectBlocks).toHaveBeenCalledWith(session, [{ type: 'text', text: 'File saved to /w/report.pdf' }]);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.transcribe).not.toHaveBeenCalled();
  });

  it('classifies type:image as an image for the block builder', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('img'), contentType: 'image/png' })),
      buildSavedBlocks: vi.fn(() => [{ type: 'text', text: 'Image saved to /w/x.png' }, { type: 'image', source: {} }]),
    });
    await route(session, { type: 'image', blobRef: 'img-1', contentType: 'image/png', name: 'x.png', dims: { w: 2, h: 3 } }, ctx);
    const [, buildArgs] = deps.buildSavedBlocks.mock.calls[0];
    expect(buildArgs).toMatchObject({ isImage: true, dims: { w: 2, h: 3 } });
    expect(deps.injectBlocks).toHaveBeenCalledTimes(1);
  });

  it('uses the fetched content-type when the frame declared none', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'text/plain' })),
    });
    await route(session, { type: 'file', blobRef: 'b', contentType: null, name: 'n.txt' }, ctx);
    expect(deps.buildSavedBlocks.mock.calls[0][1].mime).toBe('text/plain');
  });

  it('a failed fetch (null) warns and drops — no inject, no placeholder', async () => {
    const warnings = [];
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => null),
      log: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    });
    await route(session, { type: 'file', blobRef: 'gone', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
    expect(warnings.some(w => /dropping/.test(w))).toBe(true);
  });

  it('an empty block list is dropped (never injects an empty turn)', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => []) });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.injectBlocks).not.toHaveBeenCalled();
  });

  it('an unavailable session (injectBlocks false) publishes an undeliverable notice', async () => {
    const { route, deps } = makeRouter({ injectBlocks: vi.fn(() => false) });
    await route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf', name: 'x.pdf' }, ctx);
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/isn't available/));
  });

  it('never throws even when a dep throws', async () => {
    const { route, deps } = makeRouter({ buildSavedBlocks: vi.fn(() => { throw new Error('boom'); }) });
    await expect(route(session, { type: 'file', blobRef: 'b', contentType: 'application/pdf' }, ctx)).resolves.toBeUndefined();
    expect(deps.injectBlocks).not.toHaveBeenCalled();
  });
});

describe('createJournalMediaRouter — audio (voice note)', () => {
  it('an audio content-type is transcribed and injected as user text (mirrors the Matrix m.audio wording)', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('ogg'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => 'buy milk'),
    });
    await route(session, { type: 'file', blobRef: 'voice-1', contentType: 'audio/ogg', name: 'voice.ogg' }, ctx);

    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.transcribe.mock.calls[0][1]).toBe('audio/ogg');
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: buy milk');
    expect(deps.injectBlocks).not.toHaveBeenCalled();
    expect(deps.buildSavedBlocks).not.toHaveBeenCalled();
  });

  it('detects audio from the fetched content-type even when the frame declared none', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/mp4' })),
      transcribe: vi.fn(async () => 'hi'),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: null, name: 'v.m4a' }, ctx);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.injectText).toHaveBeenCalledWith(session, '[Voice note transcription]: hi');
  });

  it('a failed transcription warns, notices, and drops — no injection', async () => {
    const warnings = [];
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => { throw new Error('whisper died'); }),
      log: { warn: (...a) => warnings.push(a.join(' ')), error: () => {} },
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/transcribe/));
    expect(warnings.some(w => /transcription failed/.test(w))).toBe(true);
  });

  it('an empty transcript is dropped (no empty turn injected)', async () => {
    const { route, deps } = makeRouter({
      fetchMedia: vi.fn(async () => ({ buffer: Buffer.from('x'), contentType: 'audio/ogg' })),
      transcribe: vi.fn(async () => '   '),
    });
    await route(session, { type: 'file', blobRef: 'v', contentType: 'audio/ogg' }, ctx);
    expect(deps.injectText).not.toHaveBeenCalled();
    expect(deps.publishNotice).toHaveBeenCalledWith('convo-1', expect.stringMatching(/transcribe/));
  });
});
