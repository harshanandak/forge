
Run one bounded monitor pass over a pull request: read CI and check state, take at most one idempotent action, then hand off. Never merges and never resolves review threads.

# Shepherd

`shepherd` is a **utility command, not a workflow stage.** It automates the polling / rerun / escalation loop that today is done by hand after `/review`. It does **not** replace `/review` (which still owns semantic review and its stage transition) and does **not** touch `/premerge`.

## Usage

```bash
forge shepherd <pr-number>
forge shepherd <pr-number> --auto-rebase   # opt-in, default OFF
```

## Bounded-pass model (one pass = one invocation)

Each `forge shepherd <pr>` invocation is **ONE discrete bounded pass**: it reads PR state, takes at most the allowed Tier-A action, then **exits**. It never sits in-process polling "until merge-ready."

This mirrors the project's documented ergonomic from `/review`, `/premerge`, and the Greptile process: **poll briefly, then stop and hand off.** Any pass that finds checks still pending exits as `PENDING`, and the next scheduled pass picks up where it left off.

A `--watch` affordance, if you want one, lives in an **external scheduler** (e.g. cron or a `/loop`) that re-invokes the bounded pass on an interval with debounce (>= 60s between passes, cancel-in-progress). There is no in-process infinite loop.

## What it never does

- **Never merges.** There is no merge action and no server-side auto-merge latch. The shepherd terminates at `MERGE_READY` and hands off to the human, who merges in the GitHub UI (mirroring the `/premerge` handoff).
- **Never resolves review threads.** It may post a status **reply** to a thread (via the existing `.claude/scripts/greptile-resolve.sh reply` helper), but thread **resolution** is semantic and stays with `/review`.

## Action ladder

- **Tier-A (autonomous, idempotent, reversible):** re-run a flaky **required** check via `gh run rerun --failed` (capped by a rerun budget). Post status replies to threads (reply only).
- **Tier-B (opt-in per-flag, default OFF):** `--auto-rebase` rebases onto the base and force-pushes with lease. Preconditions: clean working tree, HEAD unchanged during the pass. A lease rejection is a **hard-stop + escalate** — the shepherd never re-arms the lease, because doing so would clobber the concurrent human push the lease exists to protect.
- **Tier-C (human escalation):** merge conflicts, required-check failures a rerun did not fix, an unreadable required-check set, unknown mergeability, auth/scope failures, oscillation, and budget exhaustion all stop and escalate with context posted to the PR.

## Merge-readiness gate

Merge-ready is declared **only** when the branch-protection required-check set is **known** AND all of it is green AND the branch is not behind base. The required set is read from `gh api repos/{owner}/{repo}/branches/{base}/protection/required_status_checks`. If branch protection is unreadable (insufficient token scope, or the branch is not protected), the shepherd does **not** guess — it escalates with the readable rollup attached.

## Concurrency & safety

- The advisory `shepherd:active` marker is **not** mutual exclusion. The real guard is a per-action HEAD-SHA re-read: before any mutating action the shepherd re-reads the head SHA, and if HEAD moved since the pass started it **aborts** the action.
- Auth taxonomy: token expiry (401) pauses and surfaces; insufficient scope (403) is a permanent **hard-stop**; a secondary rate limit (403 + `Retry-After`) honors the delay and resumes on the next pass.

## Per-harness behavior

- **Claude Code / Codex:** invoke `forge shepherd <pr>` directly; an external scheduler may drive repeated bounded passes.
- **Cursor:** manually-invoked only. Run `forge shepherd <pr>` from a terminal — there is no polling-loop affordance and no hook reliance on this surface.

## State

Progress is durable in GitHub: PR **comments** and **labels** plus `git`. There is no separate local state store.
