import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import net from 'node:net';
import { createJournalPublisher } from '../lib/journal-publisher.js';

const silentLog = { info() {}, warn() {}, error() {} };

// A minimal CONNECT proxy: records each tunnel target, then pipes bytes.
function startConnectProxy() {
  const targets = [];
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, clientSocket, head) => {
    targets.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, targets, port: server.address().port })));
}

function startWsServer() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve(wss));
  });
}

function waitFor(cond, ms = 3000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > ms) return reject(new Error('timed out'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('journal publisher behind an egress proxy', () => {
  const cleanup = [];
  afterEach(() => { while (cleanup.length) cleanup.pop()(); });

  it('tunnels the journal websocket through HTTP_PROXY when one is set', async () => {
    const proxy = await startConnectProxy();
    const wss = await startWsServer();
    cleanup.push(() => proxy.server.close(), () => wss.close());
    let connections = 0;
    wss.on('connection', () => { connections += 1; });
    const target = `127.0.0.1:${wss.address().port}`;

    const pub = createJournalPublisher({
      url: `ws://${target}/ws`,
      token: 'tok',
      log: silentLog,
      proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` },
    });
    cleanup.push(() => pub.close());

    await waitFor(() => connections > 0);
    expect(proxy.targets).toEqual([target]);
  });

  it('connects directly when no proxy is set', async () => {
    const proxy = await startConnectProxy();
    const wss = await startWsServer();
    cleanup.push(() => proxy.server.close(), () => wss.close());
    let connections = 0;
    wss.on('connection', () => { connections += 1; });

    const pub = createJournalPublisher({
      url: `ws://127.0.0.1:${wss.address().port}/ws`,
      token: 'tok',
      log: silentLog,
      proxyEnv: {},
    });
    cleanup.push(() => pub.close());

    await waitFor(() => connections > 0);
    expect(proxy.targets).toEqual([]);
  });
});
