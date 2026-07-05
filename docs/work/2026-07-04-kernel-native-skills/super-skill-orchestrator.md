# The Forge Super-Skill Orchestrator — deep design

Status: design exploration (no code). Companion to `plan.md` (the sub-skill catalog).
Prompted by the decision that the flagship should not be a "worker" but a **super-skill**:
a main agent that independently understands and orchestrates the sub-skills, loops the
human in (brainstorming-style) at the right moments, and never leaks "kernel" to users.

---

## 1. What it is (one sentence)

A single top-level **orchestrator super-skill** that, given a goal or a piece of ready
work, composes the existing stage sub-skills (plan · dev · validate · ship · review ·
verify) into the *right path for this work*, running autonomously **between** human
gates and pausing **at** them — the Forge analog of `using-superpowers`, not a hardcoded
plan→ship script.

## 2. Superpowers inspiration (concrete mapping)

| Superpowers | Forge super-skill |
|---|---|
| `using-superpowers` meta-skill — always pick the right skill first | The orchestrator inspects the work + change-class and picks the next sub-skill |
| Process skills (brainstorming, systematic-debugging) set the approach | `plan` (intent brainstorming) and `triage-ready` are process-first — they run before any implementation |
| Implementation skills carry it out | `dev`/`validate`/`ship`/`review`/`verify` are invoked as needed |
| Priority: process → implementation | Orchestrator enforces "capture intent before you build" as a HARD gate |

The point of "super-skill" is **orchestration + judgement about when to loop the human**,
not blind autonomy.

## 3. Human-in-the-loop is the spine, not a feature

Autonomy ≠ absence of the human. The orchestrator is maximally *driving* but human-*gated*:

- **Intent gate (brainstorming loop).** Before planning, run one-question-at-a-time Q&A
  to capture design intent (the brainstorming pattern). Human-driven. No leap to code.
- **Plan-approval gate.** After the design doc + task DAG are produced, the human approves
  (or redirects) before `dev`.
- **Merge/ship gate.** Human approves the PR/merge (or a *configured* gated auto-merge).
- **Between gates:** the agent works autonomously (TDD per task, validate, address review).

Gates are **configurable** (ideology): a user can toggle a gate on/off via the config surface
(`forge gate enable|disable`, which only flips *existing* gate ids). Adding, removing, or
reordering a gate is a runtime-graph/schema change, not a config flip. Default = the three above. This is "conversational autonomy": drive between gates,
steer at gates.

## 3b. Autonomy calibration — `smith` sets the human-loop density in planning

The number and frequency of human gates is NOT fixed. During the **planning phase**
`smith` reads the issue's **size × importance × complexity**, maps it to an autonomy tier,
and PROPOSES that tier at the intent gate; the human confirms or dials it up/down. Higher
stakes → more checkpoints so the work stays on point; low stakes → run lean.

- **Low stakes** (small · simple · low-importance — e.g. a docs typo, a one-line fix):
  minimal loops — often just a final merge gate, or fully autonomous under CI gates.
- **Standard:** the default three — intent · plan-approval · merge.
- **High stakes** (large · important · or complex — a critical feature, a risky refactor):
  MORE loops — intent brainstorm, design-approval, per-milestone / per-task check-ins,
  pre-ship review, and merge — the human is involved at more points.

Mechanics (reuses what exists, invents nothing):
- The size/importance/complexity read **extends the existing change-classification**
  (critical/standard/simple/hotfix/docs/refactor). The chosen tier selects which gate
  events are REQUIRED for that issue.
- Because gates are kernel events (§9), the required-gate set is recorded per-issue; the
  human can add or drop a checkpoint mid-flight and `smith` re-reads it.
- The mapping (stakes → gate density) is itself a **fork point** — retune it in
  config/`ideology`, or override `smith`'s proposed tier for a single issue at the intent gate.
- **Human always wins, and uncertainty fails toward oversight:** `smith` only *proposes* a
  tier; a low-confidence assessment defaults to MORE loops, never fewer.

## 4. How each autonomy option affects the pipeline (the ask)

- **Execute→stop-at-validate.** Orchestrator owns dev+validate only; human owns plan and
  ship. → It is NOT a super-skill "planning all the things" — it's a mid-pipeline executor.
  Under-delivers on the vision, but is the smallest safe increment.
- **Full pipeline WITH human gates (the vision).** Orchestrator drives brainstorm→plan→
  dev→validate→ship→review→verify via the sub-skills, pausing at the 3 gates. This is the
  super-skill: it plans (with the human), executes, and ships (human-gated). Risk is
  controlled by the gates, not by amputating stages.
- **Triage/sequence-only.** A router, not a worker. Doesn't match "main working agent."

**Reading of your intent:** the target is *Full-pipeline orchestration with first-class
human gates* — reframed so "autonomy" means "drives the whole flow but stops to involve
you at intent, plan-approval, and merge."

## 5. Workflow explosion (one goal → the whole flow)

```
goal / ready issue
  └─[intent gate: brainstorming loop with human]→ design intent
       └─ research (if needed)
            └─ plan → design doc + task DAG
                 └─[plan-approval gate]→ human approves
                      └─ for each task: dev (implementer→spec→quality TDD)
                           └─ validate (types · lint · security · tests)
                                └─ ship → PR
                                     └─ review (address CI/bot feedback)
                                          └─[merge gate]→ human approves
                                               └─ verify (post-merge health)
```

Not every item needs every stage — the orchestrator picks the path by **change
classification** (critical / standard / simple / hotfix / docs / refactor, already a
setup profile). A docs typo skips brainstorming; a critical feature runs the full ladder.

## 6. Naming — keep "kernel" internal

"Kernel" is the internal event-sourced store (`.git/forge/kernel.sqlite`). It must not
surface in user-facing skill/agent names.

- **Super-skill (the flagship): LOCKED → `smith`** (see `decisions.md`). Considered but not
  chosen: `forge-flow`, `flow`, `operator`, `conductor`, `driver` (avoid `autopilot` — implies
  no human).
- **Existing `kernel` umbrella skill: LOCKED → rename to `compass`** (see `decisions.md`). Its
  ROLE (index/router that documents the issue verbs) stays; only the name changes. Considered:
  `forge`, `workflow`, `orient`, `surface`.
- **Internal code / issue store:** stays "kernel" — it's an implementation term, fine in
  source and docs, not in the skill surface a customer reads.

Decision needed from the user (they flagged "come back to this").

## 7. Ideology fit — the super-skill is itself a fork point

The orchestrator is a **default assembly**, not a fixed ladder. Users can:
- edit which sub-skills it composes and in what order,
- move/remove/add the human gates,
- swap a sub-skill for their own (bring-your-own `plan`/`dev`/review adapter).

The super-skill is the assembled hammer; the sub-skills are the head and handle; the
gates are the grip adjustments. Give them the parts + a good default, let them re-carve.

## 8. Build sequencing (revised)

The orchestrator composes the sub-skills, so the **parts come first**:

0. **actor-identity kernel fix** (prereq — distinct per-agent actor/session so lease
   conflicts fire; tracked `d71a824b`).
1. **triage-ready** (read-only: ready/blocked/stats) — feeds the orchestrator.
2. **claim-safety** (rewritten: verify `show --json`.`claimed_by == own actor`, handle
   lease expiry/reclaim).
3. sub-skills already exist (plan/dev/validate/ship/review/verify) — wire them as the
   orchestrator's callable set; add the human-gate contract to `plan` and `ship`.
4. **the orchestrator super-skill** (renamed) — built LAST, on top, thin: pick path →
   invoke sub-skills → enforce gates. e2e two-worker + gated-run tests.
5. **backlog-hygiene**; DEFER the autonomous `backlog-groomer`.

## 9. Open questions for the user

1. Confirm the target = **full-pipeline orchestration with the 3 human gates** (vs
   execute→validate as a first increment)?
2. **Naming**: super-skill name + whether to rename the `kernel` umbrella skill.
3. **Default gate set**: intent + plan-approval + merge — right three? Any change-classes
   that should auto-skip the intent gate by default (e.g. docs/hotfix)?
4. Scope of *this* build round: ship the sub-skills (0–2) now and design the orchestrator
   contract, or build the orchestrator end-to-end in one pass?
