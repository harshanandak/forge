# PR Shepherd

The shepherd is a **monitor-driven utility command** that automates the manual
polling / rerun / escalation loop a human otherwise runs by hand after
`/review`. It is **not** a workflow stage and does not replace `/review` or
the pre-merge gate (the embedded documentation-and-handoff gate in `/ship` and `/review`).

```bash
forge shepherd <pr-number>
forge shepherd <pr-number> --auto-rebase   # opt-in, default OFF
forge shepherd <pr-number> --pull          # read-only: WHY it is blocked + what to fix
forge shepherd <pr-number> --pull --json   # same payload as machine-readable JSON
forge shepherd <pr-number> --bundle --json # read-only: the COMPLETE PR-state bundle
```

## `--pull`: the actionable blocker payload

`--pull` is a **strictly read-only** signal-gather. It computes the decision
state via a dry-run pass (no rerun, no rebase, no merge, no thread resolution)
and returns ONE bounded, **actionable-only** payload so an agent gets "everything
blocking this PR + exactly what to fix" in a single call instead of running
`gh pr checks`, `gh run view --log-failed`, GraphQL thread queries, and branch
-protection lookups by hand. Default output is a compact human summary; `--json`
emits the structured payload. Every field is something to ACT on — passing
checks, resolved/outdated threads, and satisfied policy are omitted.

| Field | Meaning |
| --- | --- |
| `state` / `summary` | Decision state + a one-line WHY (leads with the primary blocker). |
| `mergeable` / `mergeStateStatus` | GitHub's raw merge signals (e.g. `BLOCKED`, `BEHIND`, `DIRTY`, `UNSTABLE`). |
| `blockers[]` | Ordered `{type, detail}` list — the human-readable WHY. Types: `draft`, `conflict`, `check-failing`, `check-missing`, `check-skipped`, `check-pending`, `behind`, `changes-requested`, `review-required`, `unresolved-threads`, `blocked-unknown`, `unstable`. |
| `requiredChecks` | Branch-protection required set classified vs what the PR produced: `missing` (never reported), `skipped` (a **required** check that resolved SKIPPED — NOT a pass to branch protection; this is why an all-green PR can stay `BLOCKED`), `pending`, `failing`. Omitted entirely when the required set is all green. |
| `failures[]` | Per failed check: `name`, `conclusion`, `jobUrl`, the exact failure **excerpt** pulled from the job log, and `alsoFailedOn` (matrix duplicates collapse to one). |
| `pendingChecks[]` | Names of checks still running. |
| `reviewThreads[]` | Every UNRESOLVED, non-outdated thread from a human or a review bot (CodeRabbit et al.): `file`, `line`, `author`, `body`, `threadId`, `commentId`. Never the shepherd's own or resolved threads. |
| `behind` | Commits behind base (present only when > 0). |
| `conflicts` | `{conflicted, files[]}` — present only when a merge would conflict. |
| `reviewDecision` | Present only when actionable (`CHANGES_REQUESTED` / `REVIEW_REQUIRED`); `APPROVED` is omitted. |
| `draft` | Present only when the PR is a draft. |
| `truncated` | Flags when `failures`/`reviewThreads` were capped for size. |

`--bundle --json` is the sibling COMPLETE (not-only-actionable) read-only state
bundle; `--pull` and `--bundle` are mutually exclusive.

## Why it is a utility, not a stage

Stages are a frozen, ordered ladder (`plan → dev → validate → ship → review →
premerge → verify`). Inserting a polling step into that ladder would break the
stage-transition chain and the harness parity model. The shepherd instead runs
*alongside* the review handoff: `/review` keeps owning semantic review and its
stage transition; the shepherd only automates the mechanical waiting and
re-running.

It is registered as a utility skill in the harness capability matrix
(`UTILITY_SKILL_IDS`), so cross-harness parity tests cover it without touching
the frozen stage list.

## Bounded-pass model

Each invocation is **one discrete bounded pass**: read PR state, take at most
one Tier-A action, then exit. There is no in-process loop. This preserves the
project's documented ergonomic — poll briefly, then stop and hand off. A pass
that finds checks still pending returns `PENDING`; the next scheduled pass picks
up from there.

`--watch`-style behavior, if desired, belongs in an external scheduler (cron, or
a `/loop`) that re-invokes the bounded pass with a debounce of at least 60
seconds and cancel-in-progress. The shepherd itself never waits in-process.

## Auto-start on ship (`rail.auto_shepherd`)

`forge shepherd watch <pr>` is the constant, self-stopping local monitor loop
(≈60 s jittered cadence; appends events to the per-PR NDJSON journal under
`.forge/pr-monitor/<repo>-<pr>/`; self-stops on `PR_MERGED`/`PR_CLOSED`). On a
successful `forge ship`, the new PR's watcher is **auto-started detached** so a
shipped PR is tended without a manual trigger. The spawn is best-effort and
**never fails ship** (a spawn or config-read error degrades to "not started"),
and it is idempotent — the watch-lifecycle PID/journal lock prevents a second
watcher for the same PR.

This auto-start is governed by the default-ON, unlocked **`rail.auto_shepherd`**
rail. Opt out with `forge gate disable rail.auto_shepherd` (re-enable with
`forge gate enable rail.auto_shepherd`); when disabled, `forge ship` skips the
auto-start. This keeps the behavior honestly toggleable through the same config
surface as every other rail.

## Surfacing events back to the agent (`forge hooks shepherd-events`)

The constant watch loop and `forge shepherd events <pr> --since <seq>` write
per-PR NDJSON journals under `.forge/pr-monitor/<repo>-<pr>/`, but a journal only
helps if something reads it. `forge hooks shepherd-events` is the thin, agent-
agnostic CONSUMER: it reads the NEW budget events across all open-PR journals
since a persisted per-PR **consumer cursor** (kept in `consumer.cursor`, distinct
from the watcher's snapshot), renders a **compact, capped** summary of the
actionable transitions only — verdict changes, failed checks, new review threads,
merged/closed — then advances the cursor so nothing re-surfaces.

For Claude Code this is wired as a **UserPromptSubmit** context hook (the honest
capability matrix: only Claude exposes that additionalContext surface; Cursor /
Codex / Hermes carry an explicit skip reason). It is **additive and FAIL-OPEN** —
a missing/empty digest, a corrupt journal, or no `.forge/pr-monitor` at all never
blocks a prompt — and it reads the user's own local journal only: it never
injects into stdin and never drives the agent. Any other harness can call the
same verb (or `forge shepherd events`) on its own cadence.

## Terminal states

| State         | Meaning |
| ------------- | ------- |
| `MERGE_READY` | Required checks are green and the branch is up to date. The shepherd hands off — **a human merges in the GitHub UI.** |
| `ESCALATE`    | A Tier-C condition (conflict, unreadable required set, persistent failure, oscillation, budget exhaustion). Context is posted to the PR. |
| `PENDING`     | A Tier-A action was taken, or checks are still pending. Exit and await the next scheduled pass. |
| `HARD_STOP`   | A permanent auth/scope failure that retrying cannot fix. Escalate to a human to widen token scope. |

## Action ladder

- **Tier-A (autonomous):** re-run a flaky **required** check via
  `gh run rerun --failed` (capped by a rerun budget). Post status replies to
  review threads (reply only).
- **Tier-B (opt-in, default OFF):** `--auto-rebase` rebases onto base and
  force-pushes with lease, given a clean tree and an unchanged HEAD. A lease
  rejection is a hard-stop — the shepherd never re-arms the lease.
- **Tier-C (escalate):** everything else.

## Safety invariants

- **Never merges.** No merge action, no server-side auto-merge latch.
- **Never resolves review threads.** It may post a status reply; resolution is
  semantic and stays with `/review`.
- **Required-check gate.** Merge-ready is declared only when the
  branch-protection required-check set is *known* (read from
  `gh api repos/{owner}/{repo}/branches/{base}/protection/required_status_checks`)
  and all of it is green. If protection is unreadable, the shepherd escalates
  rather than guessing.
- **HEAD-changed abort.** Before any mutating action it re-reads the head SHA; if
  HEAD moved during the pass, the action aborts. The `shepherd:active` marker is
  advisory only — it is not mutual exclusion.
- **Auth taxonomy.** 401 (expiry) pauses and surfaces; 403 insufficient-scope is
  a hard-stop; 403 with `Retry-After` honors the delay and resumes next pass.

## Per-harness behavior

- **Claude Code / Codex:** invoke `forge shepherd <pr>` directly; an external
  scheduler may drive repeated bounded passes.
- **Cursor:** manually-invoked only — run it from a terminal. No polling-loop
  affordance and no hook reliance on this surface.

## State

Progress is durable in GitHub PR comments and labels plus `git`. The one local
store is the constant monitor's per-PR journal under
`.forge/pr-monitor/<repo>-<pr>/` (the append-only `events.ndjson` + snapshot and
consumer cursors) — the delivery/replay surface for `forge shepherd watch` and
`events --since`. The bounded shepherd pass itself keeps no separate local state.
