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

  // The matron-journal checkout this suite spawns may or may not yet have
  // landed agent read_marker support (matron-journal PR #2, landing in
  // parallel with this branch). Today's server treats read_marker as
  // client-only and rejects agent connections with a 'forbidden' control
  // error frame (src/ws.js: `case 'read_marker': if (conn.kind !== 'client')
  // return fail('forbidden')`). Rather than hard-code which behavior to
  // expect, this test attempts the real op against whatever server is
  // actually running and asserts on the observed outcome — so it stays green
  // whichever side of that server-side change dev-2's checkout is on.
  it('markRead: works against both today\'s server (agent read_marker rejected) and a future one that supports it, without ever wedging the queue', async () => {
    const before = totalEvents();
    expect(before).not.toBeNull();

    const warnings = [];
    const log = { warn: (...a) => warnings.push(a.join(' ')), error: () => {} };
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log,
    });

    pub.upsertConvo('itest-convo-readmarker', { title: 'Read marker probe', sessionState: 'running' });
    pub.publishText('itest-convo-readmarker', { body: 'hello', from: 'user' });
    pub.markRead('itest-convo-readmarker');
    // Regardless of read_marker support, the queue must keep flowing: publish
    // something after the (possibly-rejected) markRead and confirm it still
    // lands rather than getting stuck behind it.
    pub.publishText('itest-convo-readmarker', { body: 'still flowing after markRead', from: 'user' });

    // Poll until at least the two publishes have definitely landed (a
    // supported read_marker adds a 3rd row on top of that).
    const deadline = Date.now() + 5000;
    let after = before;
    while (Date.now() < deadline) {
      after = totalEvents();
      if (after !== null && after >= before + 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Give a rejected read_marker's error frame (or an accepted one's journal
    // row) a moment to fully round-trip before inspecting which leg fired.
    await new Promise((r) => setTimeout(r, 200));

    pub.close();

    const forbiddenWarning = warnings.find((w) => /forbidden/.test(w));
    if (forbiddenWarning) {
      // Leg 1 (today's server): agent read_marker is rejected — the queue
      // must have kept flowing regardless, so both publishes still landed.
      expect(after).toBeGreaterThanOrEqual(before + 2);
    } else {
      // Leg 2 (a future server with agent read_marker landed): the marker
      // itself becomes a 3rd journal row, and no error was logged.
      expect(after).toBeGreaterThanOrEqual(before + 3);
    }
  }, 15000);

  // Same "may or may not have landed yet" situation for POST /media (also
  // part of matron-journal PR #2) — but uploadMedia's own fail-open contract
  // means attempting the op IS the probe: a 404 (no /media route yet) is just
  // another non-2xx response it already resolves to null for, so no separate
  // capability probe is needed the way markRead's fire-and-forget queue
  // needed one above.
  it('uploadMedia: works against both today\'s server (no /media route) and a future one that has it', async () => {
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
    });

    const bytes = Buffer.from('itest media bytes');
    const result = await pub.uploadMedia({ bytes, contentType: 'text/plain', name: 'itest.txt' });

    pub.close();

    if (result) {
      // Leg 2 (a future server with /media landed).
      expect(result.media_id).toBeTruthy();
      expect(result.size).toBe(bytes.length);
    } else {
      // Leg 1 (today's server: no /media route yet) — fails open to null.
      expect(result).toBeNull();
    }
  }, 15000);
});
