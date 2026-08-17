import { describe, it, expect } from 'vitest';
import {
  decidePermissionOutcome,
  listSessionGrants,
  revokeSessionGrant,
  DENY_MESSAGE,
} from '../lib/permission-prompt.js';
import { buildPermissionSnapshot } from '../lib/permission-eval.js';

// Build a snapshot from an in-memory settings object (no disk), via a temp-free
// path: buildPermissionSnapshot reads files, so instead we hand-roll the frozen
// snapshot shape the classifier consumes. This keeps the decision tests pure and
// independent of the filesystem while matching buildPermissionSnapshot's output.
function snapshot({ allow = [], deny = [], ask = [], uncertain = false } = {}) {
  return Object.freeze({
    mcpAllow: Object.freeze([...allow]),
    mcpDeny: Object.freeze([...deny]),
    mcpAsk: Object.freeze([...ask]),
    uncertain,
  });
}

describe('decidePermissionOutcome — classifier → POST /permission-request response', () => {
  it('allow: exact-tool allow rule → silent {behavior:allow}, no card', () => {
    const snap = snapshot({ allow: ['mcp__webflow__pages_get'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_get');
    expect(out.kind).toBe('allow');
    expect(out.body).toEqual({ behavior: 'allow' });
    expect(out.notice).toBeUndefined();
  });

  it('deny: exact-tool deny → {behavior:deny, DENY_MESSAGE} AND a visible room notice', () => {
    const snap = snapshot({ deny: ['mcp__webflow__pages_delete'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_delete');
    expect(out.kind).toBe('deny');
    expect(out.body).toEqual({ behavior: 'deny', message: DENY_MESSAGE });
    expect(out.notice).toBe('⛔ blocked `mcp__webflow__pages_delete` by policy');
  });

  it('deny: server-wide deny rule denies every tool on that server', () => {
    const snap = snapshot({ deny: ['mcp__webflow__*'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('deny');
  });

  it('ask: exact-tool ask rule → falls through to the card (kind:card)', () => {
    const snap = snapshot({ ask: ['mcp__webflow__pages_update'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
    expect(out.body).toBeUndefined();
  });

  it('default-gated: no matching rule → card (server-wide allow never widens)', () => {
    const snap = snapshot({ allow: ['mcp__webflow__*'] });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
  });

  it('fail-closed: an uncertain snapshot never silently allows', () => {
    // Even with a server-wide allow present, uncertainty forces default-gated →
    // a card, never a silent allow.
    const snap = snapshot({ allow: ['mcp__webflow__*'], uncertain: true });
    const out = decidePermissionOutcome(snap, 'mcp__webflow__pages_update');
    expect(out.kind).toBe('card');
  });

  it('deny beats ask when both match (restrictive wins)', () => {
    const snap = snapshot({
      deny: ['mcp__webflow__pages_delete'],
      ask: ['mcp__webflow__pages_delete'],
    });
    expect(decidePermissionOutcome(snap, 'mcp__webflow__pages_delete').kind).toBe('deny');
  });

  it('integrates with buildPermissionSnapshot output shape', () => {
    // buildPermissionSnapshot() with no source files returns just the baseline
    // (no mcp allow/deny/ask beyond the default show-file entry) → any webflow
    // tool is default-gated → card.
    const snap = buildPermissionSnapshot({ sourcePaths: [] });
    expect(decidePermissionOutcome(snap, 'mcp__webflow__pages_get').kind).toBe('card');
  });
});

describe('session grant helpers (!permissions list + revoke; Always-allow write path)', () => {
  it('listSessionGrants returns a sorted snapshot of the live Set', () => {
    const set = new Set(['mcp__b__y', 'mcp__a__x']);
    expect(listSessionGrants(set)).toEqual(['mcp__a__x', 'mcp__b__y']);
  });

  it('listSessionGrants tolerates a missing/undefined Set', () => {
    expect(listSessionGrants(undefined)).toEqual([]);
    expect(listSessionGrants(null)).toEqual([]);
  });

  it('Always-allow write path: the same Set the card tap writes is listed then revoked', () => {
    // The card's "Always allow (session)" tap does session.permAllowedTools.add(name);
    // model that write, then exercise list + revoke over the same Set.
    const permAllowedTools = new Set();
    permAllowedTools.add('mcp__webflow__pages_get'); // <- what the button tap does
    expect(listSessionGrants(permAllowedTools)).toEqual(['mcp__webflow__pages_get']);

    const removed = revokeSessionGrant(permAllowedTools, 'mcp__webflow__pages_get');
    expect(removed).toBe(true);
    expect(listSessionGrants(permAllowedTools)).toEqual([]);
  });

  it('revokeSessionGrant returns false for a name that was never granted', () => {
    const set = new Set(['mcp__webflow__pages_get']);
    expect(revokeSessionGrant(set, 'mcp__webflow__pages_delete')).toBe(false);
    expect(set.has('mcp__webflow__pages_get')).toBe(true);
  });

  it('revokeSessionGrant is a safe no-op on a missing Set or bad name', () => {
    expect(revokeSessionGrant(undefined, 'mcp__x__y')).toBe(false);
    expect(revokeSessionGrant(new Set(), 42)).toBe(false);
  });
});
