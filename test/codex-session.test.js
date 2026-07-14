import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CodexExecSession,
  buildCodexExecArgs,
  contentBlocksToCodexPrompt,
  normalizeCodexSandbox,
} from '../lib/codex-session.js';

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true);
  return child;
}

describe('Codex programmatic session', () => {
  it('builds initial and resume argv with explicit non-interactive safety settings', () => {
    expect(buildCodexExecArgs({ sandbox: 'workspace-write', model: 'gpt-test' })).toEqual([
      'exec', '--json', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="workspace-write"',
      '--model', 'gpt-test', '-',
    ]);
    expect(buildCodexExecArgs({ threadId: 'thread-1' })).toEqual([
      'exec', 'resume', '--json', '--skip-git-repo-check',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="workspace-write"',
      'thread-1', '-',
    ]);
  });

  it('falls back to workspace-write for an invalid sandbox', () => {
    expect(normalizeCodexSandbox('root-everything')).toBe('workspace-write');
  });

  it('turns only text blocks into the stdin prompt', () => {
    expect(contentBlocksToCodexPrompt([
      { type: 'text', text: 'Image saved to /tmp/a.png' },
      { type: 'image', source: { data: 'base64' } },
      { type: 'text', text: 'describe it' },
    ])).toBe('Image saved to /tmp/a.png\n\ndescribe it');
  });

  it('streams JSONL events, captures the thread id, and resumes on the next turn', async () => {
    const firstChild = fakeChild();
    const secondChild = fakeChild();
    const children = [firstChild, secondChild];
    const spawnImpl = vi.fn(() => children.shift());
    const session = new CodexExecSession({ cwd: '/repo', spawnImpl });
    const events = [];
    session.on('event', event => events.push(event));

    let firstPrompt = '';
    firstChild.stdin.on('data', chunk => { firstPrompt += chunk; });
    expect(session.send([{ type: 'text', text: 'first turn' }])).toBe(true);
    firstChild.stdout.write('{"type":"thread.started","thread_id":"abc-123"}\n');
    firstChild.stdout.write('{"type":"turn.completed","usage":{"input_tokens":2}}\n');
    firstChild.emit('close', 0, null);
    await new Promise(resolve => setImmediate(resolve));

    expect(firstPrompt).toBe('first turn');
    expect(session.threadId).toBe('abc-123');
    expect(events.map(event => event.type)).toEqual(['thread.started', 'turn.completed']);

    expect(session.send([{ type: 'text', text: 'second turn' }])).toBe(true);
    expect(spawnImpl.mock.calls[1][1]).toContain('resume');
    expect(spawnImpl.mock.calls[1][1]).toContain('abc-123');
  });

  it('refuses concurrent turns and interrupts the active child', () => {
    const child = fakeChild();
    const session = new CodexExecSession({ cwd: '/repo', spawnImpl: () => child });
    expect(session.send([{ type: 'text', text: 'go' }])).toBe(true);
    expect(session.send([{ type: 'text', text: 'too soon' }])).toBe(false);
    expect(session.interrupt()).toBe(true);
    expect(child.kill).toHaveBeenCalledWith('SIGINT');
  });
});
