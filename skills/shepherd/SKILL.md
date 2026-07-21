---
name: shepherd
description: >
  Own open PRs to merge-readiness — autonomously. Forge provides a singleton
  shepherd daemon — start it with `forge shepherd daemon` — that then watches every
  open PR, converges CI check state into kernel verdicts, re-runs flaky required
  checks, reaps orphan watchers, and self-retires when no PRs remain; one-shot
  passes (forge shepherd <pr>) exist for a single bounded check. Use when a PR was
  just opened or shipped; when a session starts with open PRs (start the daemon in
  a background shell — the singleton lease makes a duplicate start a safe no-op);
  when the user asks "why isn't my PR merging", "what's
  blocking the PR", "is the PR ready", "did a check fail / go red"; when asked to
  "keep watching / keep an eye on / babysit my PRs"; or to read PR verdicts
  (forge shepherd <pr> --pull --json, forge shepherd events). NEVER merges and
  never resolves review threads — fixing review feedback is `review`; opening the
  PR is `ship`; post-merge health is `verify`; general orientation is `status`.
allowed-tools: Bash, Read, Grep, Glob
terminal: true
handoffs:
  - review
---

Forge owns your open PRs. A singleton daemon converges every open PR toward merge-readiness; you read its verdicts and only step in on escalations. Never merges, never resolves review threads.

# Shepherd

`shepherd` is the PR-ownership utility, not a workflow stage. It has two modes over the **single `forge shepherd` verb**:

- **Daemon (default ownership):** `forge shepherd daemon` is a machine-wide singleton for this repo. It heartbeats and converges the whole PR world every ~60s — self-registering hand-opened PRs, restarting killed watchers, reaping verified orphans, converging CI check state into kernel verdicts, retiring merged/closed PRs — then self-retires (releases the lease, kills its children, exits) once no PRs remain open. You do NOT poll by hand; the daemon does.
- **One-shot pass:** `forge shepherd <pr>` reads one PR's state, takes at most one idempotent Tier-A action, and exits. Use it for a point-in-time question about a single PR.

## Which mode? (decision rule)

- User asks about **one PR, right now** ("is #212 ready?", "why is this blocked?") → **one-shot** (`forge shepherd <pr> --pull`).
- Anything **ongoing** — "keep", "until it merges", "watch", "babysit", multiple PRs, or a session that starts with PRs already open → **ensure the daemon is running**.

## Session-start ritual

When a session starts and the repo has open PRs, ensure the daemon is running:

```bash
forge shepherd daemon    # start it in the HARNESS BACKGROUND SHELL
```

The daemon is a **repo singleton** guarded by an O_EXCL lease, so you do NOT need a liveness check first — a second start when one is already running simply exits (the lease is already held). Start it in the harness background shell (Claude Code / Codex background-shell) so it is session-scoped and reaped with the session. NEVER launch a detached spawn from the agent: the detached path is Forge's bare-CLI fallback only. (Automatic per-command launch and a `forge prime` daemon-liveness line are planned follow-ups — W-S4c/W-S5 — not yet wired; until then you start the daemon explicitly as above.)

## Reading verdicts (the common case)

```bash
forge shepherd <pr> --pull --json          # actionable payload: WHY blocked + exactly what to fix
forge shepherd <pr> --bundle --json        # the COMPLETE read-only PR-state bundle
forge shepherd events <pr> --since <seq>   # only the new events since sequence <seq>
```

`--pull` is strictly read-only (dry-run pass: no rerun, no rebase, no merge, no thread resolution). It returns one bounded, actionable-only payload — `blockers[]`, classified `requiredChecks`, failed-check log `failures[]` (matrix-deduped), and every unresolved `reviewThreads[]` — so you get "everything blocking this PR + what to fix" in one call. Passing checks and satisfied policy are omitted.

### Verdict vocabulary (collapsed, W-S1)

| Verdict | Meaning |
| --- | --- |
| `MERGE_READY` | Required checks green, branch up to date — hand off to a human to merge. |
| `PENDING` | A Tier-A action was taken, or checks are still running — await the next tick/pass. |
| `BLOCKED` | Something actionable blocks merge (failing/missing/skipped required check, conflict, behind, unresolved threads, changes requested). Read `blockers[]`. |
| `CI_DEAD_HEAD` | The head has no required checks running (e.g. an auto-update authored by `GITHUB_TOKEN` never re-triggered CI). Recovery is an **escalation, not an autonomous Tier-A rerun**: it needs a maintainer-provided `FORGE_PR_TOKEN` (contents + pull-requests + checks) to re-author the push so CI re-triggers. |
| `ESCALATE` | A Tier-C condition (conflict, unreadable required set, persistent failure, oscillation, budget exhaustion). Context is posted to the PR. |
| `HARD_STOP` | A permanent auth/scope failure retrying cannot fix — a human must widen token scope. |

## Trigger scenario → command

| Situation | Command |
| --- | --- |
| PR just opened / shipped | ensure `forge shepherd daemon` running |
| Session starts, open PRs exist, daemon dead | `forge shepherd daemon` (background shell) |
| "Why isn't my PR merging / what's blocking it" | `forge shepherd <pr> --pull` |
| "Is the PR ready?" | `forge shepherd <pr> --pull` (read `MERGE_READY`) |
| "A check failed / went red" | `forge shepherd <pr> --pull --json` (read `failures[]`) |
| "Keep watching / babysit my PRs" | ensure `forge shepherd daemon` running |
| Read incremental deltas | `forge shepherd events <pr> --since <seq>` |

## Boundaries (kept — true of both modes)

- **Never merges.** No merge action, no server-side auto-merge latch. Terminates at `MERGE_READY` and hands off — a human merges in the GitHub UI.
- **Never resolves review threads.** It refreshes a single **sticky** status comment; thread *resolution* is semantic and stays with `review`.
- **Action ladder.** Tier-A (autonomous, idempotent): re-run a flaky **required** check (rerun-budget capped); refresh the single **sticky** status comment — an *upsert*, never an append, so the ~60s daemon loop cannot post duplicate comments. Tier-B (opt-in, default OFF): `--auto-rebase` rebases onto base and force-pushes with lease — a lease rejection is a hard-stop, never re-armed. Tier-C: everything else escalates (incl. `CI_DEAD_HEAD` recovery, which needs the maintainer `FORGE_PR_TOKEN`).
- **Required-check gate.** `MERGE_READY` only when the branch-protection required set is *known* and all green; if protection is unreadable, it escalates rather than guessing.
- **HEAD-changed abort.** Before any mutating action it re-reads the head SHA and aborts if HEAD moved.

## Adjacent skills

- Fixing review feedback (CodeRabbit/Greptile/human comments, resolving threads) → `review`.
- Opening or pushing the PR → `ship`.
- Post-merge health (CI green on main, close issues) → `verify`.
- "Where am I / what's in flight" orientation → `status`.

## Kill-switches

```bash
FORGE_SHEPHERD_DISABLE=1        # env: makes the shepherd trigger inert (once the auto-fire wiring lands, W-S4c)
forge gate disable rail.auto_shepherd   # config gate honored by the trigger + ship/push arming
```

Both leave the manual `forge shepherd` surface usable; they only stop the automatic daemon fire.

## State

Progress is durable in GitHub (PR comments, labels, `git`). The one local store is the per-PR journal under `.forge/pr-monitor/<repo>-<pr>/` (append-only `events.ndjson` + snapshot/consumer cursors) — the replay surface for `events --since`. The bounded one-shot pass keeps no separate local state.
