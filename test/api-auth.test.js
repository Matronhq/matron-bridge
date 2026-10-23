import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApiAuth, apiAuthRefusal, viewerApiKey, isViewerRoute } from '../lib/api-auth.js';
import { readApiHeaderFile } from '../lib/api-header-file.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'api-auth-'));

describe('createApiAuth', () => {
  it('writes one owner-only header file per session and keeps the token for the life of the process', () => {
    const dir = tmp();
    try {
      const auth = createApiAuth({ dir });
      const file = auth.ensure('room-a');
      expect(auth.ensure('room-a')).toBe(file);
      expect(auth.ensure('room-b')).not.toBe(file);
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
      const headers = readApiHeaderFile(file);
      expect(headers['X-Matron-Session-Token']).toBe(auth.tokenFor('room-a'));
      expect(auth.caller({ 'x-matron-session-token': auth.tokenFor('room-a') })).toEqual({ kind: 'session', roomId: 'room-a' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('knows nobody without a valid token or key', () => {
    const auth = createApiAuth({ viewerKey: viewerApiKey('s3cret') });
    auth.ensure('room-a');
    expect(auth.caller({})).toBe(null);
    expect(auth.caller({ 'x-matron-session-token': 'nope' })).toBe(null);
    expect(auth.caller({ 'x-matron-viewer-key': viewerApiKey('other') })).toBe(null);
    expect(auth.caller({ 'x-matron-viewer-key': viewerApiKey('s3cret') })).toEqual({ kind: 'viewer' });
  });

  it('has no viewer key without an HMAC secret', () => {
    expect(viewerApiKey('')).toBe(null);
    const auth = createApiAuth({ viewerKey: viewerApiKey('') });
    expect(auth.caller({ 'x-matron-viewer-key': '' })).toBe(null);
  });
});

describe('apiAuthRefusal', () => {
  const a = { kind: 'session', roomId: 'room-a' };
  it('refuses a request with no credential', () => {
    expect(apiAuthRefusal({ caller: null, method: 'POST', pathname: '/send', namedRoomId: 'room-a' }).status).toBe(401);
  });
  it('lets a session act for itself, or on a route that names no session', () => {
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/send', namedRoomId: 'room-a' })).toBe(null);
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/sessions', namedRoomId: null })).toBe(null);
  });
  it('refuses a session acting as another', () => {
    expect(apiAuthRefusal({ caller: a, method: 'POST', pathname: '/consent/decide', namedRoomId: 'room-coord' }).status).toBe(403);
  });
  it('lets the viewer in only on its own routes', () => {
    const v = { kind: 'viewer' };
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/interrupt', namedRoomId: 'room-a' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/secret/abc/submit' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'GET', pathname: '/sensitive/abc' })).toBe(null);
    expect(apiAuthRefusal({ caller: v, method: 'POST', pathname: '/send', namedRoomId: 'room-a' }).status).toBe(403);
    expect(isViewerRoute('GET', '/interrupt')).toBe(false);
  });
});

describe('readApiHeaderFile', () => {
  it('returns {} for a missing, empty or malformed file', () => {
    const dir = tmp();
    try {
      expect(readApiHeaderFile('')).toEqual({});
      expect(readApiHeaderFile(path.join(dir, 'missing'))).toEqual({});
      fs.writeFileSync(path.join(dir, 'bad'), 'not a header');
      expect(readApiHeaderFile(path.join(dir, 'bad'))).toEqual({});
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
