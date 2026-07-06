# Autonomy calibration & human gates — reference

Read this when you are calibrating how much to involve the human on a specific
issue, or when you need the exact gate commands and IDs. `SKILL.md` carries the
procedure; this file carries the lookup tables and the reasoning behind them.

## The three human gates

Forge registers three human gates in the runtime graph as **approval-satisfied
events** (`requires: []`), additive to the evidence exit-gates. They are the
points where smith pauses and hands control to the human.

| Gate | Fires | What the human is deciding |
|------|-------|----------------------------|
| `gate.intent` | before planning / brainstorm | Do we agree on the goal, and on the autonomy tier smith proposed, before any design work? |
| `gate.plan-approval` | after the design doc + task DAG exist, before `dev` | Is this plan the right one (approve), or should it be redirected? |
| `gate.merge` | after `review`, before merge | Is the PR good to merge? |

The evidence exit-gates — `gate.plan-exit`, `gate.dev-exit`,
`gate.validate-exit`, `gate.ship-entry` — are a different kind: they are
satisfied by artifacts *inside* the stage skills (a design doc, TDD tests,
validation output), not by a human. Smith relies on each stage skill's own exit
checks for those and does not gate on them itself.

### Why gates are events, not prose

Each approval is written to the issue's event stream as a durable
`gate.approved` / `gate.rejected` record. That is what makes a gated run
**resume-safe**: if smith is interrupted by a crash or a context compaction, it
re-reads the event with `check` / `status` on resume and knows whether it may
proceed — instead of re-asking the human or guessing from memory. Prose in a
transcript cannot survive a compaction; an event can.

### Gate commands

```bash
forge gate check <issue> <gate>              # exit 0 iff the gate is DISABLED or APPROVED
forge gate approve <issue> <gate> [--reason] # human records approval (durable event)
forge gate reject  <issue> <gate> --reason   # human sends the work back
forge gate status  <issue> [--json]          # list this issue's gate events (who/when)
forge gate enable|disable <gate-id>          # repo default toggle: workflow.gates.<id>.enabled
```

`check` is the enforcement primitive smith calls before advancing past a gate. It
exits 0 when the gate is disabled for the repo *or* an approval event exists, so a
disabled gate simply falls through — that is how a lean tier skips a checkpoint.

## Autonomy calibration — stakes → gate density

Match checkpoint density to what is at stake. A one-line docs fix and a risky
refactor need very different amounts of oversight: forcing the docs fix through a
full brainstorm wastes everyone's time, while letting the refactor run unattended
risks a large wrong turn. Smith reads the issue's **size × importance ×
complexity**, proposes a tier at `gate.intent`, and the human confirms or
overrides.

| Tier | Stakes read | Enforced human gates | Extra checkpoints |
|------|-------------|----------------------|-------------------|
| **Lean** | small · simple · low-importance (docs typo, one-line fix) | just `gate.merge`, or none under CI | skip the intent brainstorm; lean on CI + the evidence exit-gates |
| **Standard** (default) | an ordinary feature or bug | `gate.intent` · `gate.plan-approval` · `gate.merge` | the evidence exit-gates as configured |
| **High** | large · important · or complex (critical feature, risky refactor) | all three human gates, enabled | per-milestone / per-task human check-ins (pause + `forge comment`), an explicit pre-ship review pass |

### How a tier is enacted

The tier maps to *which gate events are required* for this issue. The human enacts
add/drop with `forge gate enable|disable <gate-id>` (the repo default), and smith
enforces every *enabled* gate via `check`. Because approvals are per-issue events,
the human can add or drop a checkpoint mid-flight and smith re-reads it on the next
step — the calibration is not frozen at planning time.

### Why uncertainty adds gates rather than removing them

Smith only *proposes* a tier; it never lowers oversight on its own. When its read
of size/importance/complexity is low-confidence, it defaults to **more**
checkpoints, because an unwanted extra approval is a few seconds of the human's
time, while a missed one can mean a large amount of wasted or wrong work. The
human always wins the final say.

## Composition map — smith invents nothing

Every step is an existing skill or `forge` verb; smith only sequences them.

| Step | Composed skill / verb |
|------|-----------------------|
| Pick work | `triage-ready` (`forge issue ready` / `blocked` / `stats`) |
| Claim + prove ownership | `claim-safety` (`forge claim` → `forge issue owns`) |
| Human gates | `forge gate check` / `approve` / `reject` / `status` |
| Plan | `plan` (intent brainstorm → design doc → task DAG) |
| Build | `dev` (per-task implementer → spec → quality TDD) |
| Validate | `validate` (types · lint · security · tests) |
| Ship | `ship` (push + PR) |
| Review | `review` (address CI / bot feedback) |
| Verify | `verify` (post-merge health) |
| Release readiness | `forge release check --target <version> --json` |
