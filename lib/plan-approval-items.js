// Plan approvals mirrored into the task & decision tracker (item #2317,
// Dan 2026-09-22: "ok yes all good"; the journal does the same for spawn
// and agent-chat consent cards, matron-journal PR 83). A "📋 Plan Ready —
// reply build" card is a consent ask that can sit for hours in one
// conversation's timeline; the Decisions list is where the user looks. So
// every plan card also files a `question` item on the session's journal
// conversation, and whatever settles the plan closes it: `build` (in the
// conversation, or as a reply on the item itself) → decided; the iv-mode
// hook timing out → cancelled; a newer plan replacing it → cancelled.
//
// The item is a mirror of the session's own pending-plan state
// (session.pendingPlan / pendingPlanDenialId / ivPendingPlanToolUseId),
// never a second source of truth. Everything I/O-shaped is injected, same
// discipline as lib/secret-requests.js; every method is best-effort and
// never throws — a tracker failure must never cost the plan flow.

import { isPlanBuildText } from './command-dispatch.js';

// A plan is the agent's own markdown for the user, so it renders as
// markdown — unlike another agent's peer text, which the journal fences.
// The tracker's body cap is 32 KiB; stay well under it and say when cut.
export const PLAN_BODY_MAX = 8000;

export function formatPlanItemBody({ plan }) {
  let text = typeof plan === 'string' ? plan : '';
  if (text.length > PLAN_BODY_MAX) {
    text = `${text.slice(0, PLAN_BODY_MAX)}\n\n_(plan truncated here — the conversation has the whole of it)_`;
  }
  return [
    text,
    '',
    '---',
    '**To answer:** reply `build` — here on this item, or in the conversation — to execute the plan. Anything else you reply in the conversation is feedback, and the agent will come back with a revised plan (which replaces this item).',
  ].join('\n');
}

function closing(outcome) {
  switch (outcome) {
    case 'build': return { resolution: 'decided', comment: 'Approved — building.' };
    case 'timeout': return { resolution: 'cancelled', comment: 'Timed out — no answer within 29 min; the plan was not executed.' };
    case 'superseded': return { resolution: 'cancelled', comment: 'Replaced by a newer plan.' };
    default: return { resolution: 'cancelled', comment: `Closed — ${outcome}.` };
  }
}

export function createPlanApprovalItems({
  // The lib/items-client.js subset this needs: create + close.
  items,
  // (session) -> journal conversation id | null.
  journalConvoIdFor,
  // (session, planItemId | null) -> void. index.js persists it next to
  // pendingPlanDenialId so a restart finds the item to close.
  persist = () => {},
  now = () => Date.now(),
  log = console,
} = {}) {
  function warn(msg) {
    try { log.warn(msg); } catch { /* logging must never throw */ }
  }

  function remember(session, planItemId) {
    session.planItemId = planItemId;
    try { persist(session, planItemId); } catch (e) { warn(`[plan-items] persist failed: ${e?.message ?? e}`); }
  }

  async function closeOpen(session, outcome) {
    const id = session.planItemId;
    if (!id) return;
    remember(session, null);
    const { resolution, comment } = closing(outcome);
    try {
      const res = await items.close(id, { resolution, comment });
      if (res?.status !== 200 && res?.status !== 409) warn(`[plan-items] close of ${id} answered ${res?.status ?? '?'}: ${res?.data?.error ?? ''}`);
    } catch (e) {
      warn(`[plan-items] close of ${id} failed: ${e?.message ?? e}`);
    }
  }

  return {
    // A plan card was just posted. Returns the item number, or null when
    // nothing was filed (no journal conversation yet, journal refused).
    async opened(session, plan) {
      try {
        await closeOpen(session, 'superseded');
        const convoId = journalConvoIdFor(session);
        if (!convoId) return null;
        const res = await items.create({
          kind: 'question',
          title: 'Plan ready — reply build to execute it, or send feedback',
          body: formatPlanItemBody({ plan }),
          labels: ['plan'],
          convo_id: convoId,
        }, { idemKey: `plan:${session.roomId}:${now()}` });
        const item = res?.data?.item;
        if ((res?.status === 200 || res?.status === 201) && item?.id) {
          remember(session, item.id);
          return Number.isInteger(item.num) ? item.num : null;
        }
        warn(`[plan-items] create answered ${res?.status ?? '?'}: ${res?.data?.error ?? ''}`);
        return null;
      } catch (e) {
        warn(`[plan-items] create failed: ${e?.message ?? e}`);
        return null;
      }
    },

    // The pending plan was settled: 'build' | 'timeout'.
    async resolved(session, outcome) {
      try { await closeOpen(session, outcome); } catch (e) { warn(`[plan-items] resolve failed: ${e?.message ?? e}`); }
    },

    // Is this item marker the user replying `build` on THIS session's open
    // plan item? The caller then approves the plan exactly as a `build` in
    // the conversation would, instead of injecting the reply as a turn.
    isBuildReply(session, payload) {
      if (!session?.planItemId || !payload || typeof payload !== 'object') return false;
      if (payload.item_id !== session.planItemId) return false;
      if (payload.action !== 'commented' || payload.by !== 'user') return false;
      return isPlanBuildText(payload.comment?.body);
    },
  };
}
