import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
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

  it('exposes a synchronous spawn failure before returning false', async () => {
    const error = new Error('spawn codex ENOENT');
    const session = new CodexExecSession({
      cwd: '/repo',
      spawnImpl: () => { throw error; },
    });
    const onSpawnError = vi.fn();
    session.on('spawn-error', onSpawnError);

    expect(session.send([{ type: 'text', text: 'go' }])).toBe(false);
    expect(session.lastError).toBe(error);

    await Promise.resolve();
    expect(onSpawnError).toHaveBeenCalledWith(error);
  });
});

describe('Codex bridge wiring', () => {
  const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('reports rejected dispatches as failures and gates downstream work', () => {
    const start = src.indexOf('function sendToSession(');
    const end = src.indexOf('\nfunction sendTextToSession(', start);
    const body = src.slice(start, end);

    expect(body).toMatch(
      /session\.agent === AGENT_CODEX[\s\S]*return reportSessionSendFailure\([\s\S]*const sent = session\.codex\?\.send/,
    );
    expect(body).toMatch(/if \(sent\) \{[\s\S]*commitDispatchedUserTurn/);
    expect(body).toMatch(/if \(!sent\) \{[\s\S]*return reportSessionSendFailure/);

    const reportStart = src.indexOf('function reportSessionSendFailure(');
    const reportEnd = src.indexOf('\nfunction flushResponse(', reportStart);
    const reporter = src.slice(reportStart, reportEnd);
    expect(reporter).toMatch(/session\.sendHtml[\s\S]*session\.sendCallback/);
    expect(reporter).toContain('return false');
    expect(reporter).not.toContain('_sendFailureReported');
  });

  it('refreshes the persisted native thread ID without replacing a stable journal ID', () => {
    const start = src.indexOf('function handleCodexEvent(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);

    expect(body).toContain('session.claudeSessionId !== event.thread_id');
    expect(body).toContain('session.claudeSessionId = event.thread_id');
    expect(body).toContain('if (!session.journalConvoId) session.journalConvoId = event.thread_id');
    expect(body).toContain('persistSession(session.roomId, event.thread_id');
  });

  it('rejects media-only interactive turns before buffering or applying a handoff', () => {
    const start = src.indexOf('function sendToSession(');
    const end = src.indexOf('\nfunction sendTextToSession(', start);
    const body = src.slice(start, end);
    const validation = body.indexOf('if (session.iv && !historyText)');
    const resumeHold = body.indexOf('if (session._awaitingInputReady)');
    const handoff = body.indexOf('applyPendingAgentHandoff(session, contentBlocks)');

    expect(validation).toBeGreaterThan(-1);
    expect(validation).toBeLessThan(resumeHold);
    expect(validation).toBeLessThan(handoff);
    expect(body.slice(validation, resumeHold)).toContain('return reportSessionSendFailure');
  });

  it('finishes killed Codex turns without flushing partial output or queued work', () => {
    const exitStart = src.indexOf("codex.on('turn-exit'");
    const exitEnd = src.indexOf('\n  });', exitStart) + 6;
    const exitBody = src.slice(exitStart, exitEnd);
    expect(exitBody).not.toContain('!session.alive || session._codexTurnFinished');
    expect(exitBody).toContain('discardOutput: true');

    const killStart = src.indexOf('function killSession(');
    const killEnd = src.indexOf('\nfunction ', killStart + 1);
    const killBody = src.slice(killStart, killEnd);
    expect(killBody).toContain('finishCodexTurn(session');
    expect(killBody).toContain('preserveQueue');
    expect(killBody.indexOf('finishCodexTurn(session')).toBeLessThan(killBody.indexOf('session.codex.kill(signal)'));

    const recreateStart = src.indexOf('function recreateSession(');
    const recreateEnd = src.indexOf('\nfunction ', recreateStart + 1);
    const recreateBody = src.slice(recreateStart, recreateEnd);
    expect(recreateBody).toContain("killSession(existing, 'SIGTERM', { preserveQueue: true })");
    expect(recreateBody).toContain('flushPendingSessionQueue(next)');
  });

  it('keeps Codex model defaults provider-local across recreation', () => {
    const createStart = src.indexOf('function createCodexSessionForRoom(');
    const createEnd = src.indexOf('\nfunction ', createStart + 1);
    const createBody = src.slice(createStart, createEnd);
    expect(createBody).toContain('getPersistedAgentState(persisted, AGENT_CODEX');
    expect(createBody).toContain('persistedCodexState.model');
    expect(createBody).not.toContain('persisted?.model');

    const recreateStart = src.indexOf('function recreateSession(');
    const recreateEnd = src.indexOf('\nfunction ', recreateStart + 1);
    const recreateBody = src.slice(recreateStart, recreateEnd);
    expect(recreateBody).toMatch(
      /model: existing\.agent === AGENT_CODEX[\s\S]*\? existing\.currentModel[\s\S]*: \(existing\.currentModel \|\| undefined\)/,
    );
  });

  it('does not overwrite an established same-provider ID with a pre-init null', () => {
    const start = src.indexOf('function persistSession(');
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end);

    expect(body).toContain('resolveNativeSessionIdForPersistence');
    expect(body).toContain('state = { ...state, sessionId: effectiveSessionId }');
    expect(body).toContain('sessionId: effectiveSessionId');
  });
});
