import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWorkspaceTrusted } from '../lib/pre-trust.js';

describe('ensureWorkspaceTrusted', () => {
  let tmpHome;
  let claudeJsonPath;
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pretrust-'));
    claudeJsonPath = path.join(tmpHome, '.claude.json');
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('creates .claude.json with the project entry when the file does not exist', () => {
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.projects['/foo/bar'].hasTrustDialogAccepted).toBe(true);
    expect(c.projects['/foo/bar'].hasCompletedProjectOnboarding).toBe(true);
  });

  it('also primes global onboarding so the theme picker does not block on first run', () => {
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.hasCompletedOnboarding).toBe(true);
    expect(typeof c.lastOnboardingVersion).toBe('string');
    expect(c.lastOnboardingVersion.length).toBeGreaterThan(0);
  });

  it('primes bypassPermissionsModeAccepted so --dangerously-skip-permissions does not modal-loop', () => {
    // Real reproduction: bridge spawns claude with
    // --dangerously-skip-permissions; on first run claude shows a modal
    // whose default highlighted option is "No, exit". Default answer
    // exits with code 1, bridge restarts, repeats. Setting this flag
    // skips the modal entirely.
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.bypassPermissionsModeAccepted).toBe(true);
  });

  it('does not overwrite an existing lastOnboardingVersion', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '9.9.9-real-version',
    }));
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.lastOnboardingVersion).toBe('9.9.9-real-version');
  });

  it('preserves existing top-level and sibling-project fields', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      numStartups: 42,
      projects: { '/other': { foo: 1 } },
    }));
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.numStartups).toBe(42);
    expect(c.projects['/other'].foo).toBe(1);
    expect(c.projects['/foo/bar'].hasTrustDialogAccepted).toBe(true);
  });

  it('preserves existing project fields while adding trust flags', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      projects: { '/foo/bar': { allowedTools: ['Read'], custom: 'keep me' } },
    }));
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.projects['/foo/bar'].allowedTools).toEqual(['Read']);
    expect(c.projects['/foo/bar'].custom).toBe('keep me');
    expect(c.projects['/foo/bar'].hasTrustDialogAccepted).toBe(true);
  });

  it('is idempotent — calling twice does not rewrite the file', () => {
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const mtime1 = fs.statSync(claudeJsonPath).mtimeMs;
    // Tiny pause so a rewrite would change mtime detectably.
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const mtime2 = fs.statSync(claudeJsonPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('is idempotent when global onboarding was already primed by an earlier claude run', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: '0.2.99',
      bypassPermissionsModeAccepted: true,
      projects: {
        '/foo/bar': {
          hasTrustDialogAccepted: true,
          hasCompletedProjectOnboarding: true,
        },
      },
    }));
    const mtime1 = fs.statSync(claudeJsonPath).mtimeMs;
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    ensureWorkspaceTrusted('/foo/bar', claudeJsonPath);
    const mtime2 = fs.statSync(claudeJsonPath).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('resolves relative paths to absolute before keying', () => {
    process.chdir(tmpHome);
    ensureWorkspaceTrusted('./sub', claudeJsonPath);
    const c = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    expect(c.projects[path.join(tmpHome, 'sub')]).toBeDefined();
  });
});
