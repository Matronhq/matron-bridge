import { describe, it, expect } from 'vitest';
import { macifyMcpServers } from '../lib/mcp-config-mac.js';

describe('macifyMcpServers — xvfb-wrap.sh unwrapping', () => {
  // The browser extra now wraps its MCP in hooks/xvfb-wrap.sh (the leak-proof
  // xvfb-run replacement). On macOS there's no Xvfb at all, so the wrapper —
  // whether still repo-relative or already resolved to an absolute path by
  // buildMcpServers — must be unwrapped to the real command, exactly like
  // the legacy xvfb-run entries.
  it('unwraps a resolved absolute xvfb-wrap.sh path and strips Linux sandbox args', () => {
    const input = {
      mcpServers: {
        'chrome-devtools': {
          command: '/opt/bridge/hooks/xvfb-wrap.sh',
          args: [
            'npx', '-y', 'chrome-devtools-mcp',
            '--no-usage-statistics',
            '--chromeArg=--no-sandbox',
            '--chromeArg=--disable-setuid-sandbox',
            '--viewport=1920x1080',
          ],
        },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(out.mcpServers['chrome-devtools'].args).toEqual([
      '-y', 'chrome-devtools-mcp', '--no-usage-statistics', '--viewport=1920x1080',
    ]);
  });

  it('unwraps a still-relative ./hooks/xvfb-wrap.sh command', () => {
    const input = {
      mcpServers: {
        'chrome-devtools': {
          command: './hooks/xvfb-wrap.sh',
          args: ['npx', '-y', 'chrome-devtools-mcp'],
        },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(out.mcpServers['chrome-devtools'].args).toEqual(['-y', 'chrome-devtools-mcp']);
  });

  it('does not unwrap commands that merely contain the name (no false positives)', () => {
    const input = {
      mcpServers: {
        other: { command: '/opt/tools/not-xvfb-wrap.sh.backup', args: ['a'] },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers.other).toEqual(input.mcpServers.other);
  });

  it('returns the server unchanged when xvfb-wrap.sh has no command to unwrap', () => {
    const input = {
      mcpServers: {
        broken: { command: './hooks/xvfb-wrap.sh', args: [] },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers.broken).toEqual(input.mcpServers.broken);
  });
});

describe('macifyMcpServers', () => {
  it('unwraps xvfb-run for puppeteer and strips Linux sandbox launch args', () => {
    const input = {
      mcpServers: {
        puppeteer: {
          command: 'xvfb-run',
          args: [
            '--auto-servernum',
            '--server-args=-screen 0 1920x1080x24',
            'npx',
            '-y',
            '@modelcontextprotocol/server-puppeteer',
          ],
          env: {
            PUPPETEER_LAUNCH_OPTIONS: JSON.stringify({
              headless: false,
              args: ['--no-sandbox', '--disable-setuid-sandbox'],
            }),
          },
        },
      },
    };

    const out = macifyMcpServers(input);

    expect(out.mcpServers.puppeteer.command).toBe('npx');
    expect(out.mcpServers.puppeteer.args).toEqual([
      '-y',
      '@modelcontextprotocol/server-puppeteer',
    ]);
    expect(JSON.parse(out.mcpServers.puppeteer.env.PUPPETEER_LAUNCH_OPTIONS)).toEqual({
      headless: false,
    });
  });

  it('strips chrome sandbox --chromeArg flags from chrome-devtools', () => {
    const input = {
      mcpServers: {
        'chrome-devtools': {
          command: 'xvfb-run',
          args: [
            '--auto-servernum',
            '--server-args=-screen 0 1920x1080x24',
            'npx',
            '-y',
            'chrome-devtools-mcp',
            '--no-usage-statistics',
            '--acceptInsecureCerts',
            '--chromeArg=--no-sandbox',
            '--chromeArg=--disable-setuid-sandbox',
            '--viewport=1920x1080',
          ],
        },
      },
    };

    const out = macifyMcpServers(input);

    expect(out.mcpServers['chrome-devtools'].command).toBe('npx');
    expect(out.mcpServers['chrome-devtools'].args).toEqual([
      '-y',
      'chrome-devtools-mcp',
      '--no-usage-statistics',
      '--acceptInsecureCerts',
      '--viewport=1920x1080',
    ]);
  });

  it('leaves non-xvfb-run servers unchanged', () => {
    const askUser = {
      command: 'node',
      args: ['/path/to/ask-user.js'],
      env: { BRIDGE_API_URL: 'http://127.0.0.1:9802' },
    };
    const out = macifyMcpServers({ mcpServers: { 'ask-user': askUser } });
    expect(out.mcpServers['ask-user']).toEqual(askUser);
  });

  it('does not mutate the input config or nested servers', () => {
    const input = {
      mcpServers: {
        puppeteer: {
          command: 'xvfb-run',
          args: ['--auto-servernum', 'npx', '-y', 'srv'],
          env: { PUPPETEER_LAUNCH_OPTIONS: '{"args":["--no-sandbox"]}' },
        },
      },
    };
    const inputSnapshot = JSON.parse(JSON.stringify(input));
    macifyMcpServers(input);
    expect(input).toEqual(inputSnapshot);
  });

  it('drops the env object when it ends up empty', () => {
    const input = {
      mcpServers: {
        puppeteer: {
          command: 'xvfb-run',
          args: ['--auto-servernum', 'npx', '-y', 'srv'],
          env: {},
        },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers.puppeteer.env).toBeUndefined();
  });

  it('passes through malformed PUPPETEER_LAUNCH_OPTIONS unchanged', () => {
    const input = {
      mcpServers: {
        puppeteer: {
          command: 'xvfb-run',
          args: ['--auto-servernum', 'npx', '-y', 'srv'],
          env: { PUPPETEER_LAUNCH_OPTIONS: 'not json' },
        },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers.puppeteer.env.PUPPETEER_LAUNCH_OPTIONS).toBe('not json');
  });

  it('returns the config unchanged when there are no mcpServers', () => {
    expect(macifyMcpServers({})).toEqual({});
    expect(macifyMcpServers(null)).toBeNull();
  });

  it('returns the server unchanged when xvfb-run has no real command to unwrap', () => {
    const input = {
      mcpServers: {
        weird: {
          command: 'xvfb-run',
          args: ['--auto-servernum', '--server-args=-screen 0 1920x1080x24'],
        },
      },
    };
    const out = macifyMcpServers(input);
    expect(out.mcpServers.weird).toEqual(input.mcpServers.weird);
  });
});
