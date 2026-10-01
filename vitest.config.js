import { defineConfig } from 'vitest/config';

// Tests that exercise POSIX-only pieces and cannot run on the Windows CI job:
// the bash hook scripts (their Node ports in hooks/*.mjs are tested by
// test/hooks-mjs.test.js on every platform), the Xvfb wrapper, the Codex
// producer shim (symlinks, /proc, process groups — Codex is not supported on
// Windows), and suites that shell out to sh/ps or depend on POSIX file modes.
// Keep this list short and explicit; a new test that needs a POSIX tool
// belongs here, not behind a per-test skip.
const WINDOWS_EXCLUDES = [
  'test/matron-bash-tee.test.js',
  'test/xvfb-wrap.test.js',
  'test/codex-producer.test.js',
  'test/codex-paths.test.js',
  'test/codex-liveness.test.js',
  'test/matron-tee.test.js',
  'test/journal-publisher.integration.test.js',
  'test/video-frames.integration.test.js',
];

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      ...(process.platform === 'win32' ? WINDOWS_EXCLUDES : []),
    ],
  },
});
