// App-only Claude sign-in. Terminal output, codes and account details never
// enter a conversation or a log. The CLI owns OAuth and credential storage.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { ensureSpawnHelperExecutable, resolveNodePtyDir } from './pty-spawn-helper.js';
import { compactScreenText } from './prompt-detector.js';

export function claudeAuthorizationURL(text) {
  const clean = stripVTControlCharacters(text);
  for (const match of clean.matchAll(/(https:\/\/[^\s<>"']+)[\s<>"']/g)) {
    const candidate = match[1];
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' && !url.username && !url.password && !url.port
        && ((url.hostname === 'claude.ai' && url.pathname === '/oauth/authorize')
          || (url.hostname === 'claude.com' && url.pathname === '/cai/oauth/authorize'))
        && url.searchParams.has('state') && url.searchParams.has('code_challenge')) return url.href;
    } catch { /* incomplete terminal chunk */ }
  }
  return null;
}

const loginEnvironment = () => {
  const env = { ...process.env, BROWSER: 'true', NO_COLOR: '1' };
  delete env.CLAUDECODE;
  return env;
};

export function readClaudeConnection() {
  return new Promise((resolve) => {
    execFile('claude', ['auth', 'status', '--json'],
      { timeout: 8000, maxBuffer: 64 * 1024, env: loginEnvironment() }, (error, stdout) => {
        try {
          const status = JSON.parse(stdout);
          if (typeof status.loggedIn === 'boolean') {
            resolve({ state: !error && status.loggedIn ? 'connected' : 'disconnected' });
            return;
          }
        } catch { /* only a typed status is evidence */ }
        resolve({ state: 'unavailable' });
      });
  });
}

async function launchClaudeLogin() {
  ensureSpawnHelperExecutable({ ptyDir: resolveNodePtyDir() });
  const pty = await import('node-pty');
  return pty.spawn('claude', ['auth', 'login', '--claudeai'], {
    name: 'xterm-256color', cols: 4096, rows: 30, env: loginEnvironment(),
  });
}

export function createClaudeSetup({ readConnection = readClaudeConnection,
  launch = launchClaudeLogin, now = Date.now, ttlMs = 10 * 60 * 1000 } = {}) {
  let flow = null;
  let starting = false;
  let disposed = false;
  let reading = null;
  const connection = () => {
    if (!reading) reading = Promise.resolve().then(readConnection)
      .catch(() => ({ state: 'unavailable' })).finally(() => { reading = null; });
    return reading;
  };
  const stop = (f, state) => {
    clearTimeout(f.timer);
    f.state = state;
    f.url = null;
    f.output = '';
    const proc = f.proc;
    f.proc = null;
    try { proc?.kill(); } catch { /* already exited */ }
  };
  const snapshot = (f) => ({ state: f.state, flow_id: f.id,
    expires_at: f.expiresAt, ...(f.url ? { authorization_url: f.url } : {}) });
  const owns = (owner, id) => flow && flow.owner === owner && flow.id === id;

  return {
    async request(owner, params = {}) {
      if (disposed) return { state: 'unavailable' };
      if (!Number.isSafeInteger(owner) || owner < 1) return { state: 'refused' };
      if (flow && now() >= flow.expiresAt && flow.proc) stop(flow, 'expired');
      const action = params.action || 'status';
      if (!['status', 'start', 'submit', 'cancel'].includes(action)) return { state: 'invalid_request' };
      if (action === 'cancel') {
        if (!owns(owner, params.flow_id)) return { state: 'expired' };
        stop(flow, 'cancelled');
        return snapshot(flow);
      }
      if (action === 'submit') {
        if (!owns(owner, params.flow_id) || !flow.proc) return { state: 'expired' };
        // A code is one bounded opaque line, never shell syntax or terminal
        // controls. It travels only over RPC and the child's PTY stdin.
        if (typeof params.code !== 'string' || !/^[A-Za-z0-9_#.-]{16,2048}$/.test(params.code)) {
          return { state: 'invalid_code', flow_id: flow.id };
        }
        if (!['waiting', 'invalid_code'].includes(flow.state)) return snapshot(flow);
        flow.state = 'checking';
        flow.url = null;
        flow.output = '';
        try { flow.proc.write(params.code + '\r'); }
        catch { stop(flow, 'failed'); }
        return snapshot(flow);
      }
      const status = await connection();
      if (disposed) return { state: 'unavailable' };
      if (status.state === 'connected') {
        if (flow?.proc) stop(flow, 'connected');
        return { state: 'connected' };
      }
      if (action === 'status') {
        if (owns(owner, params.flow_id)) return snapshot(flow);
        return params.flow_id ? { state: 'expired' } : status;
      }
      if (status.state === 'unavailable') return status;
      if (starting || (flow?.proc && flow.owner !== owner)) return { state: 'busy' };
      if (flow?.proc) return snapshot(flow); // retries reuse the same login
      starting = true;
      try {
        const f = { id: randomUUID(), owner, state: 'starting', url: null, output: '',
          expiresAt: now() + ttlMs, proc: null, timer: null };
        flow = f;
        const proc = await launch();
        f.proc = proc;
        if (disposed) { stop(f, 'cancelled'); return { state: 'unavailable' }; }
        f.timer = setTimeout(() => stop(f, 'expired'), ttlMs);
        f.timer.unref?.();
        f.proc.onData((chunk) => {
          if (flow !== f || !f.proc || !['starting', 'waiting', 'checking', 'invalid_code'].includes(f.state)) return;
          f.output = (f.output + chunk).slice(-16 * 1024);
          if (f.state === 'checking') {
            // This buffer starts at the submitted code, so an error just
            // before a repainted paste prompt is still the current error.
            const compact = compactScreenText(f.output);
            if (['thatcodewasntaccepted', 'makesurethefullcodewascopied', 'invalidauthorizationcode', 'invalidcode']
              .some(text => compact.includes(text))) {
              f.state = 'invalid_code';
              f.output = '';
            }
            return;
          }
          const url = claudeAuthorizationURL(f.output);
          if (url) { f.url = url; f.state = 'waiting'; }
        });
        f.proc.onExit(async () => {
          if (flow !== f || !f.proc) return;
          clearTimeout(f.timer);
          f.proc = null;
          f.url = null;
          f.output = '';
          f.state = 'checking';
          const result = await connection();
          if (flow === f && f.state === 'checking') f.state = result.state === 'connected' ? 'connected' : 'failed';
        });
        return snapshot(f);
      } catch {
        if (flow) stop(flow, 'failed');
        return { state: 'failed' };
      } finally { starting = false; }
    },
    dispose() { disposed = true; if (flow) stop(flow, 'cancelled'); },
  };
}
