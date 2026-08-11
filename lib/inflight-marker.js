// In-flight turn markers — the detection half of restart carry-on prompts
// (docs/superpowers/specs/2026-08-11-restart-carry-on-design.md).
//
// A bridge restart SIGTERMs every live session (index.js signal handlers), so
// a turn that was running is destroyed. Nothing was published into the chat,
// so the interruption is silent. This store is what lets the next boot know
// which conversations were mid-turn.
//
// The marker is written at TURN START and removed at turn end — deliberately
// not snapshotted in the SIGTERM handler. A shutdown snapshot is cheaper (one
// write per restart instead of one per turn boundary) but writes nothing on an
// OOM, a crash, or kill -9, which are exactly the cases where the user has no
// other signal. Writing at turn start means nothing has to run at shutdown for
// the record to survive.
//
// Boot discrimination is by `bootId`: a randomUUID generated once per bridge
// process and stamped into every record. At boot, any record carrying a
// DIFFERENT bootId belongs to a run that no longer exists. That is the whole
// mechanism — no transcript scanning, no inference about what a partial
// transcript means.
//
// Pure with every impure edge injected (load/save/now/bootId/log), the same
// shape as createTimerStore in lib/timer-command.js, so it unit-tests without
// a live bridge.

// Age is measured from `touchedAt`, refreshed as the turn makes progress,
// rather than from `startedAt`. The question being asked is "how long has this
// conversation been dangling", not "how long did the turn run" — a legitimate
// three-hour turn still working one minute before the crash must be carded,
// and measuring from turn start would suppress it as ancient.
const DEFAULT_TOUCH_DEBOUNCE_MS = 60_000;

function isUsableRecord(rec) {
  return !!rec && typeof rec === 'object'
    && typeof rec.bootId === 'string'
    && Number.isFinite(rec.touchedAt);
}

export function createInflightMarker({
  load,
  save,
  now,
  bootId,
  touchDebounceMs = DEFAULT_TOUCH_DEBOUNCE_MS,
  log = () => {},
}) {
  let records = (() => {
    try {
      const raw = load();
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...raw };
    } catch (e) {
      log(`inflight marker load failed: ${e.message}`);
    }
    return {};
  })();

  function persist() {
    try {
      save(records);
    } catch (e) {
      // A lost marker means a missed card, never a broken turn — the caller is
      // on the turn-start path and must not be disturbed by a disk problem.
      log(`inflight marker save failed: ${e.message}`);
    }
  }

  return {
    noteTurnStart(convoId, roomId) {
      if (!convoId) return;
      const at = now();
      records[convoId] = { roomId: roomId ?? null, bootId, startedAt: at, touchedAt: at };
      persist();
    },

    touch(convoId) {
      const rec = records[convoId];
      if (!isUsableRecord(rec)) return;
      const at = now();
      if (at - rec.touchedAt < touchDebounceMs) return;
      rec.touchedAt = at;
      persist();
    },

    noteTurnEnd(convoId) {
      if (!records[convoId]) return;
      delete records[convoId];
      persist();
    },

    // Previous-boot markers within the window, newest information first-hand.
    // ALL previous-boot markers are cleared, including out-of-window ones:
    // this is what makes the feature fire once. Without it the same dangling
    // turn from three restarts ago would resurface on every subsequent boot —
    // the "don't dig up old dead conversations" failure in a different costume.
    takeStale(maxAgeMs) {
      const at = now();
      const stale = [];
      const kept = {};
      for (const [convoId, rec] of Object.entries(records)) {
        if (!isUsableRecord(rec)) continue;           // malformed: drop
        if (rec.bootId === bootId) { kept[convoId] = rec; continue; }  // ours: keep
        const ageMs = at - rec.touchedAt;
        if (ageMs <= maxAgeMs) {
          stale.push({
            convoId,
            roomId: rec.roomId ?? null,
            startedAt: Number.isFinite(rec.startedAt) ? rec.startedAt : rec.touchedAt,
            touchedAt: rec.touchedAt,
            ageMs,
          });
        }
      }
      records = kept;
      persist();
      return stale;
    },
  };
}
