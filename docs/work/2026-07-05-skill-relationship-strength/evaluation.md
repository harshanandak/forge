# Skill Relationship Strength — Evaluation

Date: 2026-07-05 · Branch surveyed: `skills/split-fat-bodies`
Scope: how strongly the Forge stage skills reference/hand off to each other, and
whether the `plan` sub-skills (design / research / strategy) are independently
strong yet composable. Evidence is from `skills/<name>/SKILL.md` and
`.claude/rules/workflow.md`; every claim cites `file:line`.

Companion: [`../2026-07-05-efficiency-extensibility-strategy`](../2026-07-05-efficiency-extensibility-strategy)
(the token-economy / extensibility pillars this audit is measured against).

## Verdict at a glance

| Relationship | Strength today | Gap |
|---|---|---|
| `plan → dev → validate → ship → review → verify` (linear) | **Strong** — hard `stage-transition` handoffs at every exit | — |
| `plan` owns design + research + strategy as one stage | **Strong** as a stage; **weak** as independently-invokable sub-skills | `research` = legacy alias; `strategy`/`design` have no standalone entry |
| `ship ↔ shepherd ↔ review` | **Weak** — shepherd is an island | no handoff in or out; absent from every flow diagram |
| `dev ↔ validate` | **Half-strong** — hard one direction only | failure loop back to dev is soft prose; validate debugs inline, bypassing dev's quality bar |

Two of the three things you asked to strengthen (shepherd triangle, dev↔validate)
are genuinely weak today; the third (plan owning design/research/strategy) is
**done well at the stage level** but its sub-skills are not yet independently
invocable.

## 1. The linear pipeline — strong (keep)

Every stage exit is a hard, recorded handoff, not prose:
`dev→validate` (`dev/SKILL.md:302`), `validate→ship` (`validate/SKILL.md:248`),
`ship→review` (`ship/SKILL.md:182`), `review→verify` (`review/SKILL.md:386`),
each gated by a HARD-GATE exit block. This backbone is solid and should not change.

## 2. `plan` as the unified planning stage — strong at the stage level

- Owns intent → research → task-list as **one** stage: "plan owns intent →
  research → task-list setup as one stage" (`plan/SKILL.md:9-11`).
- Three phases behind progressive-disclosure reference files:
  `references/phase1-design.md`, `phase2-research.md`, `phase3-setup.md`
  (`plan/SKILL.md:144-154`).
- A **callable sub-skill graph**: `plan.intent_capture / plan.parallel_research /
  plan.parallel_critics / plan.synthesis / plan.final_lock` (`plan/SKILL.md:22-28`).
- **Partial invocation already supported**: "Run only the requested/required
  sub-skill when the user asks for partial planning work" (`plan/SKILL.md:30`), plus
  `--only=critics` / `--only=lock` flags (`plan/SKILL.md:74-75`).

Design + research + strategy are genuinely consolidated here. This part of the ask
is complete; the remaining work (§3c) is exposing the sub-nodes as first-class
invocations.

## 3. Where it is NOT strong — the three asks

### 3a. shepherd is an island (`ship ↔ shepherd ↔ review`)

- **Declared out of the workflow**: "shepherd is a **utility command, not a
  workflow stage**" (`shepherd/SKILL.md:22`). It appears in **zero** flow diagrams
  (`.claude/rules/workflow.md`, `CLAUDE.md`, and the ship/review integration
  diagrams all show `plan→dev→validate→ship→review→verify` with no shepherd node).
- **No handoff IN**: ship hands to review (`ship/SKILL.md:182`); review hands to
  verify (`review/SKILL.md:386`). Neither records a handoff to shepherd — it is
  named only in frontmatter discriminators, never invoked by a sibling.
- **No handoff OUT**: shepherd terminates at `MERGE_READY` and hands to the human
  (`shepherd/SKILL.md:41`); its verdict feeds nothing downstream (not verify).
- **Pre-merge gate is duplicated** in ship AND review (`shepherd/SKILL.md:22`),
  while shepherd — the thing that actually automates poll-to-green — sits outside
  both.

Net: the "watch the open PR to merge-ready" role is real but disconnected.
`ship → review → (shepherd monitors) → verify` is a triangle in concept and three
separate islands in wiring.

**Strengthen:**
1. Have review (and ship, when there is no review feedback to resolve) record an
   explicit `stage-transition <id> review shepherd` (monitor-to-merge-ready), so
   the pipeline routes *through* shepherd instead of past it.
2. Give shepherd a `MERGE_READY → verify` handoff so its verdict re-enters the
   pipeline (human merges, then verify runs).
3. Consolidate the pre-merge gate into **one** referenced definition that ship,
   review, and shepherd all point at — instead of each re-describing it.
4. Add shepherd to the flow diagrams as the post-review monitor, so it is
   discoverable as part of the route, not a hidden utility.

### 3b. `dev ↔ validate` is one-directional

- `dev → validate` is hard (`dev/SKILL.md:302`). `validate → dev` is only soft
  prose (`validate/SKILL.md:13` "that is `/dev`", `:143` "TDD tests from /dev phase").
- On failure, validate runs its **own inline debug** (4-phase debug mode D1–D4) and
  then fixes or stops — it does **not** re-enter dev's reviewed TDD loop
  (implementer → spec reviewer → quality reviewer). A real code defect found at
  validate is therefore repaired **without dev's quality bar**.

**Strengthen:**
1. Classify validate failures: trivial (lint/format) fix inline; **real defect →
   explicit loop back** into dev's TDD subagent loop, recorded as a reopen
   (`stage-transition validate dev`), not ad-hoc debugging.
2. Share **one** quality bar: dev's spec+quality reviewers and validate's
   code-review step should reference the same criteria file, so "passes dev" and
   "passes validate" cannot diverge.
3. Optional: dev runs a validate-preflight (type/lint on touched files) before
   declaring done, so the handoff rarely bounces.

### 3c. research / strategy / design are not independently strong

`plan` is composable internally, but the standalone entry points are not real:

- **research** is a 43-line legacy alias: "It is now embedded in `/plan` as Phase 2"
  (`research/SKILL.md:30`), "Jump to Phase 2 of `/plan` manually"
  (`research/SKILL.md:34`). Invoking it just tells you to go run plan — it is not an
  independently-strong research skill.
- **strategy**: no skill at all — only a `--strategic` flag on plan
  (`plan/SKILL.md:72`).
- **design**: no skill — it is plan Phase 1 (`references/phase1-design.md`).

So "when only a small thing is needed, invoke just research / strategy / design" is
**not cleanly supported**: the sub-skill graph (`plan.*`) exists but is not exposed
as first-class invocable units, and the one alias that exists (research) is a
redirect, not a runnable skill.

**Design fork — efficiency vs fragmentation** (this is the decision to make):

- **Option A — thin invocable aliases over the sub-nodes.** Keep ONE `plan` skill;
  turn `research` into a real thin wrapper that runs `plan --only=parallel_research`
  at full depth, and add equally-thin `strategy` / `design` entries over
  `plan.intent_capture` / `--strategic`. Each is invocable standalone AND composed
  by plan; near-zero added routing surface. **Recommended** — it is exactly the
  "efficiency + depth" you described and it uses the sub-skill graph you already
  built.
- **Option B — promote each to a full standalone skill** with its own body + evals.
  Maximum independent depth, but +2–3 skills of description/routing surface (cuts
  against the token-economy pillar) and risks drift from plan.
- **Option C — leave as-is**, and document that partial planning = `plan
  --only=<node>`. Zero new surface, but the discoverability gap stays (users will
  not know research/design/strategy are runnable alone).

## Priority

1. **§3a shepherd wiring** — biggest structural gap; an entire role is disconnected.
2. **§3c invocable research/strategy/design aliases** — directly delivers "invoke
   just the small thing" (Option A).
3. **§3b dev↔validate failure loop + shared quality bar**.

The linear pipeline (§1) and plan-as-stage (§2) are already strong and should be
left alone.
