---
name: smith
description: >
  The flagship Forge orchestrator super-skill. Given a goal or a ready issue, it
  COMPOSES the existing stage skills (triage-ready · claim-safety · plan · dev ·
  validate · ship · review · verify) into the right path for the work — driving
  autonomously BETWEEN human gates and pausing AT them. It invents no stage logic;
  it picks the path, enforces the human gates as durable kernel events, and (during
  planning) calibrates how many human checkpoints the work needs from its size ×
  importance × complexity. Use to run a whole piece of work end to end under human
  control. Trigger on "orchestrate this issue", "drive plan to merge", "run the
  whole workflow", "take this to done", "smith", or "autonomous but gated".
allowed-tools: Read, Bash(forge:*)
---

# Smith — the orchestrator super-skill

Smith is the Forge analog of a meta-skill: a **thin orchestrator** that composes
the stage skills into the *right path for this work*. It is maximally *driving*
but human-*gated* — it works autonomously between gates and stops at them to loop
the human in. It adds no new stage behaviour; every step below is an existing
skill or `forge` verb. The judgement smith supplies is **which path to take** and
**how densely to involve the human**.

`kernel` is the internal event store — never surface that word to users. Smith is
the flagship skill; the sub-skills are its callable set.

## The orchestration procedure

1. **Pick work.** Invoke `triage-ready` (read-only): rank the ready queue with
   `forge issue ready --json`, explain why the top pick is workable, and hand off
   ONE issue. Never claim epics/decisions.

2. **Claim safely.** Invoke `claim-safety`: `FORGE_ACTOR=<actor> forge claim <id>`,
   then **prove the lease** with `forge issue owns <id>` (exit 0 = owned). A claim's
   `ok:true` does not by itself prove ownership. If NOT owned → do not work it;
   reselect via `triage-ready`.

3. **Calibrate autonomy (planning phase).** Read the issue's **size × importance ×
   complexity**, map it to an autonomy tier (see below), and **PROPOSE** that tier —
   i.e. which human gates to enforce — at the intent gate. The human confirms or
   overrides. This read extends the existing change-classification
   (critical/standard/simple/hotfix/docs/refactor); the tier selects the REQUIRED
   gate set. **Uncertainty fails toward oversight:** a low-confidence read defaults
   to MORE gates, never fewer. The human always wins.

4. **Drive the stages.** Take the path that fits the change class:
   `plan → dev → validate → ship → review → verify`. A docs typo skips
   brainstorming and most of the ladder; a critical feature runs the full ladder
   (intent brainstorm → design doc + task DAG → per-task TDD → validate → PR →
   address review → post-merge verify). Invoke each stage skill as its step is
   reached; smith sequences them, it does not reimplement them.

5. **Stop at every enabled human gate.** Human gates are durable **kernel events**,
   not prose. Before proceeding past a gate, run:

   ```bash
   forge gate check <issue> <gate>     # exit 0 iff the gate is DISABLED or APPROVED
   ```

   - **exit 0** → satisfied (approved, or disabled for this repo) → proceed.
   - **non-zero** → STOP. Tell the human to run
     `forge gate approve <issue> <gate> [--reason "…"]` (or
     `forge gate reject <issue> <gate> --reason "…"` to send it back). Do not
     advance until `check` passes. Inspect history any time with
     `forge gate status <issue> [--json]`.

   Because approvals are recorded events, smith **re-checks on resume** and survives
   compaction/crash — a gate approved before a restart stays approved.

6. **Before close.** Re-invoke `claim-safety` (`forge issue owns <id>` again — a
   lease can be reclaimed on expiry), then run the release-readiness gate:

   ```bash
   forge release check --target <version> --json   # success:true ⇒ healthy
   ```

   Close only when ownership holds AND readiness is healthy:
   `forge close <id> --reason "…"`, then `forge sync`.

## The three human gates

Registered in the runtime graph as approval-satisfied events (`requires: []`),
additive to the evidence exit-gates. Each is toggleable via
`workflow.gates.<id>.enabled`; a disabled gate makes `check` return satisfied.

| Gate | Fires | Meaning |
|------|-------|---------|
| `gate.intent` | before planning/brainstorm | Human agrees the goal + proposed autonomy tier before any design |
| `gate.plan-approval` | after design doc + task DAG, before `dev` | Human approves the plan (or redirects) |
| `gate.merge` | after `review`, before merge | Human approves the PR/merge |

(Evidence exit-gates — `gate.plan-exit`, `gate.dev-exit`, `gate.validate-exit`,
`gate.ship-entry` — are satisfied by artifacts inside the stage skills, not by a
human; smith relies on the stage skills' own HARD-GATES for those.)

## Autonomy calibration — stakes → gate density

Smith proposes a tier at `gate.intent`; the human enacts add/drop by
`forge gate enable|disable <gate-id>` (repo default) and smith enforces every
*enabled* gate via `check`.

| Tier | Stakes read | Enforced human gates | Extra checkpoints |
|------|-------------|----------------------|-------------------|
| **Lean** | small · simple · low-importance (docs typo, one-line fix) | just `gate.merge`, or none under CI | skip the intent brainstorm; lean on CI + evidence gates |
| **Standard** (default) | ordinary feature/bug | `gate.intent` · `gate.plan-approval` · `gate.merge` | the evidence exit-gates as configured |
| **High** | large · important · or complex (critical feature, risky refactor) | all three human gates, enabled | per-milestone / per-task human check-ins (pause + `forge comment`), an explicit pre-ship review pass |

Mechanics (reuses what exists, invents nothing): the tier maps to which gate
EVENTS are required for this issue. Because they are per-issue events, the human
can add or drop a checkpoint mid-flight and smith re-reads it via `check` /
`status` on the next step. Higher stakes → more checkpoints so the work stays on
point; lower stakes → run lean.

## Composition map — smith invents nothing

| Step | Composed skill / verb |
|------|-----------------------|
| Pick work | `triage-ready` (`forge issue ready/blocked/stats`) |
| Claim + prove | `claim-safety` (`forge claim` → `forge issue owns`) |
| Human gates | `forge gate check/approve/reject/status <issue> <gate>` |
| Plan | `plan` (intent brainstorm → design doc → task DAG) |
| Build | `dev` (per-task implementer → spec → quality TDD) |
| Validate | `validate` (types · lint · security · tests) |
| Ship | `ship` (push + PR) |
| Review | `review` (address CI / bot feedback) |
| Verify | `verify` (post-merge health) |
| Release readiness | `forge release check --target <version> --json` |

## Reliability

- **Human always wins; fail toward oversight.** Smith only *proposes* a tier; a
  low-confidence assessment defaults to MORE gates. A rejected gate sends the work
  back, it does not proceed.
- **Resume-safe.** Gate approvals are durable kernel events; re-check with `check`
  after any interruption rather than trusting memory.
- **Prove ownership twice** — after claim and again before `close`/`release`.
- **Never bypass** — no `LEFTHOOK=0`, no `--no-verify`. A failed gate or hook is a
  stop, not an obstacle to route around.

## Fork points

Smith is a **default assembly**, not a fixed ladder — re-carve it:

| Knob | Default | How to change |
|------|---------|---------------|
| **Stakes heuristic** | size × importance × complexity → tier | Re-weight (e.g. weight blast-radius or reversibility higher), or map your own change-classes to tiers. |
| **Tier → gate set** | lean / standard / high as above | Change which human gates each tier enforces; enact per repo with `forge gate enable\|disable <gate-id>`. |
| **Gate density** | intent · plan-approval · merge | Add a checkpoint (enable a gate; add a per-milestone pause) or drop one (disable it) — the human overrides smith's proposal at `gate.intent`. |
| **Composed flow** | triage → claim → plan → dev → validate → ship → review → verify | Skip stages by change class (docs typo → doc-only path), reorder, or swap a sub-skill for your own `plan`/`dev`/`review` adapter. |
| **Release target** | `forge release check` default target | Pass `--target <version>` for the release you are certifying. |

Smith is the assembled hammer; the sub-skills are the head and handle; the gates
are the grip adjustments. Give the parts + a good default, then let users re-carve.
