# Constant agent-agnostic PR monitor — `forge shepherd watch/events`

Kernel epic: `c2d398e5-26cf-4963-b47a-70b4102636bb`
Audit: `9af1ee0a-a090-48ca-9d89-5c06a0a67fc9`
Builds on: PR #366 (shared verdict core — `gatherPullSignal`/`computeVerdict` in `lib/pr-pull.js`).

## Goal

The shepherd must run **constantly** (~every 60s), pull **all** PR updates, and **push only the new events** back to the working agent — agent-agnostic, clean with every agent (Claude/Codex/Cursor/Hermes), with **no dependency on `.claude/*`**. The only channel every harness natively has is a CLI process writing NDJSON to stdout, so that is the delivery surface.

## Frame (non-negotiable)

The monitor is a **diff-over-time of ONE gather + ONE verdict core** — never a 6th independently-computed view of PR truth. Both the verdict and the events derive from the **same snapshot** read in a single pass, so they can never disagree. The verdict comes from #366's `computeVerdict` (fail-closed); the events are the transitions between consecutive snapshots.

## Gather completeness (audit A5/A6)

#366 already added to `lib/adapters/pr-state-adapter.js` (verified, NOT rebuilt):
`readReviews` (latest review per author + `commitOid` for review-at-head), `reviewDecision` + `isDraft` (in `readState`), author-agnostic **paginated** `readIssueComments` (mechanism-detected `__typename`; this replaces the greptile-only `.claude/scripts/review-resolve.sh` for direct comments), `readComments` threads carrying `isResolved`/`isOutdated`, and `isFailed` already covering `ERROR`/`STARTUP_FAILURE`.

Gaps this work **fills**:
- **`git fetch` before divergence/conflicts (A6).** `readDivergence`/`detectConflicts` compare against `origin/<base>`; without a fetch a stale local ref yields a false `behind=0` / false "no conflict". Added `adapter.fetchBase({baseRef, cwd})` and wired it into `gatherPullSignal` (via `callIfPresent`, degraded-surfaced) **before** divergence/conflict reads — fixing it for every consumer (shepherd, `--pull`, monitor), not just the monitor.
- **`STALE` check conclusion (A5).** `isFailed` omitted `STALE`, so a stale required CheckRun pended forever. Added `STALE` to the failed set.

## One gather + one verdict core

`gatherPullSignal` is refactored so its read-and-verdict middle is an exported `gatherPrSnapshot(ctx)` returning `{ raw, verdict, evidence, degraded, unreadable }`. `gatherPullSignal` calls it and then does only its bounded **projection** (failure log excerpts, review-thread fix-list, summary, `buildPullPayload`) — output unchanged, guarded by `test/shepherd-merge-safety.test.js`. The monitor gather calls the **same** `gatherPrSnapshot`, so verdict + events share one read.

`raw` = `{ headSha, prState (OPEN/MERGED/CLOSED), draft, mergeable, mergeStateStatus, behind, conflicts, reviewDecision, checks[], threads[], reviews[], issueComments[] }`.

## Event model

Types: `head.pushed`, `review.submitted{verdict}`, `thread.opened|reply|resolved`, `comment.posted`, `check.failed{excerpt}|check.recovered`, `checks.green`, `conflict.appeared|cleared`, `branch.behind`, `verdict.changed{from,to,reason}`, `pr.merged|closed`, `monitor.degraded{surface,error}`.

Schema: `{ v:1, seq, ts, repo, pr, headSha, type, key, data, verdict:{state,reason} }`.
- `seq` — monotonic per PR (last journal seq + 1).
- `key` — **content identity** (head sha, `threadId`, `check name+sha`, comment id, review `author+commitOid`, surface). Content-keyed identity is what makes the differ deterministic: a re-run after a crash produces the same `(type,key)` and is deduped against the journal, so **no duplicates across restarts**.

## Cursor / persistence

Per-PR dir `.forge/pr-monitor/<repo>-<pr>/`:
- `events.ndjson` — append-only journal (cursor authority; works without the kernel).
- `snapshot.json` — atomic (write-temp-then-rename) last snapshot + fingerprint. Fingerprint = stable hash of the diff-relevant snapshot projection; **emit only on fingerprint change** (backpressure).
- `watch.pid` — watcher pid file (idempotent start).

Ordering guarantee: append events **then** persist snapshot. If a crash lands between them, the next pass re-diffs the old snapshot, recomputes the same `(type,key)` events, and the journal `(type,key)` filter drops the already-appended ones — exactly-once by content identity.

## Command surface (agent-agnostic; all `forge` verbs, nothing under `.claude/*`)

- **`forge shepherd events <pr> --since <seq> [--json]`** (PR-A) — one bounded gather, diff vs last snapshot, append new events to the journal, print journal events **since `<seq>`** as NDJSON (one per line). Inline pass when no watcher is running. This is the pull surface.
- **`forge shepherd watch <pr>`** (PR-B) — long-running; every ~60s (jittered), bounded gather (~30s deadline), diff, append, **stream** each new event as one NDJSON line to stdout. Emits only on fingerprint change; 2-pass confirm for flappy checks; self-stops on `pr.merged`/`pr.closed` after emitting the terminal event.

Harness adapters are thin and out of scope here: Claude Code runs `watch` via background Bash/Monitor or a hook calling `events --since`; Codex via bg exec/hooks; Cursor polls `events --since` per turn; Hermes via CLI.

## Lifecycle (PR-B)

`forge ship` success starts the watcher **detached** (idempotent via `watch.pid`) after the `createPR` path in `lib/commands/ship.js` — a non-blocking start-monitor call. Stop-on-merge is handled by the watch loop.

## Module layout

- `lib/pr-monitor/events.js` — event constants, schema builder, fingerprint, key helpers.
- `lib/pr-monitor/differ.js` — **pure** `diffSnapshots(prev, next)` → candidate events (no I/O).
- `lib/pr-monitor/journal.js` — dir resolution, atomic snapshot read/write, NDJSON append, read-since-seq, seen-key set, pid file.
- `lib/pr-monitor/gather.js` — `gatherMonitorSnapshot(ctx)` → normalized diff subject via `gatherPrSnapshot`.
- `lib/pr-monitor/monitor.js` — `runMonitorPass` (gather → diff → enrich newly-failed excerpts → seq/ts → append → persist → return), `pollEvents` (events verb), `watchLoop` (PR-B).
- `lib/commands/shepherd.js` — route `events` (PR-A) and `watch` (PR-B) subcommands.

## Split

- **PR-A**: gather-completeness (`fetchBase` + `STALE`) + `gatherPrSnapshot` extract + journal + pure differ + `events --since` poll verb + tests.
- **PR-B**: `watch` streaming loop + start-on-ship + stop-on-merge + tests.

## Testing / quality

TDD. Differ tests: no dupes across restarts (content-keyed identity), each event type on its correct transition, degraded surfaced not swallowed. Journal tests: atomic snapshot, append, read-since cursor. Verb tests: `--since` cursor, inline pass. Gate: affected tests + `eslint --max-warnings 0` + local sonarjs cognitive-complexity@15 (every function < 15; decompose proactively).
