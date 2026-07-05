# PR Shepherd

The shepherd is a **monitor-driven utility command** that automates the manual
polling / rerun / escalation loop a human otherwise runs by hand after
`/review`. It is **not** a workflow stage and does not replace `/review` or
the pre-merge gate (the embedded documentation-and-handoff gate in `/ship` and `/review`).

```bash
forge shepherd <pr-number>
forge shepherd <pr-number> --auto-rebase   # opt-in, default OFF
```

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

Progress is durable in GitHub PR comments and labels plus `git`. There is no
separate local state store.
