# PR Shepherd

The shepherd is a **monitor-driven utility command** that automates the manual
polling / rerun / escalation loop a human otherwise runs by hand after
`/review`. It is **not** a workflow stage and does not replace `/review` or
the pre-merge gate (the embedded documentation-and-handoff gate in `/ship` and `/review`).

```bash
forge shepherd daemon                      # singleton reconcile daemon: owns ALL open PRs
forge shepherd <pr-number>                 # one bounded pass over a single PR
forge shepherd <pr-number> --auto-rebase   # opt-in, default OFF
forge shepherd <pr-number> --pull          # read-only: WHY it is blocked + what to fix
forge shepherd <pr-number> --pull --json   # same payload as machine-readable JSON
forge shepherd <pr-number> --bundle --json # read-only: the COMPLETE PR-state bundle
forge shepherd watch <pr-number>           # single-PR constant monitor loop
forge shepherd events <pr-number> --since <seq>  # read new journal events back
```

## Daemon vs bounded pass (two modes, one verb)

There are two ways to run the shepherd, both under the single `forge shepherd`
verb:

- **`forge shepherd daemon` — the singleton reconcile daemon, the default
  ownership model.** It acquires the machine-wide shepherd lease for this repo
  (exiting immediately as a clean no-op if a live daemon already owns it),
  heartbeats, and converges the *entire* PR world every ~60s: self-registering
  hand-opened PRs, restarting killed watchers, reaping verified orphan watchers,
  converging CI check state into kernel verdicts, and retiring merged/closed PRs.
  It **self-retires** — releases the lease, kills its verified children, exits —
  once no PRs remain open. Forge wakes it automatically after a successful
  supported session start, every successful push, and every successful
  non-dry-run ship. These are the only automatic firing seams; ordinary commands
  do not launch it. Once running, an agent does not poll: the daemon owns the
  convergence loop.
- **`forge shepherd <pr>` — one bounded pass.** Reads one PR's state, takes at
  most one Tier-A action, exits. The point-in-time surface for a single PR (see
  *Bounded-pass model* below).
- **`forge shepherd watch <pr>` / `watch --adopt`** — foreground streaming watch of
  one PR, or (`--adopt`) adopt every currently-open PR into the watcher set.
- **`forge shepherd events <pr> --since <seq>`** — the event deltas for a PR since a
  cursor; **`forge shepherd <pr> --pull --json` / `--bundle`** read the kernel verdict
  + rollup without taking any action.

Session start automatically wakes the daemon. When an embedding caller supplies
an executable harness background-shell capability, Forge uses it so the process is reaped with the session;
bare CLI use falls back to a detached launch from the stable common repository
root, never a disposable worktree cwd. No liveness check is needed first — the
O_EXCL singleton lease makes a duplicate start a clean no-op.

Embedding boundary:

```js
hooks.handler(['session-start', '--harness', 'claude'], {}, projectRoot, {
  harness: {
    hasBgShell: true,
    runBgShell: (argv, options) => host.backgroundShell(argv, options),
  },
});
```

The host must explicitly provide both `hasBgShell: true` and `runBgShell`;
Forge never infers this capability from a harness name. The adapter receives
the stable Git common-root as `options.cwd`; a missing or throwing adapter uses the contained detached fallback.
(A `forge prime` open-PR + daemon-liveness line is a planned follow-up — W-S5 —
not yet wired.)

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

## Automatic singleton attachment (`rail.auto_shepherd`)

Successful supported session start, push, and non-dry-run ship operations wake the
repository-wide singleton. Push never requires a locally resolved PR number:
the daemon owns GitHub enumeration, so even a push with no local open-PR match
still fires and can adopt open or draft PRs created elsewhere. Push and ship no
longer start separate per-PR detached watchers.

This auto-start is governed by the default-ON, unlocked **`rail.auto_shepherd`**
rail. Opt out with `forge gate disable rail.auto_shepherd` (re-enable with
`forge gate enable rail.auto_shepherd`). `FORGE_SHEPHERD_DISABLE=1` is the
environment kill-switch. CI/test detection is deterministic and injectable via
the trigger environment: `NODE_ENV=test`, `BUN_ENV=test`, or a set `CI`,
`GITHUB_ACTIONS`, or `GITLAB_CI` disables automatic fire. These environment
guards run before repository initialization, lease, Kernel-state, or process
work; dry-run, uninitialized repositories, and a disabled rail are likewise
zero-side-effect paths. The manual `forge shepherd` surface remains available.

## Surfacing events back to the agent (`forge hooks shepherd-events`)

The constant watch loop is the PRODUCER: it writes per-PR NDJSON journals under
`.forge/pr-monitor/<repo>-<pr>/`, while the `forge shepherd events <pr> --since
<seq>` pull surface reads existing records back from them. But a journal only
helps if the working agent sees it. `forge hooks shepherd-events` is the thin,
agent-agnostic CONSUMER: it reads the NEW budget events across all open-PR journals
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

## GitHub Actions backstop — auto-updated heads re-trigger CI (`FORGE_PR_TOKEN`)

The `pr-monitor.yml` Actions workflow can auto-update an otherwise-clean-but-behind
PR branch (merge base into the head). That push must **re-trigger CI on the new
head**, or the head sits with no required checks running and can never merge.

GitHub deliberately does **not** start new workflow runs for events created with
the default `GITHUB_TOKEN` — a `pull_request: synchronize` it produces lands in an
*approval-required* state instead of running. So an auto-update authored by
`GITHUB_TOKEN` leaves a **CI-dead head**. (Official rule:
<https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow>.)

**Fix (maintainer action required):** create a repository secret named
**`FORGE_PR_TOKEN`** holding a fine-grained **PAT** (or GitHub-App installation
token). The PAT's OWN permissions — not the workflow's `permissions:` block, which
only governs the built-in `GITHUB_TOKEN` — must cover every call the step makes:

| Permission | Why |
| --- | --- |
| **Contents: write** | push the update-branch merge to the head |
| **Pull requests: write** | `PUT /pulls/{n}/update-branch` (the update-branch API) |
| **Checks: write** | create the `forge/auto-update` marker check run |
| **Workflows** | only if the base branch may change `.github/workflows/**` (the merge would carry it) |

The auto-update-branch step uses the token and falls back to `GITHUB_TOKEN` when
the secret is absent:

```yaml
GH_TOKEN: ${{ secrets.FORGE_PR_TOKEN || github.token }}
```

With the secret set, auto-updated heads re-run CI automatically. Without it, the
workflow behaves exactly as before (no regression) — it just cannot auto-run CI on
the updated head. Forge only wires the code path and reads the secret; **creating
the secret is the maintainer's responsibility** — Forge never fabricates a token.

## GitHub Actions PR-monitor summary

The repository PR-monitor workflow writes detailed review-thread and check
diagnostics to the Actions job summary (`GITHUB_STEP_SUMMARY`) and keeps the
machine-readable view available through `forge shepherd <pr> --pull --json`.
It projects that same canonical verdict onto exactly one `pr-verdict:*` label
for a cheap agent-agnostic read. The label is visibility only: merge authority
continues to use live protected required checks, the current head, and
unresolved review threads. The workflow does not create PR comments or a
neutral `forge/pr-monitor` check.

## Per-harness behavior

- **Claude Code / Codex:** automatic session-start attachment wakes the singleton;
  invoke `forge shepherd <pr>` directly for a bounded point-in-time read.
- **Cursor:** manually-invoked only — run it from a terminal. No polling-loop
  affordance and no hook reliance on this surface.

## State

Progress is durable in the Actions job summary, the single verdict label, and
`git`. The one local store is the constant monitor's per-PR journal under
`.forge/pr-monitor/<repo>-<pr>/` (the append-only `events.ndjson` + snapshot and
consumer cursors) — the delivery/replay surface for `forge shepherd watch` and
`events --since`. The bounded shepherd pass itself keeps no separate local state.
