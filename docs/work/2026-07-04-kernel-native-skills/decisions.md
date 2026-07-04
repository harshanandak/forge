# Kernel-native skills + super-skill — locked decisions (2026-07-04)

Single source of truth for the decisions steering the build. Companion to `design.md`
(sub-skill catalog), `super-skill-orchestrator.md`, and `extensibility-architecture.md`.
Confirmed by the user after a cross-verify audit + a Fable guidance pass.

## Naming (user-facing; "kernel" stays internal-only)
- **Flagship super-skill orchestrator → `smith`** (`/smith`). Forge-native; a smith drives
  the forge end-to-end. Replaces the working title "kernel-worker".
- **Umbrella / orientation-router skill → `compass`** (renames the current `kernel` skill).
  Says what it does (find your way / what to work on / status) without the overloaded
  "orient" baggage. Its job (index + route to stage skills + document issue verbs) is
  unchanged; only the name changes. Update its cross-refs; new skills register through it.
- Internal store stays "kernel" in code/docs; never in a user-facing skill/command name.

## Architecture decisions (from Fable guidance, adopted)
- **Human gates are enforced by kernel EVENTS, not skill prose.** Record gate approvals as
  kernel events on the issue (e.g. `gate.approved:<gate-id>` by actor `human`). `ship`
  (and the relevant stage) refuses to proceed without the required gate event UNLESS that
  gate is toggled off. → evidence-checked HARD-GATEs + resume-from-kernel-state for free.
  Add a real verb `forge gate approve <issue> <gate>` that writes the event; define the
  rejection/redirect path (which stage a rejection loops back to).
- **Autonomy is calibrated in planning, not fixed.** `smith` reads the issue's size ×
  importance × complexity, maps it to an autonomy tier, and PROPOSES it at the intent gate;
  the human confirms or overrides. Higher stakes → MORE human checkpoints (design-approval,
  per-milestone/per-task check-ins, pre-ship review); low stakes → run lean. Extends the
  existing change-classification; the tier selects which gate EVENTS are required per-issue;
  the stakes→gate-density mapping is a fork point; low-confidence assessment fails toward
  MORE oversight. (See super-skill-orchestrator.md §3b.)
- **One flagship, not two.** `smith` is THE orchestrator; the old `kernel-worker` is just
  `smith` pointed at the ready queue (a loop over triage-ready). Do NOT ship a second
  overlapping agent.
- **Ideology delivery = skill self-reads.** A bound skill reads `forge options <role> --json`
  itself, so a direct `/plan` and an orchestrated `/plan` behave identically. (Not
  "orchestrator passes the slice".)
- **Config surface = `.forge/config.yaml`** (the shipped schema-validated reader in
  `lib/core/runtime-graph.js`), NOT `.forge/adapters.json` (demoted to legacy review
  registry). Additive sections: `roles.<role> = {skill, ideology, onPass}`,
  `ideology.<role> = {knobs}`, plus existing `workflow.gates.<id>.enabled`. The closed
  `PLAN_SUBSKILL_DEFINITIONS` enum is scoped to `planning.template.partialInvocation` only,
  so it never blocks a BYO role skill.
- **Write-time validation:** `forge role` / `forge gate` reject unknown skill/ideology/gate
  ids at WRITE time, not mid-run.
- **Reliability prereq (build step 0):** wire a distinct per-agent actor into the kernel
  issue context so the lease-conflict guard can distinguish agents. Distinct-actor
  precedence: `FORGE_ACTOR` env → worktree id → session id → fallback `forge`. Tracked as
  kernel issue `d71a824b`.
- **never-auto-merge invariant preserved:** merge stays a human handoff. Auto-merge is a
  shipped, default-OFF, CI-gated `roles.merge.onPass` swap — NOT in v1. The existing
  never-auto-merge TEST is UPDATED to assert default-OFF handoff, not deleted.

## v1 scope (bare-bones, shippable)
SHIP: `triage-ready`, `claim-safety`, `issue-basics` (Beads-verb parity floor),
`backlog-hygiene`, the config-writer + `forge gate`/`forge role` verbs, the 3 human gates
as kernel events, and the thin `smith` orchestrator. Ideology bundles for **plan + dev
only**.
DEFER: `insights-tuning`, `graph-forensics`, `snapshot-portability`, `memory-handoff`,
`extend-kernel`, `dependency-planning`, the auto-merge executor, family-B (hook/CI) gate
wiring, `backlog-groomer` agent.

## Build order (two parallel tracks; gate-events land BEFORE the orchestrator)
- **Track A (reliability):** (0) actor-identity fix → `claim-safety`.
- **Track B (surface):** (1) config-writer slice (`forge gate`/`forge role` + sparse
  `.forge/config.yaml` writer, read back via `forge options`) → (2) the 3 human gates as
  kernel events (+ `forge gate approve`) → (3) `triage-ready` + `issue-basics`.
- Then **`smith`** (thin, last — born reading gate state), then `backlog-hygiene`,
  then rename `kernel` skill → `compass`.

## First slice being built now
Track A (0) actor-identity fix + Track B (1) config-writer — two parallel worktrees, TDD.
