import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { createTransferReceiver } from '../lib/transfer-receiver.js';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const silent = { log() {}, warn() {}, error() {} };
const noSleep = vi.fn(async () => {});
const readState = (f) => JSON.parse(readFileSync(f, 'utf-8'));

const CONTENT = Buffer.from('hello from box-a, this is the build log\n');

function transferOf(extra = {}) {
  return {
    id: 'tr-1', room_id: 'room-1', name: 'build.log', size: CONTENT.length, sha256: sha(CONTENT),
    content_type: 'text/plain', from_name: 'box-a', from_convo_id: 'convo-owner', ...extra,
  };
}

// A journal that serves `bytes` for every transfer id, honouring Range the
// way /transfers/:id/content does (206 for bytes=a-, 416 past the end).
function fakeClient({ bytes = CONTENT, pending = [], download } = {}) {
  const serve = async (id, { start = 0 } = {}) => {
    if (start >= bytes.length && start > 0) {
      return new Response(null, { status: 416, headers: { 'content-range': `bytes */${bytes.length}` } });
    }
    if (start > 0) {
      return new Response(bytes.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } });
    }
    return new Response(bytes, { status: 200 });
  };
  return {
    download: vi.fn(download || serve),
    received: vi.fn(async () => ({ ok: true, status: 200, body: { phase: 'delivered' } })),
    listPending: vi.fn(async () => ({ ok: true, status: 200, body: { transfers: pending } })),
  };
}

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'transfer-receiver-'));
  const workdir = path.join(root, 'repo');
  mkdirSync(workdir);
  const owner = { roomId: '!owner', workdir, journalConvoId: 'convo-owner' };
  const guest = { roomId: '!guest', workdir, journalConvoId: 'convo-guest' };
  const dirFor = (s) => path.join(root, 'files', s.roomId, 'inbox');
  return { root, workdir, owner, guest, dirFor, stateFile: path.join(root, 'inbox-state.json') };
}

function makeReceiver(fx, { client = fakeClient(), sessions, muted = () => false, deliver = vi.fn() } = {}) {
  const all = sessions || [fx.owner, fx.guest];
  const sessionsForRoom = vi.fn((roomId, fromConvoId) => all.filter((s) => s.journalConvoId !== fromConvoId));
  const receiver = createTransferReceiver({
    client, dirFor: fx.dirFor, deliver, sessionsForRoom, isMuted: (roomId, s) => muted(s),
    stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep: noSleep,
  });
  return { receiver, client, deliver, sessionsForRoom };
}

describe('transfer receiver', () => {
  it('a ready frame downloads, verifies, saves outside the workdir, confirms and tells only the session that did not send', async () => {
    const fx = fixture();
    const { receiver, client, deliver, sessionsForRoom } = makeReceiver(fx);
    receiver.onReady(transferOf());
    expect(receiver.active()).toBe(1);
    await receiver.idle();
    expect(receiver.active()).toBe(0);

    expect(sessionsForRoom).toHaveBeenCalledWith('room-1', 'convo-owner');
    const saved = path.join(fx.dirFor(fx.guest), 'build.log');
    expect(readFileSync(saved)).toEqual(CONTENT);
    expect(saved.startsWith(fx.workdir + path.sep)).toBe(false);
    expect(readdirSync(fx.dirFor(fx.guest))).toEqual(['build.log']); // no .part left behind
    expect(client.download).toHaveBeenCalledWith('tr-1', expect.objectContaining({ start: 0 }));
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));

    // Same-bridge room: the owner session sent it, so only the guest hears.
    expect(deliver).toHaveBeenCalledTimes(1);
    const [who, line, meta] = deliver.mock.calls[0];
    expect(who).toBe(fx.guest);
    expect(line).toBe(`[sent file "build.log" — saved to ${saved} (${CONTENT.length} B, sha256 ${sha(CONTENT).slice(0, 12)}…)]`);
    expect(meta).toEqual(expect.objectContaining({ roomId: 'room-1', fromName: 'box-a' }));

    // Recorded for the inbox sweep; nothing left pending.
    const state = readState(fx.stateFile);
    expect(state.arrived).toEqual([{ path: saved, arrivedAt: 1_000, transferId: 'tr-1' }]);
    expect(state.pending).toEqual({});
  });

  it('adds the sender\'s caption when the transfer carries one', async () => {
    const fx = fixture();
    const { receiver, deliver } = makeReceiver(fx);
    receiver.onReady(transferOf({ reason: 'the failing run' }));
    await receiver.idle();
    expect(deliver.mock.calls[0][1]).toMatch(/…\)\]: the failing run$/);
  });

  it('does not overwrite an earlier file of the same name: -1, -2', async () => {
    const fx = fixture();
    mkdirSync(fx.dirFor(fx.guest), { recursive: true });
    writeFileSync(path.join(fx.dirFor(fx.guest), 'build.log'), 'older');
    writeFileSync(path.join(fx.dirFor(fx.guest), 'build-1.log'), 'older still');
    const { receiver, deliver } = makeReceiver(fx);
    receiver.onReady(transferOf());
    await receiver.idle();
    const saved = path.join(fx.dirFor(fx.guest), 'build-2.log');
    expect(readFileSync(saved)).toEqual(CONTENT);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'), 'utf-8')).toBe('older');
    expect(deliver.mock.calls[0][1]).toContain(`saved to ${saved} `);
  });

  it('a pre-existing .part resumes with Range from its length', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const { receiver, client } = makeReceiver(fx);
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT.subarray(0, 10));
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(client.download.mock.calls[0][1].start).toBe(10);
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
  });

  it('a .part that is already whole: the 416 counts as done, and it goes on to verify', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const { receiver, client, deliver } = makeReceiver(fx);
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT);
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download.mock.calls[0][1].start).toBe(CONTENT.length);
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a 200 to a Range request starts the .part over rather than appending', async () => {
    const fx = fixture();
    const dir = fx.dirFor(fx.guest);
    mkdirSync(dir, { recursive: true });
    const client = fakeClient({ download: async () => new Response(CONTENT, { status: 200 }) });
    const { receiver } = makeReceiver(fx, { client });
    writeFileSync(receiver.partPathFor(dir, transferOf()), CONTENT.subarray(0, 10));
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(dir, 'build.log'))).toEqual(CONTENT);
  });

  it('a sha mismatch retries once from zero, then reports failure and leaves no file', async () => {
    const fx = fixture();
    const client = fakeClient({ bytes: Buffer.alloc(CONTENT.length, 'z') });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(2);
    expect(client.download.mock.calls.map((c) => c[1].start)).toEqual([0, 0]);
    expect(client.received).not.toHaveBeenCalled();
    const dir = fx.dirFor(fx.guest);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(fx.guest);
    expect(deliver.mock.calls[0][1]).toBe('[file "build.log" failed verification and was not saved]');
    expect(readState(fx.stateFile).pending).toEqual({});
  });

  it('a mismatch that clears on the retry saves the file', async () => {
    const fx = fixture();
    let n = 0;
    const client = fakeClient({ download: async () => new Response(n++ === 0 ? Buffer.alloc(CONTENT.length, 'x') : CONTENT, { status: 200 }) });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(deliver.mock.calls[0][1]).toMatch(/^\[sent file "build.log"/);
  });

  it('a transient failure retries with backoff, resuming from the .part', async () => {
    const fx = fixture();
    let calls = 0;
    const client = fakeClient({
      download: async (id, { start = 0 } = {}) => {
        calls += 1;
        if (calls === 1) throw new Error('socket hang up');
        if (calls === 2) {
          // Half the body, then the stream dies.
          const half = CONTENT.subarray(0, 12);
          let sent = false;
          const body = new ReadableStream({ pull(c) { if (sent) { c.error(new Error('reset')); return; } sent = true; c.enqueue(half); } });
          return new Response(body, { status: 200 });
        }
        return new Response(CONTENT.subarray(start), { status: 206, headers: { 'content-range': `bytes ${start}-${CONTENT.length - 1}/${CONTENT.length}` } });
      },
    });
    const sleep = vi.fn(async () => {});
    const receiver = createTransferReceiver({
      client, dirFor: fx.dirFor, deliver: vi.fn(), sessionsForRoom: () => [fx.guest],
      stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep,
    });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 8000]);
    expect(client.download.mock.calls[2][1].start).toBe(12);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
  });

  it('after the retries it keeps the .part and the pending entry for catchUp', async () => {
    const fx = fixture();
    const client = fakeClient({ download: async () => new Response(null, { status: 503 }) });
    const sleep = vi.fn(async () => {});
    const deliver = vi.fn();
    const receiver = createTransferReceiver({
      client, dirFor: fx.dirFor, deliver, sessionsForRoom: () => [fx.guest],
      stateFile: fx.stateFile, log: silent, now: () => 1_000, sleep,
    });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([2000, 8000, 30000]);
    expect(deliver).not.toHaveBeenCalled();
    expect(Object.keys(readState(fx.stateFile).pending)).toEqual(['tr-1']);
  });

  it('catchUp downloads a released transfer missed while asleep', async () => {
    const fx = fixture();
    const client = fakeClient({ pending: [transferOf()] });
    const { receiver, deliver } = makeReceiver(fx, { client });
    await receiver.catchUp();
    await receiver.idle();
    expect(client.listPending).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('catchUp after a restart picks up a download left pending in the state file', async () => {
    const fx = fixture();
    writeFileSync(fx.stateFile, JSON.stringify({ pending: { 'tr-1': { transfer: transferOf() } }, arrived: [] }));
    const client = fakeClient({ pending: [] });
    client.listPending = vi.fn(async () => ({ ok: false, status: 0, body: { error: 'journal unreachable' } }));
    const { receiver } = makeReceiver(fx, { client });
    await receiver.catchUp();
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
  });

  it('a ready frame and catchUp for the same transfer download it once', async () => {
    const fx = fixture();
    const client = fakeClient({ pending: [transferOf()] });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.catchUp();
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a muted binding gets no line, but the file is still saved and confirmed', async () => {
    const fx = fixture();
    const { receiver, client, deliver } = makeReceiver(fx, { muted: (s) => s === fx.guest });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'build.log'))).toEqual(CONTENT);
    expect(client.received).toHaveBeenCalledWith('tr-1', sha(CONTENT));
    expect(deliver).not.toHaveBeenCalled();
  });

  it('a second bound session gets its own copy (a hard link) in its own inbox', async () => {
    const fx = fixture();
    const third = { roomId: '!third', workdir: fx.workdir, journalConvoId: 'convo-third' };
    const { receiver, deliver } = makeReceiver(fx, { sessions: [fx.owner, fx.guest, third] });
    receiver.onReady(transferOf());
    await receiver.idle();
    const a = path.join(fx.dirFor(fx.guest), 'build.log');
    const b = path.join(fx.dirFor(third), 'build.log');
    expect(readFileSync(b)).toEqual(CONTENT);
    expect(deliver.mock.calls.map((c) => c[0])).toEqual([fx.guest, third]);
    expect(deliver.mock.calls[1][1]).toContain(`saved to ${b} `);
    expect(readState(fx.stateFile).arrived.map((r) => r.path)).toEqual([a, b]);
  });

  it('a name with path parts is saved under its base name only', async () => {
    const fx = fixture();
    const { receiver } = makeReceiver(fx);
    receiver.onReady(transferOf({ name: '../../escape.log' }));
    await receiver.idle();
    expect(readFileSync(path.join(fx.dirFor(fx.guest), 'escape.log'))).toEqual(CONTENT);
  });

  it('a 404 (no longer downloadable) drops the transfer quietly', async () => {
    const fx = fixture();
    const client = fakeClient({ download: async () => new Response(null, { status: 404 }) });
    const { receiver, deliver } = makeReceiver(fx, { client });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).toHaveBeenCalledTimes(1);
    expect(deliver).not.toHaveBeenCalled();
    expect(readState(fx.stateFile).pending).toEqual({});
  });

  it('no session to receive it: nothing is downloaded', async () => {
    const fx = fixture();
    const { receiver, client } = makeReceiver(fx, { sessions: [fx.owner] });
    receiver.onReady(transferOf());
    await receiver.idle();
    expect(client.download).not.toHaveBeenCalled();
  });

  it('ignores a malformed transfer', async () => {
    const fx = fixture();
    const { receiver, client } = makeReceiver(fx);
    receiver.onReady({ id: 'tr-1' });
    receiver.onReady(null);
    receiver.onReady(transferOf({ sha256: 'nothex' }));
    await receiver.idle();
    expect(client.download).not.toHaveBeenCalled();
  });
});
