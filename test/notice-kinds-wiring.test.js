import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of the other *-wiring tests:
// index.js has no unit harness). Each bridge event that already existed gets
// a payload.notice kind at its emit site; none of them is detected anew.
describe('extra notice kinds are set where the events already happen', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

  it('sendKindNotice sends through sendToRoom with the notice tag and tells the caller when it could not', () => {
    const start = index.indexOf('function sendKindNotice(');
    expect(start).toBeGreaterThan(-1);
    const body = index.slice(start, index.indexOf('\n}\n', start));
    expect(body).toMatch(/if \(!meta \|\| !session\?\.roomId\) return false;/);
    expect(body).toMatch(/sendToRoom\(session\.roomId, plain, html, \{ notice: meta \}\)/);
    expect(body).toMatch(/\.catch\(/);
    expect(body).toMatch(/return true;/);
    expect(body).toMatch(/return false;/);
  });

  it('tags both crash-restart notices (print mode and interactive mode) and keeps the untagged fallback', () => {
    const sites = index.match(/sendKindNotice\(restarted, 'crash_restart', n\.plain, n\.html,\s*crashRestartNoticeMeta\(\{ exitCode, attempt: restarted\.restartCount \}\)\)\) restarted\.sendHtml\(n\.plain, n\.html\)/g);
    expect(sites).toHaveLength(2);
  });

  it('tags the slow-tool notice and falls back to the plain callback', () => {
    expect(index).toMatch(/noticeMeta\('slow_tool', text, \{ summary: slowToolNoticeSummary\(\{ toolName, elapsedMs, reminder \}\) \}\)/);
    expect(index).toMatch(/if \(!sendKindNotice\(session, 'slow_tool', text, markdownToHtml\(text\), meta\)\) session\.sendCallback\(text\);/);
  });

  it('tags the !restart result line', () => {
    expect(index).toMatch(/sendKindNotice\(restarted, 'restart', restartedLine, markdownToHtml\(restartedLine\)\)\) await sendReply\(restartedLine\)/);
  });

  it('tags the delivery failures: dropped queued messages, a failed room flush, stranded room messages, a lost timer', () => {
    expect(index).toMatch(/noticeMeta\('delivery_failed', droppedLine\)/);
    expect(index).toMatch(/noticeMeta\(flushed \? 'queue' : 'delivery_failed', flushLine\)/);
    expect(index).toMatch(/noticeMeta\('delivery_failed', strandedLine\)/);
    expect(index).toMatch(/noticeMeta\('delivery_failed', lostLine\)/);
  });

  it('adds no turn-start marker: no turn_start key is published', () => {
    expect(index).not.toMatch(/turn_start\s*:/);
  });
});
