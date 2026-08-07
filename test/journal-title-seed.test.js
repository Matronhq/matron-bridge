import { readFileSync } from 'fs';
import { describe, it, expect, vi } from 'vitest';
import { seedJournalTitle, applyFallbackTitle, parseTitlePassResponse } from '../lib/journal-title-seed.js';

describe('seedJournalTitle (workdir-sourced)', () => {
  it('titles the convo from the workdir basename when no hint is set', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, { workdir: '/home/dan/yearbook-app', upsertConvo, warn: () => {} });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('yearbook-app') });
  });

  it('does not overwrite an existing title hint', async () => {
    const session = { _journalTitleHint: 'kept' };
    const upsertConvo = vi.fn();
    await seedJournalTitle(session, { workdir: '/tmp/x', upsertConvo, warn: () => {} });
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  // Restart/resume: the good Gemini title lived on the OLD session object and
  // is handed in as incomingHint. The fresh session must adopt it BEFORE any
  // publish — otherwise the workdir seed publishes the bare repo name and the
  // journal's COALESCE upsert clobbers the good title on the server (the
  // title-revert bug). Adopting silently (no upsert) is the fix: the title
  // already exists server-side, so there is nothing to publish.
  it('adopts an incoming hint onto a fresh session without publishing', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      incomingHint: 'mac:a1b2 Fix the photo upload race',
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('mac:a1b2 Fix the photo upload race');
  });

  it('never seeds the workdir name when reattaching to an existing convo', async () => {
    // Reattach paths (/restart, /model, /mode, resume-after-bridge-restart)
    // pass journalConvoId. The convo already exists server-side with whatever
    // title it earned; even with no in-memory hint, seeding the repo basename
    // here would clobber that title via COALESCE. Only a brand-new convo seeds.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      reattaching: true,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
  });

  it('still seeds the workdir name for a brand-new convo (not reattaching)', async () => {
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      reattaching: false,
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(true);
    expect(upsertConvo).toHaveBeenCalledWith(session, { title: expect.stringContaining('yearbook-app') });
  });

  it('an empty-string incoming hint is a real title and is still adopted silently', async () => {
    // undefined means "no prior title"; '' is a title the user/agent chose.
    // Only undefined should fall through to the workdir seed.
    const session = { _journalTitleHint: undefined };
    const upsertConvo = vi.fn();
    const ok = await seedJournalTitle(session, {
      workdir: '/home/dan/yearbook-app',
      incomingHint: '',
      upsertConvo,
      warn: () => {},
    });
    expect(ok).toBe(false);
    expect(upsertConvo).not.toHaveBeenCalled();
    expect(session._journalTitleHint).toBe('');
  });
});

describe('applyFallbackTitle (no-Gemini first-user-message naming)', () => {
  const deps = () => ({ serverLabel: '2', updateRoomName: vi.fn() });

  it('titles the convo from the first user message, same format as the LLM rename', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa1234',
      chatHistory: [
        { role: 'user', text: 'fix the folder picker' },
        { role: 'assistant', text: 'sure' },
      ],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 fix the folder picker');
  });

  it('does nothing until a user message exists, then still applies later', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'assistant', text: 'hello' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
    session.chatHistory.push({ role: 'user', text: 'now do the thing' });
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 now do the thing');
  });

  it('applies only once per session', () => {
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: 'first' }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).toHaveBeenCalledTimes(1);
  });

  it('strips tags, collapses whitespace, and truncates to 60 chars with an ellipsis', () => {
    const long = 'refactor <ide-opened-file></ide-opened-file> the whole\n\n  session   store so that every folder ever used shows up in the picker';
    const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text: long }] };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    const title = d.updateRoomName.mock.calls[0][1];
    expect(title.startsWith('2:f0 refactor the whole session store')).toBe(true);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBe('2:f0 '.length + 61);
  });

  it('falls back to the room id for the short prefix and survives a missing history', () => {
    const session = { roomId: '!room', chatHistory: undefined };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(false);
    session.chatHistory = [{ role: 'user', text: 'hi' }];
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!room', '2:ro hi');
  });

  it('never lets angle brackets or reassembled script fragments into the title', () => {
    const cases = ['<scr<x>ipt>alert time', 'look at <script src=x', 'a <b> c > d'];
    for (const text of cases) {
      const session = { roomId: '!abc', claudeSessionId: 'f0aa', chatHistory: [{ role: 'user', text }] };
      const d = deps();
      expect(applyFallbackTitle(session, d)).toBe(true);
      const title = d.updateRoomName.mock.calls[0][1];
      expect(title).not.toMatch(/[<>]/);
    }
  });

  it('does not clobber a title that is no longer the workdir seed (e.g. a resume summary)', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: '2: fix the folder picker…',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/dan/proj' };
    expect(applyFallbackTitle(session, d)).toBe(false);
    expect(d.updateRoomName).not.toHaveBeenCalled();
  });

  it('does replace the workdir-basename seed title', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      _journalTitleHint: 'proj',
      chatHistory: [{ role: 'user', text: 'carry on' }],
    };
    const d = { ...deps(), workdir: '/home/dan/proj' };
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 carry on');
  });

  it('skips a tag-only first user message and titles from the next real one', () => {
    const session = {
      roomId: '!abc',
      claudeSessionId: 'f0aa',
      chatHistory: [
        { role: 'user', text: '<ide-selection></ide-selection>' },
        { role: 'user', text: 'the real prompt' },
      ],
    };
    const d = deps();
    expect(applyFallbackTitle(session, d)).toBe(true);
    expect(d.updateRoomName).toHaveBeenCalledWith('!abc', '2:f0 the real prompt');
  });
});

describe('parseTitlePassResponse (Gemini title-pass parsing)', () => {
  it('parses all four fields from a well-formed response', () => {
    const parsed = parseTitlePassResponse(
      'TITLE: plan mode fix\nSUMMARY: Fixed the plan-mode toggle.\nNEW: Added a regression test.\nROSTER: Working on the plan-mode toggle in the bridge.');
    expect(parsed).toEqual({
      title: 'plan mode fix',
      summary: 'Fixed the plan-mode toggle.',
      added: 'Added a regression test.',
      roster: 'Working on the plan-mode toggle in the bridge.',
    });
  });

  it('captures a multi-line ROSTER through to end-of-text', () => {
    const parsed = parseTitlePassResponse(
      'TITLE: search backfill\nROSTER: Backfilling the FTS index.\nCurrently fixing ghost rows.\nNext up is trigger coverage.');
    expect(parsed.title).toBe('search backfill');
    expect(parsed.roster).toBe('Backfilling the FTS index.\nCurrently fixing ghost rows.\nNext up is trigger coverage.');
  });

  it('stops the ROSTER capture at the next KEY: line', () => {
    // The prompt keeps ROSTER as its last format line, but a model that
    // reorders fields must not have a later key swallowed into the roster.
    const parsed = parseTitlePassResponse(
      'ROSTER: First roster line.\nSecond roster line.\nTITLE: out of order\nNEW: something new');
    expect(parsed.roster).toBe('First roster line.\nSecond roster line.');
    expect(parsed.title).toBe('out of order');
    expect(parsed.added).toBe('something new');
  });

  it('returns null for absent fields (pre-ROSTER responses keep working)', () => {
    const parsed = parseTitlePassResponse('TITLE: voice note support\nNEW: Wired the recorder.');
    expect(parsed.title).toBe('voice note support');
    expect(parsed.added).toBe('Wired the recorder.');
    expect(parsed.summary).toBeNull();
    expect(parsed.roster).toBeNull();
  });

  it('returns all nulls for garbage and non-string input', () => {
    expect(parseTitlePassResponse('the model rambled with no keys at all')).toEqual({
      title: null, summary: null, added: null, roster: null,
    });
    expect(parseTitlePassResponse(undefined)).toEqual({
      title: null, summary: null, added: null, roster: null,
    });
  });
});

describe('title-pass wiring in index.js (source inspection)', () => {
  const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf-8');

  it('routes the Gemini response through parseTitlePassResponse', () => {
    expect(indexSrc).toMatch(/const parsed = parseTitlePassResponse\(text\);/);
  });

  it('asks for ROSTER as the last format line of both prompt variants', () => {
    // Two prompt variants, each ending its Format: block with the ROSTER
    // line — the parser's multi-line capture would swallow any field
    // placed after it.
    const rosterFormatLines = indexSrc.match(/\\nROSTER: <2-3 sentences[^>]*>\\n\\nNo quotes\./g) || [];
    expect(rosterFormatLines.length).toBe(2);
  });

  it('upserts the roster to the journal, sliced to the protocol cap', () => {
    expect(indexSrc).toMatch(/journalUpsertConvo\(session, \{ summary: parsed\.roster\.slice\(0, 1000\) \}\);/);
  });
});
