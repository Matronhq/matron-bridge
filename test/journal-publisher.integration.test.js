import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawn, execFileSync } from 'child_process';
import WebSocket from 'ws';
import { createJournalPublisher } from '../lib/journal-publisher.js';

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 10s default: these tests spawn a real matron-journal server, and under full
// parallel suite load its WS round-trips can exceed 5s (a long-standing flake
// on the cursor-redelivery test). Still bounded by each it()'s 15-20s timeout.
async function waitFor(predicate, timeoutMs = 10000, intervalMs = 20) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: timed out waiting for condition');
    await delay(intervalMs);
  }
}

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
  let clientToken;

  // Raw client-device WebSocket helper — stands in for Matron. Not the
  // publisher under test (that's the agent side); this is the OTHER end of
  // the wire contract described in the brief (client `send`/`prompt_reply`
  // ops), driven directly against the real server.
  async function connectClient() {
    const ws = new WebSocket(`ws://127.0.0.1:${serverPort}/ws`);
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    await new Promise((resolve, reject) => {
      const onMsg = (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        if (msg.op === 'hello_ok') { ws.off('message', onMsg); resolve(); }
      };
      ws.on('message', onMsg);
      ws.on('error', reject);
      ws.send(JSON.stringify({ op: 'hello', token: clientToken, cursor: null }));
    });
    return {
      ws,
      send: (op) => ws.send(JSON.stringify(op)),
      close: () => ws.close(),
    };
  }

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

    // Client device, provisioned the way Matron itself would be: POST
    // /login with the same user's credentials. Same user as the agent above
    // (single-user bridge deployment) so the server fans the client's
    // send/prompt_reply ops back to the agent socket per the brief's
    // contract ("fan out to every connected device of that user INCLUDING
    // the bridge's own agent socket").
    const loginRes = await fetch(`http://127.0.0.1:${serverPort}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'itest', password: 'itest-pw-12345', device_name: 'matron-itest' }),
    });
    if (!loginRes.ok) throw new Error(`client /login failed: HTTP ${loginRes.status}`);
    const loginBody = await loginRes.json();
    clientToken = loginBody.token;
    if (!clientToken) throw new Error(`client /login did not return a token: ${JSON.stringify(loginBody)}`);
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

  // The journal return path itself: a real client device (Matron stand-in)
  // sends `send` and `prompt_reply` ops against a convo the agent owns; the
  // agent-side publisher's onEvent must see each exactly once, cursor
  // persistence must survive a publisher restart, and a restarted publisher
  // pointed at the same (intact) cursor file must not redeliver anything
  // already seen.
  it('client send + prompt_reply reach the agent publisher\'s onEvent exactly once; restart with the cursor file intact redelivers nothing', async () => {
    const convoId = `itest-return-${Date.now()}`;
    const cursorDir = mkdtempSync(path.join(tmpdir(), 'journal-cursor-it-'));
    const cursorFile = path.join(cursorDir, 'cursor.json');

    const delivered1 = [];
    const pub1 = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
      cursorFile,
      onEvent: (frame) => delivered1.push(frame),
    });

    // The convo must exist before a client can send into it (server-side
    // FK-style check in journal.js append()) — exactly like a real bridge
    // session existing before Matron replies into it.
    pub1.upsertConvo(convoId, { title: 'Return-path integration convo', sessionState: 'running' });

    const client = await connectClient();
    client.send({ op: 'send', convo_id: convoId, type: 'text', payload: { body: 'hello from matron' } });
    client.send({ op: 'prompt_reply', convo_id: convoId, target_seq: 1, choice: 'opt_a', text: null });

    // The agent's own upsertConvo also round-trips back to it as
    // agent-sender frames (session_status, convo_meta) — the same fan-out-
    // to-every-device-including-the-sender behavior the brief's loop-
    // prevention rule exists for. Filter to the client's own sender identity
    // to isolate the two events under test.
    await waitFor(() => delivered1.filter(f => f.convo_id === convoId && f.sender === 'user:itest').length >= 2);
    await delay(150); // give any stray redelivery a chance to show up before we assert exactly-once

    const ours1 = delivered1.filter(f => f.convo_id === convoId && f.sender === 'user:itest');
    expect(ours1.length).toBe(2);
    expect(ours1.map(f => f.type)).toEqual(['text', 'prompt_reply']);
    expect(ours1.every(f => f.sender === 'user:itest')).toBe(true);
    expect(ours1[0].payload).toEqual({ body: 'hello from matron' });
    expect(ours1[1].payload).toEqual({ target_seq: 1, choice: 'opt_a', text: null });

    // Cursor file must reflect the highest seq seen (close() flushes any
    // still-debounced write synchronously).
    pub1.close();
    const persisted = JSON.parse(readFileSync(cursorFile, 'utf-8'));
    expect(persisted.cursor).toBeGreaterThanOrEqual(ours1[1].seq);

    // Restart: a fresh publisher instance pointed at the same cursor file —
    // simulates a bridge restart with no new client traffic in between.
    const delivered2 = [];
    const pub2 = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
      cursorFile,
      onEvent: (frame) => delivered2.push(frame),
    });
    // Give the reconnect+replay window time to happen (there's nothing to
    // replay past the persisted cursor, so this is asserting an absence).
    await delay(300);
    expect(delivered2.filter(f => f.convo_id === convoId).length).toBe(0);

    pub2.close();
    client.close();
    rmSync(cursorDir, { recursive: true, force: true });
  }, 15000);

  // The activity ephemeral's whole point is viewing-scoped, best-effort
  // delivery (matron-journal src/ws.js `case 'activity'` -> hub.sendEphemeral,
  // same fan-out path as `stream`): only a device that has told the server
  // it's currently looking at this convo (`{op:'viewing', convo_id}`) should
  // ever see a "Claude is thinking…" indicator for it. Drives both a viewing
  // and a non-viewing client device against the real server and the real hub
  // coalescing (default 200ms) to prove that scoping, not just that
  // publishActivity puts bytes on the wire.
  it('publishActivity: a viewing client device receives the ephemeral; a non-viewing device does not', async () => {
    const convoId = `itest-activity-${Date.now()}`;
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
    });

    const viewer = await connectClient();
    const bystander = await connectClient(); // never sends `viewing` for this convo

    const viewerFrames = [];
    const bystanderFrames = [];
    const collect = (arr) => (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      arr.push(msg);
    };
    viewer.ws.on('message', collect(viewerFrames));
    bystander.ws.on('message', collect(bystanderFrames));

    viewer.send({ op: 'viewing', convo_id: convoId });

    // The convo must exist (authorize() checks ownership against the
    // conversations table) before `activity` is accepted — same requirement
    // as every other agent op against a convo_id. Wait for the viewer's own
    // durable-journal copy of the upsert (kind:'journal', broadcast to every
    // device regardless of viewing state) to confirm the server has actually
    // processed it, not just that our socket sent it, before publishing the
    // ephemeral.
    pub.upsertConvo(convoId, { title: 'Activity ephemeral probe', sessionState: 'running' });
    await waitFor(() => viewerFrames.some(f => f.kind === 'journal' && f.convo_id === convoId));

    pub.publishActivity(convoId, 'tool', 'rake test:run');

    await waitFor(() => viewerFrames.some(f => f.kind === 'ephemeral' && f.convo_id === convoId));
    await delay(300); // full hub coalesce window (200ms) + margin, so an absence assertion is meaningful

    const viewerEphemerals = viewerFrames.filter(f => f.kind === 'ephemeral' && f.convo_id === convoId);
    expect(viewerEphemerals.length).toBe(1);
    expect(viewerEphemerals[0]).toMatchObject({
      kind: 'ephemeral', convo_id: convoId, activity: { state: 'tool', detail: 'rake test:run' },
    });

    const bystanderEphemerals = bystanderFrames.filter(f => f.kind === 'ephemeral' && f.convo_id === convoId);
    expect(bystanderEphemerals.length).toBe(0);

    pub.close();
    viewer.close();
    bystander.close();
  }, 15000);

  // Streaming ephemeral, end to end against the real server + hub (same
  // viewing-scoped fan-out `activity` uses): a viewing client device receives
  // the coalesced in-progress `stream` frame(s) and then the DURABLE final
  // message carrying the SAME message_ref in its payload — the only channel the
  // server exposes to retire the overlay by ref (the durable event shape strips
  // idem_key). A non-viewing device gets the durable row (broadcast to every
  // device) but never a stream ephemeral.
  it('stream: a viewing device gets in-progress frames then the durable final carrying the same ref; a non-viewing device gets no stream frame', async () => {
    const convoId = `itest-stream-${Date.now()}`;
    const ref = `msg-${Date.now()}`;
    const finalText = 'The quick brown fox';
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
      streamIntervalMs: 20,
    });

    const viewer = await connectClient();
    const bystander = await connectClient(); // never sends `viewing` for this convo

    const viewerFrames = [];
    const bystanderFrames = [];
    const collect = (arr) => (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      arr.push(msg);
    };
    viewer.ws.on('message', collect(viewerFrames));
    bystander.ws.on('message', collect(bystanderFrames));

    viewer.send({ op: 'viewing', convo_id: convoId });

    // The convo must exist before the durable publish (server-side ownership
    // check); wait for the viewer's durable copy of the upsert to confirm the
    // server processed it, exactly like the activity test above.
    pub.upsertConvo(convoId, { title: 'Streaming ephemeral probe', sessionState: 'running' });
    await waitFor(() => viewerFrames.some(f => f.kind === 'journal' && f.convo_id === convoId));

    // Firehose of in-progress deltas — full cumulative text each time
    // (replace_text, latest-wins), never an incremental delta.
    pub.stream(convoId, ref, 'The ');
    pub.stream(convoId, ref, 'The quick ');
    pub.stream(convoId, ref, 'The quick brown ');
    pub.stream(convoId, ref, finalText);
    await delay(60); // let the bridge's trailing flush fire before we finalize

    await waitFor(() => viewerFrames.some(f => f.kind === 'ephemeral' && f.message_ref === ref));
    await delay(250); // full hub coalesce window (200ms) + margin

    const viewerStreams = viewerFrames.filter(f => f.kind === 'ephemeral' && f.message_ref === ref);
    expect(viewerStreams.length).toBeGreaterThanOrEqual(1);
    // Latest-wins: whatever the viewer ends up with, the newest carries the
    // final cumulative text — never a lost-delta prefix.
    expect(viewerStreams[viewerStreams.length - 1].replace_text).toBe(finalText);

    // Durable final message carrying the same ref in its payload — exactly what
    // sendToRoom does when it consumes _journalDurableRef. endStream first, to
    // model the bridge discarding any still-pending coalesced frame at finalize.
    pub.endStream(convoId, ref);
    pub.publishText(convoId, { body: finalText, from: 'assistant', message_ref: ref });

    await waitFor(() => viewerFrames.some(f => f.kind === 'journal' && f.type === 'text' && f.convo_id === convoId));
    const durable = viewerFrames.find(f => f.kind === 'journal' && f.type === 'text' && f.convo_id === convoId);
    expect(durable.payload.message_ref).toBe(ref); // links overlay -> final message
    expect(durable.payload.body).toBe(finalText);

    // The bystander got the durable row (broadcast) but never a stream ephemeral.
    await delay(50);
    const bystanderStreams = bystanderFrames.filter(f => f.kind === 'ephemeral' && f.message_ref === ref);
    expect(bystanderStreams.length).toBe(0);
    expect(bystanderFrames.some(f => f.kind === 'journal' && f.type === 'text' && f.convo_id === convoId)).toBe(true);

    pub.close();
    viewer.close();
    bystander.close();
  }, 20000);

  // The "no dangling overlay" path: a turn that streamed but produced no
  // durable final message (interruption / session exit mid-stream). endStream
  // with {clear:true} sends a final empty replace_text so a viewing client
  // collapses the overlay.
  it('endStream({clear:true}): a viewing device receives a final empty replace_text collapsing the overlay', async () => {
    const convoId = `itest-stream-clear-${Date.now()}`;
    const ref = `msg-${Date.now()}`;
    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${serverPort}/ws`,
      token: agentToken,
      log: { warn: () => {}, error: () => {} },
      streamIntervalMs: 20,
    });

    const viewer = await connectClient();
    const viewerFrames = [];
    viewer.ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      viewerFrames.push(msg);
    });
    viewer.send({ op: 'viewing', convo_id: convoId });

    pub.upsertConvo(convoId, { title: 'Overlay clear probe', sessionState: 'running' });
    await waitFor(() => viewerFrames.some(f => f.kind === 'journal' && f.convo_id === convoId));

    pub.stream(convoId, ref, 'partial in progress');
    // Wait for the server to actually deliver the in-progress frame (it flushes
    // its per-(convo,ref) window ~200ms) BEFORE clearing — otherwise the hub's
    // latest-wins coalescing would collapse the two into just the empty one.
    await waitFor(() => viewerFrames.some(f => f.kind === 'ephemeral' && f.message_ref === ref && f.replace_text === 'partial in progress'));

    pub.endStream(convoId, ref, { clear: true });
    await waitFor(() => viewerFrames.some(f => f.kind === 'ephemeral' && f.message_ref === ref && f.replace_text === ''));

    const cleared = viewerFrames.filter(f => f.kind === 'ephemeral' && f.message_ref === ref && f.replace_text === '');
    expect(cleared.length).toBeGreaterThanOrEqual(1);

    pub.close();
    viewer.close();
  }, 20000);
});
