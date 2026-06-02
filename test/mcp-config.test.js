import { describe, it, expect } from 'vitest';
import {
  buildMcpServers,
  extractMcpExtraFlags,
  knownMcpExtras,
  mergeMcpConfigs,
  parseDefaultExtras,
  resolveExtras,
} from '../lib/mcp-config.js';

const KNOWN = ['browser', 'circleci'];

describe('extractMcpExtraFlags', () => {
  it('pulls a known --flag out of the token list', () => {
    expect(extractMcpExtraFlags(['--browser', '/some/dir'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['/some/dir'] });
    expect(extractMcpExtraFlags(['/some/dir', '--circleci'], KNOWN))
      .toEqual({ extras: ['circleci'], rest: ['/some/dir'] });
  });

  it('leaves unknown --flags as positional tokens', () => {
    expect(extractMcpExtraFlags(['--browser', '--not-a-flag', '/dir'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['--not-a-flag', '/dir'] });
  });

  it('returns empty extras when none requested', () => {
    expect(extractMcpExtraFlags(['/dir'], KNOWN)).toEqual({ extras: [], rest: ['/dir'] });
    expect(extractMcpExtraFlags([], KNOWN)).toEqual({ extras: [], rest: [] });
  });

  it('does not consume positional args that share Object.prototype names', () => {
    expect(extractMcpExtraFlags(['constructor'], KNOWN)).toEqual({ extras: [], rest: ['constructor'] });
    expect(extractMcpExtraFlags(['__proto__'], KNOWN)).toEqual({ extras: [], rest: ['__proto__'] });
    expect(extractMcpExtraFlags(['--__proto__'], KNOWN)).toEqual({ extras: [], rest: ['--__proto__'] });
    expect(extractMcpExtraFlags(['hasOwnProperty', '--browser'], KNOWN))
      .toEqual({ extras: ['browser'], rest: ['hasOwnProperty'] });
  });
});

describe('knownMcpExtras', () => {
  it('returns the mcpExtras keys of the supplied config', () => {
    const cfg = { mcpServers: {}, mcpExtras: { browser: {}, circleci: {} } };
    expect(knownMcpExtras(cfg).sort()).toEqual(['browser', 'circleci']);
  });
  it('returns [] when there are no extras', () => {
    expect(knownMcpExtras({ mcpServers: {} })).toEqual([]);
    expect(knownMcpExtras(undefined)).toEqual([]);
  });
});

describe('mergeMcpConfigs', () => {
  const base = { mcpServers: { 'ask-user': { command: 'node' } }, mcpExtras: { browser: { 'chrome-devtools': {} } } };

  it('returns base unchanged when overlay is null/undefined', () => {
    expect(mergeMcpConfigs(base, null)).toEqual(base);
    expect(mergeMcpConfigs(base, undefined)).toEqual(base);
    expect(mergeMcpConfigs(base, null)).not.toBe(base);
  });

  it('merges overlay mcpExtras into base by key', () => {
    const overlay = { mcpExtras: { circleci: { circleci: { command: 'node', args: ['/x/server.js'] } } } };
    const out = mergeMcpConfigs(base, overlay);
    expect(Object.keys(out.mcpExtras).sort()).toEqual(['browser', 'circleci']);
    expect(out.mcpExtras.circleci.circleci.args).toEqual(['/x/server.js']);
  });

  it('merges overlay mcpServers too', () => {
    const overlay = { mcpServers: { extra: { command: 'node' } } };
    const out = mergeMcpConfigs(base, overlay);
    expect(Object.keys(out.mcpServers).sort()).toEqual(['ask-user', 'extra']);
  });

  it('does not mutate base', () => {
    const snap = JSON.parse(JSON.stringify(base));
    mergeMcpConfigs(base, { mcpExtras: { circleci: {} } });
    expect(base).toEqual(snap);
  });
});

describe('parseDefaultExtras', () => {
  it('splits a comma list and trims', () => {
    expect(parseDefaultExtras('circleci, browser')).toEqual(['circleci', 'browser']);
  });
  it('returns [] for empty/undefined', () => {
    expect(parseDefaultExtras('')).toEqual([]);
    expect(parseDefaultExtras(undefined)).toEqual([]);
    expect(parseDefaultExtras('  ')).toEqual([]);
  });
  it('drops empty segments', () => {
    expect(parseDefaultExtras('circleci,,')).toEqual(['circleci']);
  });
});

describe('resolveExtras', () => {
  it('unions machine default with session extras, default first, deduped', () => {
    expect(resolveExtras(['circleci'], ['browser'])).toEqual(['circleci', 'browser']);
    expect(resolveExtras(['circleci'], ['circleci'])).toEqual(['circleci']);
    expect(resolveExtras([], ['browser'])).toEqual(['browser']);
    expect(resolveExtras(['circleci'], [])).toEqual(['circleci']);
  });
  it('tolerates missing args', () => {
    expect(resolveExtras()).toEqual([]);
    expect(resolveExtras(['circleci'])).toEqual(['circleci']);
  });
});

const BASE = Object.freeze({
  mcpServers: {
    'ask-user': {
      command: 'node',
      args: ['./ask-user.js'],
      env: { BRIDGE_API_URL: 'http://127.0.0.1:9802' },
    },
  },
  mcpExtras: {
    browser: {
      'chrome-devtools': {
        command: 'xvfb-run',
        args: [
          '--auto-servernum',
          '--server-args=-screen 0 1920x1080x24',
          'npx',
          '-y',
          'chrome-devtools-mcp',
          '--no-usage-statistics',
          '--chromeArg=--no-sandbox',
          '--chromeArg=--disable-setuid-sandbox',
        ],
      },
    },
  },
});

describe('buildMcpServers', () => {
  it('returns only the always-on servers when no extras are requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers)).toEqual(['ask-user']);
    expect(config.mcpServers['ask-user'].args[0]).toBe('/opt/bridge/ask-user.js');
    expect(extras).toEqual([]);
  });

  it('merges the browser extra in when requested', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(config.mcpServers['chrome-devtools'].command).toBe('xvfb-run');
    expect(extras).toEqual(['browser']);
  });

  it('silently drops unknown extras names rather than letting a typo enable nothing-then-everything', () => {
    const { config, extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'not-a-real-group'],
      platform: 'linux',
      askUserBaseDir: '/opt/bridge',
    });
    expect(Object.keys(config.mcpServers).sort()).toEqual(['ask-user', 'chrome-devtools']);
    expect(extras).toEqual(['browser']);
  });

  it('dedupes repeated extras and returns them sorted (for stable filename hashing)', () => {
    const { extras } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser', 'browser'],
      platform: 'linux',
    });
    expect(extras).toEqual(['browser']);
  });

  it('unwraps xvfb-run on macOS so the browser MCP actually starts', () => {
    const { config } = buildMcpServers({
      baseConfig: BASE,
      extras: ['browser'],
      platform: 'darwin',
      askUserBaseDir: '/opt/bridge',
    });
    // macifyMcpServers strips the xvfb wrapper + Linux sandbox flags.
    expect(config.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(config.mcpServers['chrome-devtools'].args).not.toContain('--chromeArg=--no-sandbox');
  });

  it('does not mutate the base config', () => {
    const snapshot = JSON.parse(JSON.stringify(BASE));
    buildMcpServers({ baseConfig: BASE, extras: ['browser'], platform: 'linux', askUserBaseDir: '/x' });
    expect(BASE).toEqual(snapshot);
  });

  it('leaves args alone when no ask-user base dir is given', () => {
    const { config } = buildMcpServers({ baseConfig: BASE, platform: 'linux' });
    expect(config.mcpServers['ask-user'].args[0]).toBe('./ask-user.js');
  });
});
