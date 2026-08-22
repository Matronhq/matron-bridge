import { describe, it, expect, vi } from 'vitest';
import {
  sleepConfig, sleepButtons, sleepCardText, performSleep,
  DEFAULT_WAKE_HINT, SLEEP_NOT_CONFIGURED,
} from '../lib/sleep-command.js';

describe('sleepConfig', () => {
  it('reports no command when MATRON_SLEEP_COMMAND is unset', () => {
    // The shipped open-source default: /sleep is inert until a deployer
    // opts in, because "poweroff" is only reversible where something else
    // can start the box again.
    expect(sleepConfig({}).command).toBeNull();
  });

  it('treats a whitespace-only command as unset', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: '   ' }).command).toBeNull();
  });

  it('returns the configured command, trimmed', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: ' sudo systemctl poweroff ' }).command)
      .toBe('sudo systemctl poweroff');
  });

  it('falls back to a deployment-neutral wake hint', () => {
    expect(sleepConfig({ MATRON_SLEEP_COMMAND: 'x' }).wakeHint).toBe(DEFAULT_WAKE_HINT);
  });

  it('returns the configured wake hint when set', () => {
    const cfg = sleepConfig({
      MATRON_SLEEP_COMMAND: 'x',
      MATRON_SLEEP_WAKE_HINT: 'message this chat and I will wake up',
    });
    expect(cfg.wakeHint).toBe('message this chat and I will wake up');
  });
});

describe('sleepButtons', () => {
  it('offers confirm and cancel with sleep- ids and sleep: values', () => {
    // The `sleep-` id prefix is what marks the frame non-answerable in
    // lib/journal-input-router.js; the `sleep:` value is what
    // lib/picker-dispatch.js routes. Both halves must line up or a tap
    // silently no-ops.
    const [confirm, cancel] = sleepButtons();
    expect(confirm.id).toBe('sleep-confirm');
    expect(confirm.value).toBe('sleep:confirm');
    expect(cancel.id).toBe('sleep-cancel');
    expect(cancel.value).toBe('sleep:cancel');
  });

  it('labels both buttons', () => {
    for (const b of sleepButtons()) expect(b.label.trim()).not.toBe('');
  });
});

describe('sleepCardText', () => {
  it('names the wake path so the card can say how to undo itself', () => {
    const text = sleepCardText({ wakeHint: 'message this chat', busyCount: 0 });
    expect(text).toContain('message this chat');
  });

  it('warns when sessions are mid-turn', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 2 })).toMatch(/2 sessions/);
  });

  it('warns in the singular for one busy session', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 1 })).toMatch(/1 session\b/);
  });

  it('says nothing about sessions when none are mid-turn', () => {
    expect(sleepCardText({ wakeHint: 'h', busyCount: 0 })).not.toMatch(/session/);
  });
});

describe('performSleep', () => {
  function seams() {
    const calls = [];
    return {
      calls,
      publish: vi.fn(async text => { calls.push(`publish:${text}`); }),
      flush: vi.fn(async () => { calls.push('flush'); }),
      exec: vi.fn(async cmd => { calls.push(`exec:${cmd}`); }),
    };
  }

  it('flushes the journal before executing, so the goodbye survives the shutdown', async () => {
    // The whole point of the ordering: the command kills this process. A
    // goodbye still sitting in the outbound queue is a goodbye nobody sees.
    const s = seams();
    await performSleep({ command: 'poweroff', ...s });
    expect(s.calls).toEqual(['publish:😴 Sleeping now.', 'flush', 'exec:poweroff']);
  });

  it('reports ok when the command was launched', async () => {
    const s = seams();
    expect(await performSleep({ command: 'poweroff', ...s })).toEqual({ ok: true });
  });

  it('refuses without a configured command and never execs', async () => {
    const s = seams();
    const result = await performSleep({ command: null, ...s });
    expect(result.ok).toBe(false);
    expect(s.exec).not.toHaveBeenCalled();
    expect(s.publish).toHaveBeenCalledWith(SLEEP_NOT_CONFIGURED);
  });

  it('tells the user when the sleep command fails, because the box is still awake', async () => {
    // A failed poweroff leaves a live bridge and a user who was told it was
    // going away. Silence here is the worst outcome.
    const s = seams();
    s.exec = vi.fn(async () => { throw new Error('sudo: a password is required'); });
    const result = await performSleep({ command: 'poweroff', ...s });
    expect(result.ok).toBe(false);
    expect(s.publish).toHaveBeenLastCalledWith(
      expect.stringContaining('sudo: a password is required'));
  });

  it('still executes when the flush fails, so a dead socket cannot block sleep', async () => {
    const s = seams();
    s.flush = vi.fn(async () => { throw new Error('socket closed'); });
    const result = await performSleep({ command: 'poweroff', ...s });
    expect(result.ok).toBe(true);
    expect(s.exec).toHaveBeenCalledWith('poweroff');
  });
});
