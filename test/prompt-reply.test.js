import { describe, it, expect } from 'vitest';
import { parseOptionReply } from '../lib/prompt-reply.js';

describe('parseOptionReply', () => {
  it('parses a bare number', () => {
    expect(parseOptionReply('1')).toEqual({ token: '1', extra: '' });
    expect(parseOptionReply('  3 ')).toEqual({ token: '3', extra: '' });
    expect(parseOptionReply('12')).toEqual({ token: '12', extra: '' });
  });

  it('parses a number with trailing separator punctuation', () => {
    expect(parseOptionReply('1.')).toEqual({ token: '1', extra: '' });
    expect(parseOptionReply('2)')).toEqual({ token: '2', extra: '' });
  });

  it('parses a single letter (lettered menus)', () => {
    expect(parseOptionReply('a')).toEqual({ token: 'a', extra: '' });
    expect(parseOptionReply('B.')).toEqual({ token: 'B', extra: '' });
  });

  // The core Bug #82 case: number + an appended remark must NOT drop the remark.
  it('splits a number and an appended remark', () => {
    expect(parseOptionReply('1. also i was thinking we use compiled css in the editor too'))
      .toEqual({ token: '1', extra: 'also i was thinking we use compiled css in the editor too' });
  });

  it('splits a number and remark with no separator dot', () => {
    expect(parseOptionReply('1 also use compiled css'))
      .toEqual({ token: '1', extra: 'also use compiled css' });
  });

  it('splits a lettered selection and a remark', () => {
    expect(parseOptionReply("a. let's do it but keep the diff small"))
      .toEqual({ token: 'a', extra: "let's do it but keep the diff small" });
  });

  it('preserves a multi-line remark verbatim', () => {
    expect(parseOptionReply('1. first line\nsecond line'))
      .toEqual({ token: '1', extra: 'first line\nsecond line' });
  });

  it('does not treat free-form prose as an option token', () => {
    expect(parseOptionReply('also i think we should use compiled css')).toEqual({ token: null, extra: '' });
    expect(parseOptionReply('yes do it')).toEqual({ token: null, extra: '' });
    expect(parseOptionReply('no')).toEqual({ token: null, extra: '' });
    expect(parseOptionReply('go ahead')).toEqual({ token: null, extra: '' });
  });

  it('handles empty / nullish input', () => {
    expect(parseOptionReply('')).toEqual({ token: null, extra: '' });
    expect(parseOptionReply('   ')).toEqual({ token: null, extra: '' });
    expect(parseOptionReply(null)).toEqual({ token: null, extra: '' });
    expect(parseOptionReply(undefined)).toEqual({ token: null, extra: '' });
  });
});
