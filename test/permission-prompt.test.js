import { describe, it, expect } from 'vitest';
import {
  renderPermissionCard,
  permissionButtons,
  parsePermTap,
  permissionSpawnArgs,
} from '../lib/permission-prompt.js';

const UUID = '01234567-89ab-cdef-0123-456789abcdef';

describe('permissionButtons', () => {
  it('builds the three verdict buttons with perm-namespaced ids and values', () => {
    const { buttons, mode } = permissionButtons(UUID, 'Bash');
    expect(mode).toBe('pick_one');
    expect(buttons).toEqual([
      { id: 'perm-allow', label: 'Allow once', value: `perm:${UUID}:allow` },
      { id: 'perm-always', label: 'Always allow Bash (session)', value: `perm:${UUID}:always` },
      { id: 'perm-deny', label: 'Deny', value: `perm:${UUID}:deny` },
    ]);
  });
});

describe('parsePermTap', () => {
  it('round-trips every button value permissionButtons emits', () => {
    for (const b of permissionButtons(UUID, 'WebFetch').buttons) {
      const parsed = parsePermTap(b.value);
      expect(parsed).not.toBeNull();
      expect(parsed.requestId).toBe(UUID);
      expect(['allow', 'always', 'deny']).toContain(parsed.verdict);
    }
  });

  it('rejects malformed and foreign values', () => {
    expect(parsePermTap('perm:not-a-uuid:allow')).toBeNull();
    expect(parsePermTap(`perm:${UUID}:maybe`)).toBeNull();
    expect(parsePermTap(`perm:${UUID}`)).toBeNull();
    expect(parsePermTap('model:sonnet')).toBeNull();
    expect(parsePermTap('')).toBeNull();
    expect(parsePermTap(null)).toBeNull();
    expect(parsePermTap(42)).toBeNull();
  });
});

describe('renderPermissionCard', () => {
  it('shows the command (and description) for Bash', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'rm -rf build', description: 'Clean build dir' },
    });
    expect(plain).toContain('Bash');
    expect(plain).toContain('rm -rf build');
    expect(plain).toContain('Clean build dir');
    expect(html).toContain('<code>');
  });

  it('shows compact JSON for non-Bash tools and escapes html', () => {
    const { plain, html } = renderPermissionCard({
      toolName: 'WebFetch',
      input: { url: 'https://x.test/<b>' },
    });
    expect(plain).toContain('"url"');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<b>"');
  });

  it('truncates long previews to ~500 chars', () => {
    const { plain } = renderPermissionCard({
      toolName: 'Bash',
      input: { command: 'x'.repeat(2000) },
    });
    expect(plain.length).toBeLessThan(700);
    expect(plain).toContain('…');
  });

  it('tolerates missing/unserializable input', () => {
    expect(() => renderPermissionCard({ toolName: 'Weird' })).not.toThrow();
    const cyc = {}; cyc.self = cyc;
    expect(() => renderPermissionCard({ toolName: 'Weird', input: cyc })).not.toThrow();
  });
});

describe('permissionSpawnArgs', () => {
  it('default: auto mode plus the prompt tool', () => {
    expect(permissionSpawnArgs(false)).toEqual([
      '--permission-mode', 'auto',
      '--permission-prompt-tool', 'mcp__ask-user__permission_request',
    ]);
  });

  it('bypass: the old skip-permissions flag', () => {
    expect(permissionSpawnArgs(true)).toEqual(['--dangerously-skip-permissions']);
  });
});
