#!/usr/bin/env node
// PreToolUse hook the bridge adds (inline --settings) to gated print-mode
// sessions, on `mcp__.*`. It asks the bridge's permission classifier
// (POST /permission-check) whether this MCP call is allowed, denied, or needs
// the user, and prints the matching permissionDecision. Fail CLOSED: any error,
// timeout, or odd response prints "ask", never "allow". Infra MCP tools
// (ask-user, show-file) and non-MCP tools pass through with no output.
import {
  isGatedMcpTool,
  permissionGateHookOutput,
  PERMISSION_GATE_FETCH_TIMEOUT_MS,
} from '../lib/permission-prompt.js';

function bridgeApiBase(env) {
  if (env.BRIDGE_API_URL) return env.BRIDGE_API_URL.replace(/\/+$/, '');
  return `http://127.0.0.1:${env.MATRON_BRIDGE_API_PORT || '9802'}`;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  let toolName;
  try {
    toolName = JSON.parse(await readStdin())?.tool_name;
  } catch {
    // Unparseable hook input: we cannot tell what is being called. Ask.
    return permissionGateHookOutput(null);
  }
  if (!isGatedMcpTool(toolName)) return null;
  try {
    const res = await fetch(`${bridgeApiBase(process.env)}/permission-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId: process.env.BRIDGE_ROOM_ID || null, toolName }),
      signal: AbortSignal.timeout(PERMISSION_GATE_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return permissionGateHookOutput(null);
    return permissionGateHookOutput(await res.json());
  } catch {
    return permissionGateHookOutput(null);
  }
}

let output;
try {
  output = await main();
} catch {
  output = permissionGateHookOutput(null);
}
if (output) process.stdout.write(JSON.stringify(output));
process.exit(0);
