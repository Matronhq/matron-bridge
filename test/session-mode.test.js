import { describe, it, expect } from 'vitest';
import {
  resolveInteractive,
  resolveModel,
  normalizeModeArg,
  modeLabel,
  modeButtons,
  planModeSwitch,
} from '../lib/session-mode.js';

describe('resolveInteractive', () => {
  it('prefers an explicit boolean option over everything', () => {
    expect(resolveInteractive({ option: true, persisted: false, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: false, persisted: true, fallback: true })).toBe(false);
  });
  it('falls back to the persisted value when no option', () => {
    expect(resolveInteractive({ option: undefined, persisted: true, fallback: false })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: false, fallback: true })).toBe(false);
  });
  it('falls back to the global default when neither is set', () => {
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: true })).toBe(true);
    expect(resolveInteractive({ option: undefined, persisted: undefined, fallback: false })).toBe(false);
  });
});

describe('resolveModel', () => {
  it('prefers the explicit option, then persisted, then undefined', () => {
    expect(resolveModel({ option: 'sonnet', persisted: 'opus' })).toBe('sonnet');
    expect(resolveModel({ option: undefined, persisted: 'opus' })).toBe('opus');
    expect(resolveModel({ option: undefined, persisted: undefined })).toBeUndefined();
  });
});

describe('normalizeModeArg', () => {
  it('maps interactive aliases', () => {
    for (const a of ['interactive', 'iv', 'tui', 'INTERACTIVE', ' iv ']) {
      expect(normalizeModeArg(a)).toBe('interactive');
    }
  });
  it('maps print aliases', () => {
    for (const a of ['print', 'noniv', 'non-interactive', 'p']) {
      expect(normalizeModeArg(a)).toBe('print');
    }
  });
  it('returns null for anything else', () => {
    expect(normalizeModeArg('banana')).toBeNull();
    expect(normalizeModeArg('')).toBeNull();
    expect(normalizeModeArg(undefined)).toBeNull();
  });
});

describe('modeLabel', () => {
  it('labels both modes', () => {
    expect(modeLabel(true)).toBe('interactive');
    expect(modeLabel(false)).toBe('non-interactive');
  });
});

describe('modeButtons', () => {
  it('offers a single button that flips to the other mode', () => {
    expect(modeButtons(false)).toEqual([
      { id: 'mode-interactive', label: 'Switch to interactive', value: 'mode:interactive' },
    ]);
    expect(modeButtons(true)).toEqual([
      { id: 'mode-print', label: 'Switch to non-interactive', value: 'mode:print' },
    ]);
  });
});

describe('planModeSwitch', () => {
  it('no-ops when already in the requested mode', () => {
    const d = planModeSwitch({ iv: { alive: true } }, true);
    expect(d.ok).toBe(false);
    expect(d.noop).toBe(true);
    expect(d.message).toMatch(/already/i);
  });
  it('refuses while the session is busy', () => {
    const d = planModeSwitch({ iv: null, busy: true }, true);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/turn/i);
  });
  it('refuses interactive->print while a TUI prompt is pending', () => {
    const d = planModeSwitch({ iv: { alive: true }, pendingInteractivePrompt: {} }, false);
    expect(d.ok).toBe(false);
    expect(d.message).toMatch(/question/i);
  });
  it('approves a clean switch', () => {
    const d = planModeSwitch({ iv: null, busy: false }, true);
    expect(d.ok).toBe(true);
    expect(d.message).toMatch(/interactive/i);
  });
});
