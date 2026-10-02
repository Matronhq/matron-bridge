import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions on index.js (the idiom of test/box-status-wiring.js
// — index.js has no unit harness). The self-restart onto new code only
// closes the "a bridge with an always-live session never updates" hole if
// index.js actually starts the watcher, counts mid-turn sessions the way
// the rest of the bridge does, and exits NON-zero through the ordinary
// graceful shutdown. Each coupling below fails silently if lost: the bridge
// simply keeps running old code, which is the status quo this fixes.
describe('code-update self-restart wiring', () => {
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = index.indexOf('function startCodeUpdateWatcher()');
  const fn = index.slice(start, index.indexOf('\n}\n', start) + 3);
  const shutdown = index.slice(index.indexOf('async function gracefulShutdown('), index.indexOf("process.on('SIGINT'"));

  it('starts the watcher at the end of main(), after the carry-on cards', () => {
    const main = index.slice(index.indexOf('async function main()'), index.indexOf('main().catch'));
    expect(main).toMatch(/publishRestartCarryOnCards\(\);[\s\S]*startCodeUpdateWatcher\(\);/);
  });

  it('watches the checkout index.js runs from, and is off without a reflog or when disabled', () => {
    expect(fn).toMatch(/if \(!CODE_UPDATE_RESTART\) \{/);
    expect(fn).toMatch(/resolveGitDir\(__dirname\)/);
    expect(fn).toMatch(/readHeadReflog\(gitDir\)/);
    expect(fn).toMatch(/defaultPreflight\(__dirname\)/);
    expect(index).toMatch(/const CODE_UPDATE_RESTART = codeUpdateRestartEnabled\(process\.env\.MATRON_CODE_UPDATE_RESTART\)/);
  });

  it('counts mid-turn sessions as alive && busy — the flag /sessions reports and restart_session parks on', () => {
    expect(fn).toMatch(/busySessions: \(\) => \{[^}]*s\.alive && s\.busy/);
  });

  it('restarts through gracefulShutdown with the non-zero exit code, never while already shutting down', () => {
    expect(fn).toMatch(/if \(shuttingDown\) return;/);
    expect(fn).toMatch(/gracefulShutdown\('code-update', \{ exitCode: CODE_UPDATE_EXIT_CODE \}\)/);
    expect(shutdown).toMatch(/async function gracefulShutdown\(signal, \{ exitCode = 0 \} = \{\}\)/);
    expect(shutdown).toMatch(/process\.exit\(exitCode\);/);
    expect(shutdown).not.toMatch(/process\.exit\(0\);/);
  });

  it('polls on an unref()d timer so the watcher never holds the process open', () => {
    expect(fn).toMatch(/setInterval\(\(\) => \{\n\s*watcher\.tick\(\)\.catch/);
    expect(fn).toMatch(/timer\.unref\(\)/);
  });

  it('is in the syntax-check script like every other lib', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts.check).toMatch(/node --check lib\/code-update-restart\.js/);
  });
});
