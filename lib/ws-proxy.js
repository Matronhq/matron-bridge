// Proxy support for the bridge's outgoing WebSockets.
//
// `ws` never consults HTTPS_PROXY: it supplies its own createConnection, and
// Node applies NODE_USE_ENV_PROXY only through the global agent, which ws
// bypasses. A bridge on a box whose only way out is an egress proxy (a
// locked-down box) therefore needs an explicit
// agent. wsProxyOptions(url, env) returns { agent } when the environment
// names a proxy for the URL's scheme and NO_PROXY does not exempt its host,
// otherwise {} (a direct connection, exactly as before).
import { HttpsProxyAgent } from 'https-proxy-agent';

function envVar(env, name) {
  return env[name.toUpperCase()] || env[name.toLowerCase()] || '';
}

// A NO_PROXY entry is a host, a .suffix or *, optionally with a port:
// "host:8080", "[::1]:8080". A bare IPv6 literal ("::1") has no port. An
// entry with a port exempts only that port.
function parseEntry(entry) {
  const bracketed = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) return { host: bracketed[1], port: bracketed[2] || '' };
  const withPort = entry.match(/^([^:]+):(\d+)$/);
  if (withPort) return { host: withPort[1], port: withPort[2] };
  return { host: entry, port: '' };
}

function exempt(target, noProxy) {
  const h = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const port = target.port || (target.protocol === 'wss:' ? '443' : '80');
  return noProxy.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).some((entry) => {
    if (entry === '*') return true;
    const { host, port: entryPort } = parseEntry(entry);
    if (entryPort && entryPort !== port) return false;
    if (host.startsWith('.')) return h.endsWith(host) || h === host.slice(1);
    return h === host || h.endsWith(`.${host}`);
  });
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function wsProxyOptions(url, env = process.env) {
  let target;
  try { target = new URL(url); } catch { return {}; }
  const proxy = envVar(env, target.protocol === 'wss:' ? 'https_proxy' : 'http_proxy');
  if (!proxy || exempt(target, envVar(env, 'no_proxy'))) return {};
  let proxyUrl;
  try { proxyUrl = new URL(proxy); } catch { return {}; }
  // Credentials in an http: proxy URL would cross the network in a cleartext
  // Proxy-Authorization header; allow them only to a proxy on this machine.
  if (proxyUrl.protocol === 'http:' && (proxyUrl.username || proxyUrl.password)
      && !LOOPBACK.has(proxyUrl.hostname)) {
    throw new Error('refusing to send proxy credentials over a cleartext http: proxy that is not on loopback');
  }
  return { agent: new HttpsProxyAgent(proxy) };
}
