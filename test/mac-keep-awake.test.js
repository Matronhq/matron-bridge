import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { caffeinateArgs, createMacKeepAwake } from '../lib/mac-keep-awake.js';

function fakeSpawn() {
  const calls = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.killed = false;
    c.kill = () => { c.killed = true; c.emit('exit', null, 'SIGTERM'); };
    calls.push({ cmd, args, child: c });
    return c;
  };
  return { spawn, calls };
}

describe('caffeinateArgs', () => {
  it('blocks idle sleep only, tied to the bridge pid, for the rest of the lease', () => {
    expect(caffeinateArgs({ until: 10_500, now: 1_000, pid: 42 })).toEqual(['-i', '-w', '42', '-t', '10']);
  });

  it('never asks for a zero-second hold', () => {
    expect(caffeinateArgs({ until: 1_000, now: 1_000, pid: 1 })[4]).toBe('1');
  });
});

describe('createMacKeepAwake', () => {
  it('does nothing off macOS', () => {
    const { spawn, calls } = fakeSpawn();
    const k = createMacKeepAwake({ platform: 'linux', spawn, now: () => 0 });
    k.update(60_000);
    expect(calls).toHaveLength(0);
  });

  it('holds caffeinate while the marker is leased, keeps it for the same until, replaces it for a new one', () => {
    const { spawn, calls } = fakeSpawn();
    const k = createMacKeepAwake({ platform: 'darwin', spawn, pid: 7, now: () => 0 });
    k.update(900_000);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('caffeinate');
    expect(calls[0].args).toEqual(['-i', '-w', '7', '-t', '900']);
    k.update(900_000);
    expect(calls).toHaveLength(1);
    k.update(1_200_000);
    expect(calls).toHaveLength(2);
    expect(calls[0].child.killed).toBe(true);
    expect(k.active).toBe(true);
  });

  it('releases when the marker is removed or already past', () => {
    const { spawn, calls } = fakeSpawn();
    const k = createMacKeepAwake({ platform: 'darwin', spawn, now: () => 1_000 });
    k.update(60_000);
    k.update(null);
    expect(calls[0].child.killed).toBe(true);
    expect(k.active).toBe(false);
    k.update(500);
    expect(calls).toHaveLength(1);
  });

  it('forgets a child that exited on its own, so the next update starts a fresh one', () => {
    const { spawn, calls } = fakeSpawn();
    const k = createMacKeepAwake({ platform: 'darwin', spawn, now: () => 0 });
    k.update(60_000);
    calls[0].child.emit('exit', 0, null);
    expect(k.active).toBe(false);
    k.update(60_000);
    expect(calls).toHaveLength(2);
  });

  it('survives a missing caffeinate binary', () => {
    const { spawn, calls } = fakeSpawn();
    const logs = [];
    const k = createMacKeepAwake({ platform: 'darwin', spawn, now: () => 0, log: (m) => logs.push(m) });
    k.update(60_000);
    calls[0].child.emit('error', new Error('ENOENT'));
    expect(k.active).toBe(false);
    expect(logs[0]).toMatch(/caffeinate failed/);
  });
});

describe('index.js wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('the single keep-awake writer drives caffeinate with the marker\'s until, on every path', () => {
    const start = index.indexOf('function writeKeepAwake(');
    const body = index.slice(start, index.indexOf('\nfunction ', start + 1));
    expect(body).toMatch(/macKeepAwake\.update\(until\)/);
    expect(body.indexOf('macKeepAwake.update(until)')).toBeLessThan(body.indexOf('if (!until)'));
  });
});
