import { describe, it, expect } from 'vitest';
import { attachPendingMediaMirror, pendingMediaMirror } from '../lib/media-mirror.js';

// Pure tagging helpers (Bugbot finding #4): a media blocks-array carries its
// deferred journal-mirror payload (upload + publish + markRead) all the way
// through queuing / resume-hold to the point the message is ACTUALLY
// dispatched, instead of firing at buildMediaContentBlocks build time. A
// queued entry that gets cancelled before dispatch is simply never read here
// — no upload, no publish, no markRead — which is the fix for the phantom
// journal entries a cancelled queue attachment used to leave behind.

describe('attachPendingMediaMirror / pendingMediaMirror', () => {
  it('attaches and reads back a single payload', () => {
    const blocks = [{ type: 'text', text: 'File saved to /x' }];
    const payload = { buffer: Buffer.from('x'), mime: 'text/plain', name: 'x.txt', dims: undefined };
    expect(pendingMediaMirror(blocks)).toEqual([]);
    expect(attachPendingMediaMirror(blocks, [payload])).toBe(blocks); // returns the same array
    expect(pendingMediaMirror(blocks)).toEqual([payload]);
  });

  it('accepts a bare (non-array) payload for convenience', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    const payload = { buffer: Buffer.from('y'), mime: 'image/png', name: 'y.png' };
    attachPendingMediaMirror(blocks, payload);
    expect(pendingMediaMirror(blocks)).toEqual([payload]);
  });

  it('attaching an empty payload list is a no-op (nothing to read back)', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    attachPendingMediaMirror(blocks, []);
    expect(pendingMediaMirror(blocks)).toEqual([]);
  });

  it('is safe on null/undefined', () => {
    expect(pendingMediaMirror(null)).toEqual([]);
    expect(pendingMediaMirror(undefined)).toEqual([]);
  });

  it('does not leak into JSON.stringify or block iteration (non-enumerable, like markJournalOrigin)', () => {
    const blocks = [{ type: 'text', text: 'hi' }];
    attachPendingMediaMirror(blocks, [{ buffer: Buffer.from('z'), mime: 'text/plain', name: 'z.txt' }]);
    expect(JSON.stringify(blocks)).toBe('[{"type":"text","text":"hi"}]');
    expect(blocks.length).toBe(1);
    expect([...blocks]).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('rides along when the array is pushed into another collection (queuedMessages-style)', () => {
    const blocks = [{ type: 'image', source: 'a' }];
    const payload = { buffer: Buffer.from('a'), mime: 'image/png', name: 'a.png' };
    attachPendingMediaMirror(blocks, [payload]);
    const queuedMessages = [];
    queuedMessages.push(blocks);
    expect(pendingMediaMirror(queuedMessages[0])).toEqual([payload]);
  });
});
