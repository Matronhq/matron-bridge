import { randomUUID } from 'node:crypto';
import { withCodexAppServer } from './codex-account.js';

// Listing is read-only. Native CLI/desktop/exec threads are included; Codex's
// own subagents are intentionally not offered as resumable parent sessions.
export async function listCodexThreads(cwd, { query = withCodexAppServer, limit = 150 } = {}) {
  return query(async request => {
    const threads = [];
    const seen = new Set();
    let cursor;
    do {
      const page = await request('thread/list', { ...(cwd ? { cwd } : {}),
        sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], archived: false,
        sortKey: 'updated_at', limit: Math.min(100, limit - threads.length), ...(cursor ? { cursor } : {}) });
      threads.push(...(page.data || []).map(t => ({ sessionId: t.id, workdir: t.cwd,
        summary: String(t.name || t.preview || '').slice(0, 200), modified: t.updatedAt * 1000,
        native: true })));
      cursor = page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex repeated a thread-list cursor.');
      seen.add(cursor);
    } while (cursor && threads.length < limit);
    return threads.slice(0, limit);
  }, { cwd });
}

export function mergeCodexThreads(native, persisted) {
  const byId = new Map(native.map(t => [t.sessionId, t]));
  for (const entry of persisted) byId.set(entry.sessionId, { ...byId.get(entry.sessionId), ...entry });
  return [...byId.values()].sort((a, b) => Number(b.modified) - Number(a.modified));
}

export function offerCodexBuild(session) {
  if (!session.alive || session.busy || !session.codex?.planMode || !session._codexHadAssistantMessage || !session.sendButtonMessage) return;
  // A plan's unanswered async question remains actionable after turn end.
  // Publishing Build now would supersede its journal prompt sequence.
  if (session.codexPrompts?.active) return;
  const value = `codex-build:${randomUUID()}`;
  session._codexBuildValue = value;
  const message = 'Plan ready. Choose Build to leave read-only mode and implement it, or send changes to the plan.';
  return session.sendButtonMessage(message, [{ id: 'prompt-opt-0', label: 'Build', value }], 'pick_one', message, message);
}

export async function handleCodexControl(session, text, { reply, status = () => {}, persist = () => {}, send, beforeDispatch = () => {} } = {}) {
  if (session.codex?.transport !== 'app-server') return false;
  const [word, ...args] = text.trim().split(/\s+/);
  const cmd = word.toLowerCase().replace(/^!/, '/');
  const codex = session.codex;
  const recognized = ['/mcp', '/tools', '/mode', '/login', '/logout', '/plan', '/compact', '/show_bash', '/show_bash_output', '/bash_output'];
  if (!recognized.includes(cmd) && !(cmd === 'build' && args.length === 0 && codex.planMode && !session.codexPrompts?.active)) return false;
  if (cmd === '/compact' && session.busy) return false; // existing compact-priority queue
  beforeDispatch();
  try {
    if (['/mode', '/plan', 'build', '/compact', '/login', '/logout'].includes(cmd) && session.busy) {
      await reply('Finish or interrupt the current Codex turn first.');
      return true;
    }
    if (cmd === '/show_bash' || cmd === '/show_bash_output' || cmd === '/bash_output') {
      session.showBashOutput = !session.showBashOutput;
      persist({ showBashOutput: session.showBashOutput });
      await reply(`Command output: ${session.showBashOutput ? 'ON' : 'OFF'} (applies immediately).`);
    } else if (cmd === '/mode' || cmd === '/plan' || cmd === 'build') {
      const target = cmd === 'build' ? 'default' : cmd === '/plan' ? (args[0] === 'off' ? 'default' : 'plan') : args[0];
      if (!target) {
        await reply(`Codex mode: ${codex.planMode ? 'Plan (read-only)' : 'Build'} via app-server. Use /mode plan or /mode default.`);
      } else if (!['plan', 'default', 'build'].includes(target)) {
        await reply('Usage: /mode plan | /mode default. Codex uses native app-server controls, not a terminal UI.');
      } else {
        codex.planMode = target === 'plan';
        session._codexBuildValue = null;
        persist({ codexPlanMode: codex.planMode });
        status(session);
        if (cmd === 'build') send('Implement the agreed plan. Matron Build mode is now active.');
        else if (cmd === '/plan' && args.length && args[0] !== 'off') send(text.trim().slice(word.length).trim());
        else await reply(codex.planMode
          ? 'Plan mode enabled: read-only sandbox, no escalations, and MCP tools disabled. Send the task to plan; choose Build when ready.'
          : 'Build mode enabled. Normal sandbox rules and approval cards apply.');
      }
    } else if (cmd === '/compact') {
      if (args.length) await reply('Native Codex compaction does not accept custom instructions. Use /compact by itself.');
      else send('/compact');
    } else if (cmd === '/mcp' || cmd === '/tools') {
      if (!session.busy) await codex.ensureThread();
      const servers = [];
      let cursor;
      const seen = new Set();
      do {
        const page = await codex.rpc('mcpServerStatus/list', { threadId: codex.threadId, limit: 100,
          detail: 'toolsAndAuthOnly', ...(cursor ? { cursor } : {}) });
        servers.push(...(page.data || []));
        cursor = page.nextCursor;
        if (seen.has(cursor) || seen.size >= 20) break;
        seen.add(cursor);
      } while (cursor);
      const lines = servers.map(s => cmd === '/tools'
        ? `${s.name}: ${Object.keys(s.tools || {}).join(', ') || '(no tools)'}`
        : `${s.name}: ${s.runtimeStatus?.status || s.runtimeStatus?.type || s.authStatus || 'unknown'} · ${Object.keys(s.tools || {}).length} tools`);
      await reply((cmd === '/tools' ? 'Codex native tools include shell, patches, search, and images when supported by the selected model.\n\nMCP tools:\n' : 'Codex MCP servers:\n')
        + (lines.join('\n') || '(none available)'));
    } else if (cmd === '/login') {
      if (args[0] === 'cancel') {
        if (session._codexLoginId) await codex.rpc('account/login/cancel', { loginId: session._codexLoginId });
        session._codexLoginId = null;
        await reply('Codex login cancelled.');
      } else {
        if (session._codexLoginId) await codex.rpc('account/login/cancel', { loginId: session._codexLoginId });
        const result = await codex.rpc('account/login/start', { type: 'chatgptDeviceCode' });
        session._codexLoginId = result.loginId;
        const url = new URL(result.verificationUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Codex returned an invalid login URL.');
        await reply(`Sign in to Codex at ${url.href}\nCode: ${result.userCode}\n\nThis changes the Codex account for this OS user, shared by its sessions. /login cancel cancels.`);
      }
    } else if (cmd === '/logout') {
      await codex.rpc('account/logout');
      session._codexLoginId = null;
      session._codexMetadata = null;
      status(session);
      await reply('Logged out of Codex for this OS user. Existing sessions share this account; use /login to sign in again.');
    }
  } catch (error) {
    await reply(`Codex ${cmd}: ${session.codexSafeOutput?.(error.message) || 'request failed'}`);
  }
  return true;
}
