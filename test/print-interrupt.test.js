import { describe, it, expect, vi } from 'vitest';
import { buildInterruptRequest, sendPrintInterrupt, INTERRUPT_FALLBACK_MS } from '../lib/print-interrupt.js';

describe('buildInterruptRequest', () => {
  it('builds the control_request shape with a uuid request_id', () => {
    const req = buildInterruptRequest();
    expect(req.type).toBe('control_request');
    expect(req.request).toEqual({ subtype: 'interrupt' });
    expect(req.request_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('uses an explicit requestId when given', () => {
    expect(buildInterruptRequest('fixed-id').request_id).toBe('fixed-id');
  });

  it('generates a fresh request_id per call', () => {
    expect(buildInterruptRequest().request_id).not.toBe(buildInterruptRequest().request_id);
  });
});

describe('sendPrintInterrupt', () => {
  const collect = () => {
    const writes = [];
    return { writes, stdin: { write: (s) => { writes.push(s); return true; } } };
  };

  it('writes one newline-terminated control_request line', () => {
    const { writes, stdin } = collect();
    const handle = sendPrintInterrupt({ stdin, onWedge: () => {}, onError: () => {} });
    expect(writes).toHaveLength(1);
    expect(writes[0].endsWith('\n')).toBe(true);
    const parsed = JSON.parse(writes[0]);
    expect(parsed).toEqual({
      type: 'control_request',
      request_id: handle.requestId,
      request: { subtype: 'interrupt' },
    });
  });

  it('fires onWedge after timeoutMs', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      vi.advanceTimersByTime(4999);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults the timeout to INTERRUPT_FALLBACK_MS (10s)', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      sendPrintInterrupt({ stdin, onWedge, onError: () => {} });
      vi.advanceTimersByTime(INTERRUPT_FALLBACK_MS - 1);
      expect(onWedge).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onWedge).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel() prevents onWedge from firing', () => {
    vi.useFakeTimers();
    try {
      const { stdin } = collect();
      const onWedge = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError: () => {}, timeoutMs: 5000 });
      handle.cancel();
      vi.advanceTimersByTime(10000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a write failure via onError, returns null, arms no timer', () => {
    vi.useFakeTimers();
    try {
      const boom = new Error('EPIPE');
      const stdin = { write: () => { throw boom; } };
      const onWedge = vi.fn();
      const onError = vi.fn();
      const handle = sendPrintInterrupt({ stdin, onWedge, onError, timeoutMs: 5000 });
      expect(handle).toBeNull();
      expect(onError).toHaveBeenCalledWith(boom);
      vi.advanceTimersByTime(60000);
      expect(onWedge).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never throws when onError is omitted', () => {
    const stdin = { write: () => { throw new Error('EPIPE'); } };
    expect(sendPrintInterrupt({ stdin, onWedge: () => {} })).toBeNull();
  });
});
