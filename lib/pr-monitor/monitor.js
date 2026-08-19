'use strict';

/**
 * PR-monitor orchestration — one bounded pass (gather → diff → dedup → append →
 * persist) and the `events --since` poll surface. The watch streaming loop and
 * the ship lifecycle hook land in a follow-up (Tier-1 PR-B).
 *
 * @module pr-monitor/monitor
 */

const { finalizeEvent, eventIdentity, fingerprint } = require('./events');
const { diffSnapshots } = require('./differ');
const journal = require('./journal');

const MAX_EVENT_DELTAS = 128;
const ACTIVE_OWNER_PHASES = new Set(['starting', 'running', 'stop_requested', 'terminal_pending']);

/** ISO-8601 timestamp; injectable via ctx.now for deterministic tests. */
function defaultNow() { return new Date().toISOString(); }

/**
 * Filter candidate events down to those whose `(type,key)` identity has NOT
 * already been journaled — the crash-safety dedup guard.
 */
function dedupeAgainstJournal(candidates, seen) {
  return candidates.filter((c) => !seen.has(eventIdentity(c)));
}

/**
 * Envelope filtered candidates into journal records with monotonic seq + ts.
 */
function finalizeRecords(candidates, { baseSeq, ts, snapshot }) {
  return candidates.map((c, i) => finalizeEvent(c, {
    seq: baseSeq + i + 1,
    ts,
    repo: snapshot.repo,
    pr: snapshot.pr,
    headSha: snapshot.headSha,
    verdict: snapshot.verdict,
  }));
}

function createCompatibilityAppender(dir) {
  const deliveredIds = new Set(journal.readAllEvents(dir)
    .map(event => event.memoryEventId).filter(Boolean));
  const snapshotRecord = journal.readSnapshot(dir);
  const appliedSeq = snapshotRecord?.appliedSeq || 0;
  const seen = journal.seenIdentities(dir, appliedSeq);
  const journalCursor = journal.lastSeq(dir);
  let nextSeq = journalCursor;
  return {
    journalCursor,
    append(record, memoryEventId) {
      const identity = eventIdentity(record);
      if ((memoryEventId && deliveredIds.has(memoryEventId)) || seen.has(identity)) return;
      nextSeq += 1;
      journal.appendEvents(dir, [{ ...record, seq: nextSeq, ...(memoryEventId ? { memoryEventId } : {}) }]);
      if (memoryEventId) deliveredIds.add(memoryEventId);
      seen.add(identity);
    },
    finish(snapshot) {
      if (!snapshot) return;
      journal.writeSnapshot(dir, {
        snapshot,
        fingerprint: fingerprint(snapshot),
        appliedSeq: nextSeq,
      });
    },
  };
}

/**
 * The read→diff→dedup→sequence→append→snapshot critical section of a single
 * pass. Runs ONLY while holding the journal lock (see `runMonitorPass`), so it
 * may assume no concurrent writer.
 *
 * Dedup is SCOPED to the snapshot's `appliedSeq` cursor: only identities the
 * current snapshot has not yet accounted for filter a candidate. When the
 * snapshot is missing (crash recovery) `appliedSeq` is 0, so the guard falls
 * back to the full history and no duplicate survives a crash between append and
 * snapshot write. When the snapshot is current, the window is empty, so a state
 * that flips back to a prior value (fail → green → fail on the same sha) emits a
 * fresh event instead of being suppressed forever.
 */
async function runMonitorPassLocked(ctx) {
  const { dir, gather, now = defaultNow, enrich } = ctx;
  const next = await gather();
  const prevRecord = journal.readSnapshot(dir);
  const prev = prevRecord ? prevRecord.snapshot : null;
  const appliedSeq = prevRecord ? prevRecord.appliedSeq || 0 : 0;
  const fp = fingerprint(next);

  const candidates = diffSnapshots(prev, next);
  const filtered = dedupeAgainstJournal(candidates, journal.seenIdentities(dir, appliedSeq));

  if (!filtered.length) {
    // Backpressure: only rewrite the snapshot when the fingerprint actually moved.
    const changed = prevRecord?.fingerprint !== fp;
    // Even with no new events, advance the cursor to the current tail so the
    // dedup window stays anchored at the snapshot (prevents unbounded scans).
    if (changed) {
      journal.writeSnapshot(dir, { snapshot: next, fingerprint: fp, appliedSeq: journal.lastSeq(dir) });
    }
    return { events: [], changed, fingerprint: fp };
  }

  const baseSeq = journal.lastSeq(dir);
  const records = finalizeRecords(filtered, {
    baseSeq,
    ts: now(),
    snapshot: next,
  });
  if (typeof enrich === 'function') await enrich(records);

  journal.appendEvents(dir, records);
  // appliedSeq = the new tail, so the next pass's dedup window starts empty and
  // only a crash BEFORE this write leaves the tail inside the recovery window.
  journal.writeSnapshot(dir, { snapshot: next, fingerprint: fp, appliedSeq: baseSeq + records.length });
  return { events: records, changed: true, fingerprint: fp };
}

/**
 * Run ONE bounded monitor pass: gather the current snapshot, diff it against the
 * persisted one, dedup by content identity, APPEND new events, THEN persist the
 * snapshot (this order is what makes a crash between the two idempotent). The
 * whole critical section — including the gather and the no-events snapshot
 * update path — runs under a cross-process journal lock so concurrent passes
 * from other processes/worktrees can never interleave appends or reuse a seq.
 *
 * @param {object} ctx
 * @param {string} ctx.dir - journal directory (from journal.journalDir).
 * @param {() => Promise<object>} ctx.gather - returns a normalized snapshot.
 * @param {() => string} [ctx.now] - timestamp source (test injection).
 * @param {(records: object[]) => Promise<void>|void} [ctx.enrich] - optional hook
 *   to enrich records (e.g. attach log excerpts to check.failed) before append.
 * @param {object} [ctx.lockOpts] - override lock staleMs/retries/waitMs (tests).
 * @returns {Promise<{ events: object[], changed: boolean, fingerprint: string }>}
 */
async function runMonitorPass(ctx) {
  if (ctx.store) {
    const { runFlowMonitorPass } = require('./flow-monitor');
    return journal.withJournalLock(ctx.dir, async () => {
      let latestSnapshot;
      const compatibility = createCompatibilityAppender(ctx.dir);
      const deliverLegacy = ctx.deliverLegacy || (async (record, memoryEventId) => {
        compatibility.append(record, memoryEventId);
      });
      const result = await runFlowMonitorPass({
        ...ctx,
        gather: async () => {
          const snapshot = await ctx.gather();
          latestSnapshot = snapshot;
          return snapshot;
        },
        deliverLegacy,
      });
      if (!ctx.deliverLegacy) compatibility.finish(latestSnapshot);
      return { ...result, journalCursor: compatibility.journalCursor };
    }, ctx.lockOpts);
  }
  return journal.withJournalLock(ctx.dir, async () => {
    const journalCursor = journal.lastSeq(ctx.dir);
    const result = await runMonitorPassLocked(ctx);
    return { ...result, journalCursor };
  }, ctx.lockOpts);
}

/**
 * `forge shepherd events <pr> --since <seq>` core: run one inline pass when the
 * Kernel owner row proves no watcher owns this PR, then return every journaled
 * event with `seq > since`. PID files are compatibility evidence only and are
 * never consulted for this decision.
 * This is the agent-agnostic PULL surface — stdout NDJSON, nothing under .claude.
 *
 * @param {object} ctx
 * @param {string} ctx.dir
 * @param {() => Promise<object>} ctx.gather
 * @param {number} [ctx.since]
 * @param {() => string} [ctx.now]
 * @param {(records: object[]) => Promise<void>|void} [ctx.enrich]
 * @returns {Promise<{ events: object[], since: number, ranPass: boolean }>}
 */
async function pollEvents(ctx) {
  const { dir, gather, since = 0 } = ctx;
  const checkOwner = typeof ctx.isOwnerRunning === 'function'
    ? ctx.isOwnerRunning
    : (ctx.owner && typeof ctx.owner.readOwner === 'function' && ctx.repo && Number(ctx.pr) > 0
      ? async () => {
        const result = await ctx.owner.readOwner(
          { repo: ctx.repo, pr: Number(ctx.pr) },
          ctx.ownerOptions || {},
        );
        if (!result?.ok) return { ok: false, reason: result?.reason || 'authority_unavailable' };
        const record = result.record;
		return record != null && (ACTIVE_OWNER_PHASES.has(record.phase) || record.phase === 'blocked');
      }
      : null);
  let authorityUnavailable = typeof checkOwner !== 'function';
  let isRunning = true;
  if (!authorityUnavailable) {
    try {
      const result = await checkOwner();
      authorityUnavailable = result && typeof result === 'object' && result.ok === false;
      isRunning = authorityUnavailable ? true : result === true || result?.running === true;
    } catch {
      authorityUnavailable = true;
      isRunning = true;
    }
  }
  let ranPass = false;
  let pass = null;
  if (!authorityUnavailable && !isRunning) {
    pass = await runMonitorPass({ ...ctx, dir, gather, now: ctx.now, enrich: ctx.enrich });
    ranPass = true;
  }
  const readEventsSince = ctx.readEventsSince || journal.readEventsSince;
  const available = readEventsSince(dir, since);
  const overflow = available.length > MAX_EVENT_DELTAS;
  const events = overflow ? available.slice(-MAX_EVENT_DELTAS) : available;
  return {
    events,
    since: Number(since) || 0,
    ranPass,
    ...(authorityUnavailable ? { authorityUnavailable: true } : {}),
    overflow,
    receiptIds: Array.isArray(pass?.receiptIds) ? pass.receiptIds.slice(0, MAX_EVENT_DELTAS) : [],
    continuationPending: pass?.continuationPending === true,
    ...(pass?.terminalReceiptId ? { terminalReceiptId: pass.terminalReceiptId } : {}),
  };
}

module.exports = {
  runMonitorPass,
  pollEvents,
  dedupeAgainstJournal,
  finalizeRecords,
  defaultNow,
  MAX_EVENT_DELTAS,
};
