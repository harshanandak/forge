# PR Monitor PR-B — watch loop + ship lifecycle

Epic: `c2d398e5-26cf-4963-b47a-70b4102636bb` — *Constant agent-agnostic PR monitor*.
Builds ON TOP of PR-A (now merged to master): `lib/pr-monitor/{events,differ,journal,gather,monitor}.js`
and `forge shepherd events <pr> --since <seq>`.

## Goal

Make the monitor RUN CONSTANTLY and PUSH events, agent-agnostically:

1. `forge shepherd watch <pr>` — a long-running command that every ~60s (jittered) runs ONE bounded
   `runMonitorPass` (PR-A), diffs vs the journal snapshot, appends new events, and STREAMS each new
   event as one NDJSON line to stdout. Any harness reads stdout. Self-stops (clean exit) on
   `pr.merged`/`pr.closed`, emitting that terminal event LAST.
2. Lifecycle — auto-start the watcher, detached + idempotent, on `forge ship` success. Never blocks or
   fails ship.

## Design

### `lib/pr-monitor/watch.js` — the streaming loop (pure, injectable)

`watchLoop(ctx)` where ctx = `{ dir, gather, now?, enrich?, lockOpts?, emit?, sleep?, rng?, intervalMs?,
maxPasses?, signal?, watcherRunning?, writePid?, removePid? }`.

- **Idempotent claim:** if `journal.watcherRunning(dir)` a live *other* watcher owns the PR → no-op
  (`{ started: false, reason: 'watcher-already-running' }`). Otherwise `journal.writePid(dir)`.
- **Each pass** delegates to PR-A's `runMonitorPass` (gather → diff → dedup → append → snapshot, all
  UNDER `withJournalLock`, so the cross-process lock + heartbeat are respected and concurrent runs never
  corrupt the journal). The returned `events` are streamed.
- **Backpressure:** `runMonitorPass` only returns events on a fingerprint change, so an unchanged pass
  emits nothing.
- **Terminal:** when a pass yields `pr.merged`/`pr.closed`, flush any held failures, emit the terminal
  event LAST, and exit the loop cleanly (`stopped: true`).
- **Cadence:** between passes `await sleep(jitter(intervalMs, rng))` — base 60s ± 20%. `sleep`/`rng`/`now`
  are injected so tests never wait real time. The loop self-drives; no agent need be running.
- **Interruptible / no-hang:** the loop checks `signal.aborted` each iteration; every gh call inside
  `gather` has its own 30s timeout (PR-A). `maxPasses` bounds the loop in tests. `removePid` runs in
  a `finally`.
- **2-pass flap confirm (stream layer only):** a `check.failed` is HELD one pass; it is emitted on the
  next pass only if it was not contradicted by a `check.recovered`/`checks.green` for the same check
  name. A flap (fail→green within one interval) is suppressed from the pushed stream. The JOURNAL still
  records every event (authority), so `events --since` replay is complete — the hold only debounces the
  live push.

Helpers (each well under cognitive-complexity 15): `jitter`, `partition`, `contradictions`,
`isContradicted`, `confirmHeld`, `runWatchPass`.

### `forge shepherd watch <pr>` (lib/commands/shepherd.js)

`handler` routes `positional[0] === 'watch'` to `handleWatch`, mirroring the existing `events` route.
The context build (journal dir + gather + check-failure enricher) is extracted from `handleEvents` into
a shared `buildMonitorContext` helper that both handlers call. `handleWatch` wires an `AbortController`
to `SIGINT`/`SIGTERM`, calls `watchLoop` with the default stdout NDJSON `emit`, and returns
`{ success, started, passes, stopped }` with NO `output` field (the loop streams live to stdout itself —
returning output would double-print).

### Ship lifecycle hook (lib/pr-monitor/watch-lifecycle.js + lib/commands/ship.js)

`startPrWatcherDetached({ prNumber, cwd, ... })` (fully injectable, NEVER throws):
- Best-effort idempotency: resolve the repo slug from `git remote get-url origin`, compute the journal
  dir, and skip if `journal.watcherRunning(dir)`. On any failure it falls through to spawn — the
  watchLoop's own `watcherRunning` guard is the authoritative de-dup.
- Detached start: `spawn(process.execPath, [bin/forge.js, 'shepherd', 'watch', <pr>], { detached: true,
  stdio: 'ignore', windowsHide: true })` then `child.unref()` → returns immediately (non-blocking).
- `executeShip` calls it after `prNumber` is known, guarded so a hook failure can never fail ship
  (`!dryRun && result.prNumber` only; the function has its own try/catch).

Stop-on-merge is handled entirely by the watch loop's terminal pass — no separate stopper.

## Testing (injected fakes; no live GitHub, no real 60s sleep)

- `test/pr-monitor/watch.test.js`: emits NDJSON on change; no emit when unchanged; terminal event last
  then exit; idempotent no-op when a watcher runs; bounded via fake clock + `maxPasses` (asserts jitter
  range, no real timers); flap held/suppressed vs confirmed; pid written on start, removed on exit.
- `test/pr-monitor/watch-lifecycle.test.js`: detached+unref start; non-blocking (returns synchronously);
  no-op when pid live (spawn not called); never throws when spawn throws.
- `test/pr-monitor/shepherd-watch.test.js`: `handleWatch` streams injected events and returns success.

Gates: affected tests + `eslint --max-warnings 0` + `eslint-plugin-sonarjs` cognitive-complexity 15.
