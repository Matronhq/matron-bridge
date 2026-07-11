import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import { createJournalPublisher } from '../lib/journal-publisher.js';

// Optional end-to-end check against the real matron-journal server code (not
// a fake). Only runs on boxes that have a matron-journal checkout next to
// this repo (true on dev-2 today); everywhere else — including regular CI —
// this file is a no-op so the suite stays green without the sibling repo.
const MATRON_DIR = '/home/danbarker/matron-journal';
const HAS_MATRON = existsSync(MATRON_DIR);

const describeIfMatron = HAS_MATRON ? describe : describe.skip;

describeIfMatron('journal-publisher against the real matron-journal server', () => {
  let dbPath;
  let tmpDir;
  let serverProc;
  let serverPort;
  let agentToken;

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'matron-journal-it-'));
    dbPath = path.join(tmpDir, 'matron.db');

    execFileSync('node', ['bin/matron-admin.js', 'user', 'add', 'itest', '--password', 'itest-pw-12345'], {
      cwd: MATRON_DIR,
      env: { ...process.env, MATRON_DB: dbPath },
    });
    const agentOut = execFileSync('node', ['bin/matron-admin.js', 'agent', 'add', 'itest', 'dev-2'], {
      cwd: MATRON_DIR,
      env: { ...process.env, MATRON_DB: dbPath },
    }).toString();
    const tokenMatch = agentOut.match(/token:\s*(\S+)/);
    if (!tokenMatch) throw new Error(`could not parse agent token from: ${agentOut}`);
    agentToken = tokenMatch[1];

    serverPort = await new Promise((resolve, reject) => {
      serverProc = spawn('node', ['src/server.js'], {
        cwd: MATRON_DIR,
        env: { ...process.env, MATRON_DB: dbPath, MATRON_PORT: '0', MATRON_BIND: '127.0.0.1' },
      });
      let out = '';
      const onData = (chunk) => {
        out += chunk.toString();
        const m = out.match(/listening on [^\s:]+:(\d+)/);
        if (m) {
          serverProc.stdout.off('data', onData);
          resolve(Number(m[1]));
        }
      };
      serverProc.stdout.on('data', onData);
      serverProc.stderr.on('data', (d) => { out += d.toString(); });
      serverProc.on('exit', (code) => reject(new Error(`matron-journal server exited early (code ${code}): ${out}`)));
      setTimeout(() => reject(new Error(`matron-journal server did not start in time: ${out}`)), 10000);
    });
  }, 30000);

  afterAll(async () => {
    if (serverProc && !serverProc.killed) {
      serverProc.kill('SIGTERM');
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  function statusOutput() {
    return execFileSync('node', ['bin/matron-admin.js', 'status'], {
      cwd: MATRON_DIR,
      env: { ...process.env, MATRON_DB: dbPath },
    }).toString();
  }

  function totalEvents() {
    const m = statusOutput().match(/total events:\s*(\d+)/);
    return m ? Number(m[1]) : null;
  }

  it('publishes convo_upsert + text/prompt/tool_output rows that land in the real database', async () => {
    const before = totalEvents();
    expect(before).not.toBeNull();

    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
    });

    pub.upsertConvo('itest-convo-1', { title: 'Integration test convo', sessionState: 'running' });
    pub.publishText('itest-convo-1', { body: 'hello from the bridge', from: 'assistant' });
    pub.publishPrompt('itest-convo-1', { question: 'Proceed?', options: ['yes', 'no'] });
    pub.publishToolOutput('itest-convo-1', { tool_use_id: 't1', command: 'ls', viewer_url: 'https://x', expires_at: 0 });

    // Poll matron-admin status until the new rows show up (session_status +
    // 3 published events = 4 new rows), rather than assume a fixed delay.
    const deadline = Date.now() + 5000;
    let after = before;
    while (Date.now() < deadline) {
      after = totalEvents();
      if (after !== null && after >= before + 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    pub.close();

    expect(after).toBeGreaterThanOrEqual(before + 4);
  }, 15000);
});
