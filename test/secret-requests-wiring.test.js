import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-text assertions, the same idiom as test/items-wiring.test.js: neither
// index.js nor ask-user.js has a unit-test harness (one boots a server, the
// other connects a stdio transport at import), so the couplings below have no
// behavioural coverage. Each regresses silently — a request_secret that still
// polls would block a turn for five minutes and then lie about a timeout.
const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

describe('request_secret is non-blocking', () => {
  const askUser = read('ask-user.js');

  it('has no poll loop and no five-minute deadline left in it', () => {
    expect(askUser).not.toContain('SECRET_TIMEOUT_MS');
    // The one remaining POLL_INTERVAL_MS user is the permission prompt.
    const secretTool = askUser.slice(askUser.indexOf("'request_secret'"), askUser.indexOf("'permission_request'"));
    expect(secretTool).not.toContain('POLL_INTERVAL_MS');
    expect(secretTool).not.toContain('while (');
  });

  it('returns immediately with the request number and the promised turn', () => {
    const secretTool = askUser.slice(askUser.indexOf("'request_secret'"), askUser.indexOf("'permission_request'"));
    expect(secretTool).toContain('Secret requested');
    expect(secretTool).toContain('24 hours');
    expect(secretTool).toContain('do not poll');
  });

  it('offers multiline and sends it to the bridge', () => {
    const secretTool = askUser.slice(askUser.indexOf("'request_secret'"), askUser.indexOf("'permission_request'"));
    expect(secretTool).toContain('multiline: z.boolean().optional()');
    expect(secretTool).toMatch(/body: JSON\.stringify\(\{[^}]*multiline/);
  });

  it('tells the model in the description that the answer arrives as a turn', () => {
    const desc = askUser.slice(askUser.indexOf("'request_secret'"), askUser.indexOf('label: z.string()'));
    expect(desc).toMatch(/does not block|non-blocking|returns immediately/i);
    expect(desc).toMatch(/turn/i);
    expect(desc).toMatch(/multiline/);
  });
});

describe('bridge wiring', () => {
  const index = read('index.js');

  it('drives every secret route through lib/secret-requests.js', () => {
    expect(index).toContain("from './lib/secret-requests.js'");
    expect(index).toContain('createSecretRequests({');
    expect(index).toContain('secretRequests.create(');
    expect(index).toContain('secretRequests.submit(');
    expect(index).toContain('secretRequests.read(');
  });

  it('re-arms persisted requests at startup', () => {
    expect(index).toContain('secretRequests.init()');
    expect(index).toContain('.matron-bridge-secrets.json');
  });

  it('signs the secret link for the request lifetime, not the file-link window', () => {
    expect(index).toMatch(/function generateSecretLink\(secretId, label, roomId, \{[^)]*ttlMs/);
    expect(index).toMatch(/multiline/);
  });

  it('delivers the turn through the item-turn seams rather than a second queue', () => {
    const deliver = index.slice(index.indexOf('function deliverSecretTurn'));
    expect(deliver).toContain('journalQueueMedia(');
    expect(deliver).toContain('sendToSession(');
    expect(deliver).toContain('journalPublishNotice(');
  });
});

describe('agent-facing docs', () => {
  it('BRIDGE_CLAUDE.md describes the non-blocking flow, the tracker item and multiline', () => {
    const md = read('BRIDGE_CLAUDE.md');
    const bullet = md.split('\n').find((l) => l.includes('request_secret'));
    expect(bullet).toBeTruthy();
    expect(bullet).toMatch(/does not block|non-blocking/i);
    expect(bullet).toMatch(/turn/i);
    expect(bullet).toMatch(/multiline/);
    // The SECURITY rules around it stay intact.
    expect(md).toContain('Never post sensitive data directly in Matron chat messages.');
    expect(md).toContain('Failure to use a secure MCP flow for sensitive data is a critical security violation.');
  });

  it('BRIDGE_CODEX.md says the same', () => {
    const md = read('BRIDGE_CODEX.md');
    const bullet = md.split('\n').find((l) => l.includes('request_secret'));
    expect(bullet).toBeTruthy();
    expect(bullet).toMatch(/does not block|non-blocking/i);
    expect(bullet).toMatch(/multiline/);
  });
});
