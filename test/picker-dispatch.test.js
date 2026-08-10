import { describe, it, expect, vi } from 'vitest';
import { handlePickerValue } from '../lib/picker-dispatch.js';

describe('handlePickerValue', () => {
  function seams() {
    return {
      applyModelSwitch: vi.fn(),
      switchEffortInSession: vi.fn(),
      applyModeSwitch: vi.fn(),
      cancelTimer: vi.fn(),
      sendTimerNow: vi.fn(),
      sendReply: vi.fn(),
      sendHtml: vi.fn(),
    };
  }

  it('dispatches model:<alias> to applyModelSwitch(roomId, session, alias, ctx)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('model:sonnet', 'room-1', session, s)).toBe(true);
    expect(s.applyModelSwitch).toHaveBeenCalledWith('room-1', session, 'sonnet', {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
    expect(s.switchEffortInSession).not.toHaveBeenCalled();
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
  });

  it('dispatches effort:<level> to switchEffortInSession(session, level, sendReply)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('effort:high', 'room-1', session, s)).toBe(true);
    expect(s.switchEffortInSession).toHaveBeenCalledWith(session, 'high', s.sendReply);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
  });

  it('dispatches mode:interactive to applyModeSwitch(...true...) and mode:print to (...false...)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('mode:interactive', 'room-1', session, s)).toBe(true);
    expect(s.applyModeSwitch).toHaveBeenCalledWith('room-1', session, true, {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
    s.applyModeSwitch.mockClear();
    expect(handlePickerValue('mode:print', 'room-1', session, s)).toBe(true);
    expect(s.applyModeSwitch).toHaveBeenCalledWith('room-1', session, false, {
      sendReply: s.sendReply, sendHtml: s.sendHtml,
    });
  });

  it('dispatches timer:cancel:<id> to cancelTimer(session, numericId, sendReply)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('timer:cancel:12', 'room-1', session, s)).toBe(true);
    // The id arrives parsed to a number — timerStore.cancel matches by ===.
    expect(s.cancelTimer).toHaveBeenCalledWith(session, 12, s.sendReply);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
  });

  it('dispatches timer:send:<id> to sendTimerNow(session, numericId, sendReply)', () => {
    const s = seams();
    const session = { id: 'sess' };
    expect(handlePickerValue('timer:send:7', 'room-1', session, s)).toBe(true);
    expect(s.sendTimerNow).toHaveBeenCalledWith(session, 7, s.sendReply);
    expect(s.cancelTimer).not.toHaveBeenCalled();
  });

  it('returns false for malformed timer values (bad verb, non-numeric or missing id)', () => {
    const s = seams();
    expect(handlePickerValue('timer:cancel:abc', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('timer:cancel:', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('timer:cancel', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('timer:snooze:3', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('timer:send:abc', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('timer:send:', 'room-1', {}, s)).toBe(false);
    expect(s.cancelTimer).not.toHaveBeenCalled();
    expect(s.sendTimerNow).not.toHaveBeenCalled();
  });

  it('returns false and dispatches nothing for a non-picker value', () => {
    const s = seams();
    expect(handlePickerValue('interrupt', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('prompt-opt:1', 'room-1', {}, s)).toBe(false);
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
    expect(s.switchEffortInSession).not.toHaveBeenCalled();
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
  });

  it('returns false and dispatches nothing for a namespaced-but-invalid value', () => {
    const s = seams();
    // Major 1: mode:bogus must NOT fall through to a print-mode switch.
    expect(handlePickerValue('mode:bogus', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('model:bogus', 'room-1', {}, s)).toBe(false);
    expect(handlePickerValue('effort:bogus', 'room-1', {}, s)).toBe(false);
    expect(s.applyModeSwitch).not.toHaveBeenCalled();
    expect(s.applyModelSwitch).not.toHaveBeenCalled();
    expect(s.switchEffortInSession).not.toHaveBeenCalled();
  });
});

describe('perm: dispatch', () => {
  const UUID = '01234567-89ab-cdef-0123-456789abcdef';

  it('dispatches a valid perm tap to answerPermission', () => {
    const answerPermission = vi.fn();
    const sendReply = vi.fn();
    const session = {};
    const handled = handlePickerValue(`perm:${UUID}:always`, 'room-1', session, {
      answerPermission, sendReply,
    });
    expect(handled).toBe(true);
    expect(answerPermission).toHaveBeenCalledWith(session, UUID, 'always', sendReply);
  });

  it('rejects malformed perm values', () => {
    const answerPermission = vi.fn();
    expect(handlePickerValue('perm:nope:allow', 'r', {}, { answerPermission })).toBe(false);
    expect(handlePickerValue(`perm:${UUID}:sudo`, 'r', {}, { answerPermission })).toBe(false);
    expect(answerPermission).not.toHaveBeenCalled();
  });
});
