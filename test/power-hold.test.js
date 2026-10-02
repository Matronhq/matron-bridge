import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { keepAwakeMode, powerHoldFlags, createPowerHold, CAFFEINATE } from '../lib/power-hold.js';

describe('keepAwakeMode', () => {
  it('holds for work by default on macOS', () => {
    expect(keepAwakeMode({}, 'darwin')).toBe('work');
    expect(keepAwakeMode({ MATRON_KEEP_AWAKE: '' }, 'darwin')).toBe('work');
    expect(keepAwakeMode({ MATRON_KEEP_AWAKE: 'work' }, 'darwin')).toBe('work');
  });

  it('never sleeps on mains power when asked to', () => {
    expect(keepAwakeMode({ MATRON_KEEP_AWAKE: ' Always ' }, 'darwin')).toBe('always');
  });

  it('can be switched off', () => {
    for (const v of ['off', '0', 'false', 'no', 'never', 'OFF']) {
      expect(keepAwakeMode({ MATRON_KEEP_AWAKE: v }, 'darwin')).toBe('off');
    }
  });

  it('is off wherever the host, not the OS, decides when the box stops', () => {
    expect(keepAwakeMode({ MATRON_KEEP_AWAKE: 'always' }, 'linux')).toBe('off');
    expect(keepAwakeMode({}, 'win32')).toBe('off');
  });
});

describe('powerHoldFlags', () => {
  const now = 1_000_000;

  it('holds nothing when off, whatever is running', () => {
    expect(powerHoldFlags({ mode: 'off', liveSessions: 3, holdUntil: now + 1, now })).toEqual([]);
  });

  it('work: no idle sleep while a session is live', () => {
    expect(powerHoldFlags({ mode: 'work', liveSessions: 1, now })).toEqual(['-i']);
  });

  it('work: lets the Mac sleep once no session is live', () => {
    expect(powerHoldFlags({ mode: 'work', liveSessions: 0, now })).toEqual([]);
  });

  it('work: a pending hold_awake reminder holds with no session live (after a bridge restart)', () => {
    expect(powerHoldFlags({ mode: 'work', liveSessions: 0, holdUntil: now + 60_000, now })).toEqual(['-i']);
    expect(powerHoldFlags({ mode: 'work', liveSessions: 0, holdUntil: now - 1, now })).toEqual([]);
    expect(powerHoldFlags({ mode: 'work', liveSessions: 0, holdUntil: null, now })).toEqual([]);
  });

  it('always: no sleep on mains power even when idle, and no idle sleep on battery while working', () => {
    expect(powerHoldFlags({ mode: 'always', liveSessions: 0, now })).toEqual(['-s']);
    expect(powerHoldFlags({ mode: 'always', liveSessions: 2, now })).toEqual(['-s', '-i']);
  });
});

describe('createPowerHold', () => {
  function fakeSpawn() {
    const children = [];
    const spawn = vi.fn((file, args, opts) => {
      const child = new EventEmitter();
      child.file = file;
      child.args = args;
      child.opts = opts;
      child.kill = vi.fn(() => { child.emit('exit', null, 'SIGTERM'); });
      child.unref = vi.fn();
      children.push(child);
      return child;
    });
    return { spawn, children };
  }

  it('runs caffeinate tied to the bridge pid, so the assertion dies with the bridge', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 4242 });
    expect(hold.set(['-i'])).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].file).toBe(CAFFEINATE);
    expect(children[0].args).toEqual(['-i', '-w', '4242']);
    expect(children[0].opts).toEqual({ stdio: 'ignore' });
    expect(hold.held()).toBe('-i');
  });

  it('does nothing while the wanted flags are already held', () => {
    const { spawn } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-i']);
    expect(hold.set(['-i'])).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('holds nothing, and spawns nothing, for no flags', () => {
    const { spawn } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    expect(hold.set([])).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('releases by killing the child', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-i']);
    expect(hold.set([])).toBe(true);
    expect(children[0].kill).toHaveBeenCalled();
    expect(hold.held()).toBe('');
  });

  it('swaps the child when the flags change', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-s']);
    expect(hold.set(['-s', '-i'])).toBe(true);
    expect(children[0].kill).toHaveBeenCalled();
    expect(children[1].args).toEqual(['-s', '-i', '-w', '1']);
    expect(hold.held()).toBe('-s -i');
  });

  it('starts a new child at the next call when the old one died on its own', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-i']);
    children[0].emit('exit', 1, null);
    expect(hold.held()).toBe('');
    expect(hold.set(['-i'])).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it('a stale child exiting late does not drop the hold its replacement took', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-s']);
    children[0].kill = vi.fn(); // dies later, not on kill()
    hold.set(['-s', '-i']);
    children[0].emit('exit', null, 'SIGTERM');
    expect(hold.held()).toBe('-s -i');
  });

  it('never throws when caffeinate cannot run, and says so once', () => {
    const log = { warn: vi.fn() };
    const spawn = vi.fn(() => { throw new Error('spawn ENOENT'); });
    const hold = createPowerHold({ spawn, pid: 1, log });
    expect(hold.set(['-i'])).toBe(false);
    expect(hold.set(['-i'])).toBe(false);
    expect(hold.held()).toBe('');
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toMatch(/cannot hold the Mac awake: spawn ENOENT/);
  });

  it('an async spawn error drops the hold and is reported once', () => {
    const log = { warn: vi.fn() };
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1, log });
    hold.set(['-i']);
    children[0].emit('error', new Error('EACCES'));
    expect(hold.held()).toBe('');
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('stop() releases', () => {
    const { spawn, children } = fakeSpawn();
    const hold = createPowerHold({ spawn, pid: 1 });
    hold.set(['-s']);
    hold.stop();
    expect(children[0].kill).toHaveBeenCalled();
    expect(hold.held()).toBe('');
  });
});
