import { describe, it, expect } from 'vitest';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { wsProxyOptions } from '../lib/ws-proxy.js';

describe('wsProxyOptions', () => {
  it('connects directly when no proxy is set', () => {
    expect(wsProxyOptions('wss://chat.example.com/ws', {})).toEqual({});
  });

  it('tunnels wss through HTTPS_PROXY', () => {
    const opts = wsProxyOptions('wss://chat.example.com/ws', { HTTPS_PROXY: 'http://127.0.0.1:8888' });
    expect(opts.agent).toBeInstanceOf(HttpsProxyAgent);
    expect(opts.agent.proxy.href).toBe('http://127.0.0.1:8888/');
  });

  it('accepts the lower-case variable, upper case winning', () => {
    expect(wsProxyOptions('wss://a.example/ws', { https_proxy: 'http://p:1' }).agent.proxy.host).toBe('p:1');
    expect(wsProxyOptions('wss://a.example/ws', { https_proxy: 'http://p:1', HTTPS_PROXY: 'http://q:2' }).agent.proxy.host).toBe('q:2');
  });

  it('tunnels plain ws through HTTP_PROXY, not HTTPS_PROXY', () => {
    expect(wsProxyOptions('ws://a.example/ws', { HTTPS_PROXY: 'http://p:1' })).toEqual({});
    expect(wsProxyOptions('ws://a.example/ws', { HTTP_PROXY: 'http://p:1' }).agent.proxy.host).toBe('p:1');
  });

  it('honours NO_PROXY: exact hosts, domain suffixes, *, and loopback', () => {
    const env = { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'localhost,127.0.0.1,.internal.example,other.example' };
    expect(wsProxyOptions('ws://127.0.0.1:9000/ws', env)).toEqual({});
    expect(wsProxyOptions('wss://localhost/ws', env)).toEqual({});
    expect(wsProxyOptions('wss://a.internal.example/ws', env)).toEqual({});
    expect(wsProxyOptions('wss://other.example/ws', env)).toEqual({});
    expect(wsProxyOptions('wss://notother.example/ws', env).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('wss://chat.example.com/ws', { ...env, NO_PROXY: '*' })).toEqual({});
  });

  it('ignores an unparseable proxy rather than throwing at connect', () => {
    expect(wsProxyOptions('wss://a.example/ws', { HTTPS_PROXY: 'not a url' })).toEqual({});
  });
  it('exempts a port-qualified NO_PROXY entry only on that port', () => {
    const env = { HTTPS_PROXY: 'http://p:1', HTTP_PROXY: 'http://p:1', NO_PROXY: 'internal.example:8080' };
    expect(wsProxyOptions('wss://internal.example:8080/ws', env)).toEqual({});
    expect(wsProxyOptions('wss://internal.example/ws', env).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('ws://internal.example:443/ws', env).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('wss://internal.example/ws', { ...env, NO_PROXY: 'internal.example:443' })).toEqual({});
  });

  it('matches IPv6 NO_PROXY entries, bare or bracketed with a port', () => {
    const env = { HTTP_PROXY: 'http://p:1' };
    expect(wsProxyOptions('ws://[::1]:9000/ws', { ...env, NO_PROXY: '::1' })).toEqual({});
    expect(wsProxyOptions('ws://[::1]:9000/ws', { ...env, NO_PROXY: '[::1]:9000' })).toEqual({});
    expect(wsProxyOptions('ws://[::1]:9001/ws', { ...env, NO_PROXY: '[::1]:9000' }).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('ws://[fe80::1]:9000/ws', { ...env, NO_PROXY: 'fe80::1' })).toEqual({});
  });

  it('refuses credentials over a cleartext proxy that is not on loopback', () => {
    expect(() => wsProxyOptions('wss://a.example/ws', { HTTPS_PROXY: 'http://u:pw@proxy.example:3128' })).toThrow(/cleartext/);
    expect(wsProxyOptions('wss://a.example/ws', { HTTPS_PROXY: 'http://u:pw@127.0.0.1:8888' }).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('wss://a.example/ws', { HTTPS_PROXY: 'https://u:pw@proxy.example:3128' }).agent).toBeInstanceOf(HttpsProxyAgent);
    expect(wsProxyOptions('wss://a.example/ws', { HTTPS_PROXY: 'http://proxy.example:3128' }).agent).toBeInstanceOf(HttpsProxyAgent);
  });
});
