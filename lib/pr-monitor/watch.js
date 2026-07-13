'use strict';

/**
 * PR-monitor watch loop — the CONSTANT, agent-agnostic push surface. `watchLoop`
 * self-drives a ~60s (jittered) cadence: each tick runs ONE bounded
 * `runMonitorPass` (PR-A: gather → diff → dedup → append → snapshot, all under the
 * cross-process journal lock), then STREAMS every new event as a single NDJSON
 * line to stdout. Any harness (Claude Code background Bash, Codex bg exec, a
 * Cursor per-turn poll, a plain shell) consumes stdout — nothing under `.claude`.
 *
 * Backpressure: `runMonitorPass` only returns events when the snapshot fingerprint
 * moved, so an unchanged tick emits nothing. Terminal: when a tick yields
 * `pr.merged`/`pr.closed` the loop flushes, emits that terminal event LAST, and
 * exits cleanly (stop-on-merge). Flap debounce: a `check.failed` is held one tick
 * and only pushed if the next tick did not recover/green it — the JOURNAL still
 * records everything (authority), so `events --since` replay stays complete.
 *
 * Every external effect is injectable (emit/sleep/rng/now/gather/watcherRunning/
 * writePid/removePid, plus `maxPasses`/`signal`) so tests exercise the loop with a
 * fake clock and fake gh, never touching live GitHub or waiting 60s.
 *
 * @module pr-monitor/watch
 */

const { runMonitorPass } = require('./monitor');
const journal = require('./journal');
const { EVENT_TYPES: T } = require('./events');

const DEFAULT_INTERVAL_MS = 60000;
const JITTER_RATIO = 0.2;
const TERMINAL_TYPES = new Set([T.PR_MERGED, T.PR_CLOSED]);

/** Default push sink: one NDJSON line per event to stdout. */
function defaultEmit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/**
 * Non-blocking sleep that resolves early when `signal` aborts (Ctrl-C), so a
 * SIGINT never has to wait out a full jittered interval (~72s). The timer and
 * the abort listener are both cleaned up whichever path wins. Overridden in
 * tests by a fake clock.
 */
function defaultSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.('abort', finish, { once: true });
  });
}

/** The check name an event refers to (check.failed / check.recovered). */
function checkName(event) {
  return event.data?.name ?? event.key;
}

/** Base interval ± JITTER_RATIO, so many watchers never align their gh calls. */
function jitter(intervalMs, rng) {
  const spread = intervalMs * JITTER_RATIO;
  return Math.round(intervalMs - spread + rng() * spread * 2);
}

/** True once the caller's abort signal (AbortSignal-like) has fired. */
function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

/**
 * Atomically claim the watcher slot for this PR: the `watcherRunning` check and
 * the `writePid` write run TOGETHER inside the cross-process journal lock, so two
 * concurrent starts can never both pass the check and both begin emitting
 * duplicate NDJSON. The (possibly injected) `watcherRunning`/`writePid` primitives
 * are honored, so test injection still works. Returns true only when claimed.
 */
function defaultClaim(dir, { watcherRunning, writePid, lockOpts }) {
  return journal.withJournalLock(dir, () => {
    if (watcherRunning(dir)) return false;
    writePid(dir);
    return true;
  }, lockOpts);
}

/**
 * Split a pass's events into: held-candidate failures (by check name), terminal
 * events (pr.merged/closed), and everything else (emitted immediately).
 */
function partition(events) {
  const failures = new Map();
  const terminal = [];
  const others = [];
  for (const e of events) {
    if (e.type === T.CHECK_FAILED) failures.set(checkName(e), e);
    else if (TERMINAL_TYPES.has(e.type)) terminal.push(e);
    else others.push(e);
  }
  return { failures, terminal, others };
}

/**
 * Which held failures a pass contradicts: an explicit `checks.green` clears ALL
 * pending failures; a `check.recovered` clears just its own check name.
 */
function contradictions(events) {
  let allGreen = false;
  const names = new Set();
  for (const e of events) {
    if (e.type === T.CHECKS_GREEN) allGreen = true;
    else if (e.type === T.CHECK_RECOVERED) names.add(checkName(e));
  }
  return { allGreen, names };
}

/** Was a held failure for `name` cleared by this pass? */
function isContradicted(name, contra) {
  return contra.allGreen || contra.names.has(name);
}

/** Emit the prior tick's held failures that survived (still failing this tick). */
function confirmHeld(pending, contra, emit) {
  for (const [name, event] of pending) {
    if (!isContradicted(name, contra)) emit(event);
  }
}

/**
 * Run ONE watch tick: a bounded monitor pass, then stream its events with the
 * 2-pass flap debounce applied. Mutates `state.pending` (the held failures).
 *
 * @returns {Promise<{ terminal: boolean }>} terminal=true → stop the loop.
 */
async function runWatchPass(state, ctx, emit) {
  const { events } = await runMonitorPass({
    dir: ctx.dir, gather: ctx.gather, now: ctx.now, enrich: ctx.enrich, lockOpts: ctx.lockOpts,
  });
  const { failures, terminal, others } = partition(events);
  const contra = contradictions(events);
  const heldNames = new Set(state.pending.keys());

  confirmHeld(state.pending, contra, emit);
  for (const e of others) {
    // Drop a recovered event that only cancels a failure we held but never pushed.
    if (e.type === T.CHECK_RECOVERED && heldNames.has(checkName(e))) continue;
    emit(e);
  }

  if (terminal.length) {
    for (const failure of failures.values()) emit(failure);
    for (const t of terminal) emit(t);
    return { terminal: true };
  }
  state.pending = failures;
  return { terminal: false };
}

/**
 * Run the constant watch loop over one PR. Long-running by default; self-stops on
 * a terminal event. Returns a summary when the loop ends.
 *
 * @param {object} ctx
 * @param {string} ctx.dir - journal directory (journal.journalDir).
 * @param {() => Promise<object>} ctx.gather - bounded snapshot read.
 * @param {(event: object) => void} [ctx.emit] - push sink (default: stdout NDJSON).
 * @param {(ms: number) => Promise<void>} [ctx.sleep] - cadence sleep (test injection).
 * @param {() => number} [ctx.rng] - jitter source in [0,1) (test injection).
 * @param {() => string} [ctx.now] - timestamp source (test injection).
 * @param {number} [ctx.intervalMs=60000] - base cadence.
 * @param {number} [ctx.maxPasses=Infinity] - bound the loop (tests).
 * @param {{ aborted: boolean }} [ctx.signal] - cooperative interrupt (SIGINT).
 * @param {(records: object[]) => Promise<void>|void} [ctx.enrich] - PR-A enrich hook.
 * @returns {Promise<{ started: boolean, passes: number, stopped: boolean, reason?: string }>}
 */
async function watchLoop(ctx) {
  const { dir } = ctx;
  const emit = ctx.emit || defaultEmit;
  const sleep = ctx.sleep || defaultSleep;
  const rng = ctx.rng || Math.random;
  const intervalMs = ctx.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxPasses = ctx.maxPasses ?? Infinity;
  const watcherRunning = ctx.watcherRunning || journal.watcherRunning;
  const writePid = ctx.writePid || journal.writePid;
  const removePid = ctx.removePid || journal.removePid;
  const claim = ctx.claim || (() => defaultClaim(dir, { watcherRunning, writePid, lockOpts: ctx.lockOpts }));

  // Atomic idempotent claim: a live OTHER watcher already owns this PR → no-op.
  // The check+write are serialized under the journal lock so concurrent starts
  // cannot both succeed (see defaultClaim).
  const claimed = await claim(dir);
  if (!claimed) {
    return { started: false, passes: 0, stopped: false, reason: 'watcher-already-running' };
  }

  const state = { pending: new Map() };
  let passes = 0;
  let stopped = false;
  try {
    while (passes < maxPasses && !isAborted(ctx.signal)) {
      const result = await runWatchPass(state, ctx, emit);
      passes += 1;
      if (result.terminal) { stopped = true; break; }
      if (passes >= maxPasses || isAborted(ctx.signal)) break;
      await sleep(jitter(intervalMs, rng), ctx.signal);
    }
  } finally {
    removePid(dir);
  }
  return { started: true, passes, stopped };
}

module.exports = {
  watchLoop,
  runWatchPass,
  defaultSleep,
  defaultClaim,
  jitter,
  partition,
  contradictions,
  isContradicted,
  confirmHeld,
  DEFAULT_INTERVAL_MS,
  TERMINAL_TYPES,
};
