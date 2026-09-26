import { describe, expect, it, vi } from 'vitest';
import {
  denialToStatus,
  parseShowFileUploadTimeoutMs,
  shareAgentMedia,
} from '../lib/show-file.js';

class MockFileLinkDenied extends Error {
  constructor(reason) {
    super(`denied: ${reason}`);
    this.reason = reason;
  }
}

function makeDeps({ realPath = '/work/chart.PNG', content = Buffer.from('image data') } = {}) {
  return {
    validateAndOpen: vi.fn().mockResolvedValue({ content, realPath }),
    FileLinkDenied: MockFileLinkDenied,
    uploadMedia: vi.fn().mockResolvedValue({
      media_id: 'media-123',
      content_type: 'image/png',
      size: content.length,
      sha256: 'sha-abc',
    }),
    publish: vi.fn(),
  };
}

function share(deps, overrides = {}) {
  return shareAgentMedia({
    filePath: '/work/chart.PNG',
    caption: 'Quarterly chart',
    pinnedRoots: { roots: [{ realPath: '/work' }] },
    maxBytes: 50 * 1024 * 1024,
    uploadTimeoutMs: 30000,
    deps,
    ...overrides,
  });
}

describe('shareAgentMedia', () => {
  it('uploads and publishes an image with its filename, name, and caption', async () => {
    const content = Buffer.from('image data');
    const deps = makeDeps({ content });

    const result = await share(deps);

    expect(deps.validateAndOpen).toHaveBeenCalledWith('/work/chart.PNG', {
      allowedRoots: { roots: [{ realPath: '/work' }] },
      maxBytes: 50 * 1024 * 1024,
      strictSnapshot: true,
    });
    expect(deps.uploadMedia).toHaveBeenCalledWith({
      bytes: content,
      contentType: 'image/png',
      name: 'chart.PNG',
      timeoutMs: 30000,
    });
    expect(deps.publish).toHaveBeenCalledWith('publishImage', {
      blob_ref: 'media-123',
      content_type: 'image/png',
      name: 'chart.PNG',
      filename: 'chart.PNG',
      size: content.length,
      caption: 'Quarterly chart',
    });
    expect(result).toEqual({
      ok: true,
      media_id: 'media-123',
      kind: 'image',
      realPath: '/work/chart.PNG',
      size: content.length,
      sha256: 'sha-abc',
    });
  });

  it('publishes a non-image as a file without an absent caption', async () => {
    const content = Buffer.from('pdf data');
    const deps = makeDeps({ realPath: '/work/report.pdf', content });
    deps.uploadMedia.mockResolvedValue({
      media_id: 'media-pdf',
      content_type: 'application/octet-stream',
      size: content.length,
      sha256: 'sha-pdf',
    });

    const result = await share(deps, {
      filePath: '/work/report.pdf',
      caption: undefined,
    });

    expect(deps.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/octet-stream',
      name: 'report.pdf',
    }));
    expect(deps.publish).toHaveBeenCalledWith('publishFile', {
      blob_ref: 'media-pdf',
      content_type: 'application/octet-stream',
      name: 'report.pdf',
      filename: 'report.pdf',
      size: content.length,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      media_id: 'media-pdf',
      kind: 'file',
      realPath: '/work/report.pdf',
      size: content.length,
      sha256: 'sha-pdf',
    }));
  });

  it.each([
    'sensitive',
    'outside-scope',
    'too-large',
    'not-a-file',
    'unreadable',
    'symlink',
    'relative-path',
    'bad-workdir',
  ])('surfaces the %s denial without uploading or publishing', async (reason) => {
    const deps = makeDeps();
    deps.validateAndOpen.mockRejectedValue(new MockFileLinkDenied(reason));

    await expect(share(deps)).resolves.toEqual({ denied: reason });
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['a pinned object with no roots', { roots: [] }],
    ['a pinned object missing roots', { pinned: true }],
    ['undefined', undefined],
  ])('fails closed with bad-workdir when the pinned root set is %s', async (_label, pinnedRoots) => {
    const deps = makeDeps();

    await expect(share(deps, { pinnedRoots })).resolves.toEqual({ denied: 'bad-workdir' });
    expect(deps.validateAndOpen).not.toHaveBeenCalled();
    expect(deps.uploadMedia).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('routes an SVG to the downloadable-attachment path, not an inline image', async () => {
    const content = Buffer.from('<svg></svg>');
    const deps = makeDeps({ realPath: '/work/diagram.svg', content });
    deps.uploadMedia.mockResolvedValue({ media_id: 'media-svg' });

    const result = await share(deps, { filePath: '/work/diagram.svg' });

    expect(deps.uploadMedia).toHaveBeenCalledWith(expect.objectContaining({
      contentType: 'application/octet-stream',
      name: 'diagram.svg',
    }));
    expect(deps.publish).toHaveBeenCalledWith('publishFile', expect.objectContaining({
      blob_ref: 'media-svg',
      content_type: 'application/octet-stream',
    }));
    expect(result).toEqual(expect.objectContaining({ ok: true, kind: 'file' }));
  });

  it('returns upload-failed and does not publish when uploadMedia returns null', async () => {
    const deps = makeDeps();
    deps.uploadMedia.mockResolvedValue(null);

    await expect(share(deps)).resolves.toEqual({ denied: 'upload-failed' });
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('falls back to the requested MIME and local byte length when upload metadata is partial', async () => {
    const content = Buffer.from('image data');
    const deps = makeDeps({ content });
    deps.uploadMedia.mockResolvedValue({ media_id: 'media-partial' });

    const result = await share(deps);

    expect(deps.publish).toHaveBeenCalledWith('publishImage', expect.objectContaining({
      blob_ref: 'media-partial',
      content_type: 'image/png',
      size: content.length,
    }));
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      media_id: 'media-partial',
      size: content.length,
    }));
  });
});

describe('denialToStatus', () => {
  it.each([
    ['sensitive', 403],
    ['outside-scope', 403],
    ['too-large', 413],
    ['not-a-file', 404],
    ['unreadable', 404],
    ['symlink', 404],
    ['relative-path', 404],
    ['bad-workdir', 404],
    ['upload-failed', 502],
  ])('maps %s to %i', (reason, status) => {
    expect(denialToStatus(reason)).toBe(status);
  });

  it('maps an unknown denial to the safe 502 default', () => {
    expect(denialToStatus('unexpected-reason')).toBe(502);
  });
});

describe('parseShowFileUploadTimeoutMs', () => {
  it.each(['-1', 'Infinity', 'not-a-number', '300001'])(
    'warns and defaults invalid value %s to 30000',
    (rawValue) => {
      const warn = vi.fn();

      expect(parseShowFileUploadTimeoutMs(rawValue, warn)).toBe(30000);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(rawValue));
    },
  );

  it('returns a valid positive integer unchanged without warning', () => {
    const warn = vi.fn();

    expect(parseShowFileUploadTimeoutMs('45000', warn)).toBe(45000);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('shareAgentMedia Files deep link', () => {
  const WEB = 'https://web.example.com';

  it('appends a Files deep link to the caption when webBaseUrl is set', async () => {
    const deps = makeDeps({ realPath: '/work/report.pdf', content: Buffer.from('pdf bytes') });
    deps.uploadMedia.mockResolvedValue({ media_id: 'm1', content_type: 'application/pdf', size: 9, sha256: 's1' });
    await share(deps, { filePath: '/work/report.pdf', caption: 'the report', deps: { ...deps, webBaseUrl: WEB } });
    const [, payload] = deps.publish.mock.calls[0];
    expect(payload.caption).toBe(
      `the report\n\n📁 Open report.pdf in Files: ${WEB}/#files=${encodeURIComponent('/work/report.pdf')}`,
    );
  });

  it('produces a caption from just the link when the agent passed none', async () => {
    const deps = makeDeps({ realPath: '/work/report.pdf', content: Buffer.from('pdf bytes') });
    deps.uploadMedia.mockResolvedValue({ media_id: 'm1', content_type: 'application/pdf', size: 9, sha256: 's1' });
    await share(deps, { filePath: '/work/report.pdf', caption: undefined, deps: { ...deps, webBaseUrl: WEB } });
    const [, payload] = deps.publish.mock.calls[0];
    expect(payload.caption).toBe(
      `📁 Open report.pdf in Files: ${WEB}/#files=${encodeURIComponent('/work/report.pdf')}`,
    );
  });

  it('gates the link on the pinned root that actually holds the file, not just the first', async () => {
    const deps = makeDeps({ realPath: '/artifacts/out.pdf', content: Buffer.from('pdf bytes') });
    deps.uploadMedia.mockResolvedValue({ media_id: 'm1', content_type: 'application/pdf', size: 9, sha256: 's1' });
    await share(deps, {
      filePath: '/artifacts/out.pdf',
      caption: 'build output',
      pinnedRoots: { roots: [{ realPath: '/work' }, { realPath: '/artifacts' }] },
      deps: { ...deps, webBaseUrl: WEB },
    });
    const [, payload] = deps.publish.mock.calls[0];
    expect(payload.caption).toBe(
      `build output\n\n📁 Open out.pdf in Files: ${WEB}/#files=${encodeURIComponent('/artifacts/out.pdf')}`,
    );
  });

  it('does not treat a sibling that shares a root prefix as inside that root', async () => {
    const deps = makeDeps({ realPath: '/work-other/x.pdf', content: Buffer.from('pdf bytes') });
    deps.uploadMedia.mockResolvedValue({ media_id: 'm1', content_type: 'application/pdf', size: 9, sha256: 's1' });
    await share(deps, { filePath: '/work-other/x.pdf', caption: 'x', deps: { ...deps, webBaseUrl: WEB } });
    const [, payload] = deps.publish.mock.calls[0];
    expect(payload.caption).toBe('x');
  });

  it('leaves the caption untouched (plain-path fallback) when webBaseUrl is unset', async () => {
    const deps = makeDeps();
    await share(deps); // no webBaseUrl in deps
    const [, payload] = deps.publish.mock.calls[0];
    expect(payload.caption).toBe('Quarterly chart');
  });
});
