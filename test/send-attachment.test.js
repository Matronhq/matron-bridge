import { describe, it, expect } from 'vitest';
import { classifyContentType } from '../lib/send-attachment.js';

describe('classifyContentType', () => {
  it('classifies common image extensions as images', () => {
    expect(classifyContentType('shot.png')).toEqual({ contentType: 'image/png', isImage: true });
    expect(classifyContentType('IMG_001.JPG')).toEqual({ contentType: 'image/jpeg', isImage: true });
    expect(classifyContentType('anim.gif')).toEqual({ contentType: 'image/gif', isImage: true });
    expect(classifyContentType('pic.webp')).toEqual({ contentType: 'image/webp', isImage: true });
    expect(classifyContentType('photo.heic')).toEqual({ contentType: 'image/heic', isImage: true });
  });

  it('classifies documents and text as non-image files', () => {
    expect(classifyContentType('report.pdf')).toEqual({ contentType: 'application/pdf', isImage: false });
    expect(classifyContentType('build.log')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('notes.txt')).toEqual({ contentType: 'text/plain', isImage: false });
    expect(classifyContentType('README.md')).toEqual({ contentType: 'text/markdown', isImage: false });
    expect(classifyContentType('data.json')).toEqual({ contentType: 'application/json', isImage: false });
    expect(classifyContentType('data.csv')).toEqual({ contentType: 'text/csv', isImage: false });
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(classifyContentType('mystery.bin')).toEqual({ contentType: 'application/octet-stream', isImage: false });
    expect(classifyContentType('Makefile')).toEqual({ contentType: 'application/octet-stream', isImage: false });
  });
});
