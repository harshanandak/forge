# Forge — Consolidated Vision & Roadmap (2026-07-04)

Single source of truth tying together the threads raised in this session, so planning
stays coherent. Companion to: `2026-07-04-kernel-native-skills/{design,super-skill-orchestrator,extensibility-architecture,decisions}.md`
and `2026-07-04-info-architecture-eval/evaluation.md`.

## The layered vision (bottom = foundation)

**L1 — Information architecture (the backbone).** Kernel records the linkage chain:
issue → worktree → work-folder (`docs/work/<date>-<slug>/` with design/tasks/decisions/research)
→ files. Per-work `decisions.md` roll up into a project design registry → grouped by
component (`docs/architecture/subsystems/*`) → irreversible ones frozen as ADRs → the
whole tree + memory published as an **OKF** bundle navigated via `AGENTS.md`.

**L2 — Extensibility substrate (mostly BUILT).** `.forge/config.yaml` toggle-config
(`workflow.gates.*`, `roles.<role>={skill,ideology,onPass}`); verbs `forge gate`/`forge role`/`forge options`;
human gates as durable kernel **events** (`gate approve/reject/status/check`); first
kernel-native skills `triage-ready` + `issue-basics`. Ships #283/#285/#286.

**L3 — Flagship `smith` orchestrator (SPECCED).** A super-skill that composes the stage
sub-skills with first-class human gates (intent/plan-approval/merge, as gate events),
**autonomy calibrated in planning by issue size × importance × complexity** (higher stakes
→ more checkpoints). Superpowers-inspired. Built LAST so it's born reading gate state.

**L4b — Cross-agent memory + `ctx` (DECISION).** Cross-agent memory lives in the KERNEL
(agent-agnostic, git-synced via export↔hydrate) — NOT in per-agent stores like `~/.claude`
(Claude-only). The kernel already holds events/interactions/comments + migrated memory records.
Luca's **`ctx` (`ctxrs/ctx`) is the RECALL layer** (index kernel memory + work-folders + decisions
→ semantic query for agents + the front-end), NOT the store; complementary, and distinct from the
`context-mode` plugin (context-window protection). Open fork: adopt ctx as-is vs port kernel-native
vs alongside — lean kernel-native + ctx-inspired (no external dep). Sequencing: DOWNSTREAM — build
at P3 (needs P0 linkage + memory→git bridge); decision lockable now, build later.

**L4 — Agent-agnostic self-improvement.** `insights` (recurring-pattern detection over the
kernel event log) → propose a skill → human-confirm → create SKILL.md + eval → reuse.
Lift Hermes's self-improvement DOWN into forge (CLI+kernel) so ANY harness
(Claude/Codex/Cursor/Hermes) inherits it. **Depends on L1** (need the kernel to record
what-work-happened-where to detect recurrence).

**L5 — Front-end (observability + control panel).** Renders kernel data (leases=workers,
events=activity, issue+gate state=planned/running/done) + live GitHub when linked; AND a
write-UI over L2 (swap skills, toggle gates/hooks, approve gates). Delivery mode UNDECIDED
(localhost web / Windows desktop / hosted server). Sync = git `export↔hydrate` (BUILT)
first; server only for real-time/no-git cross-device.

**L6 — Sharing & cross-team.** Skill marketplace (skills portable via git; import via
`forge add`/`forge.lock`; registry + multi-user = net-new/server). Cross-team sync/see/
correct = the multi-user/server escalation (NOT built).

**L7 — Agent-native hooks.** Today: lefthook (git-level, shared) + a Codex-native seed
(`lib/agents/codex.plugin.json`: SessionStart/PreToolUse/PostToolUse). Want: native hooks
per agent (Claude `settings.json`, Cursor, Hermes) wired to forge gates — adapt better
across the 4 supported agents (Hermes/Cursor/Claude/Codex).

## Current state (shipped this session)

- beads→kernel migration (12 PRs) + **auto-migration on install** (#281).
- Reliability: per-agent actor identity (#282); de-beaded PR tooling + verify auto-close for
  kernel UUIDs (#284).
- Extensibility L2: config surface (#283), core skills (#285), gate-events (#286).
- Designs: sub-skill catalog, `smith` orchestrator (+autonomy calibration), extensibility
  architecture, and the information-architecture evaluation.

## Info-architecture eval verdict (where the foundation stands)

| Layer piece | Progress | The gap |
|---|---|---|
| Skill testing/eval | 22% | Engine built; only 2/15 skills have eval data |
| **Kernel linkage** | **18%** | `kernel_worktrees` is schema-only/0-writes — kernel stores NONE of the linkage (P0) |
| Architecture roll-up | 18% | 60 `decisions.md`, but 0 component/ADR content; no promotion mechanism |
| OKF | 25% | Full tooling, never activated; memory non-OKF + outside git |

Engines/conventions exist; **the wiring between stages does not.** The kernel linkage is
the least-built and the unblock for L4/L5/L1-rollup.

## Open decisions (for the user)

1. Front-end delivery mode: localhost web vs Windows desktop vs hosted server.
2. When to introduce multi-user/server (cross-team, marketplace).
3. Naming: LOCKED — flagship `smith`, umbrella `compass`.

## Sequencing (pressure-tested by planning advisor — TWO PARALLEL TRACKS)

Advisor correction: `smith` is NOT serialized behind the info-architecture — it depends only
on the shipped L2 substrate (#283/#285/#286) + `claim-safety`. Run two tracks concurrently.

**Track 1 — Information architecture:**
- **P0 — Kernel linkage backbone (critical path, single most important move).** `forge worktree create`
  triggers the claim write-path (already exists: `schema.js:134`, `broker.js:617`) → records
  issue→worktree→work-folder→files; machine-readable `issue_id` front-matter in work-folders;
  orient-by-id (replaces the "most-complete-folder" heuristic). `/plan` writes the claim. Unblocks L4, L5, roll-up, memory.
- **P1 — Decision roll-up.** `decisions.md` → component `subsystems/*` + ADR promotion mechanism. Hand-seed first content.
- **P3 — OKF publish (LAST).** Activate tooling + memory→git bridge. Don't publish an empty architecture layer.

**Track 2 — Orchestration (parallel to Track 1):**
- **`claim-safety`** (SLEEPER — was missing; prereq for smith, else lease bugs in the flagship) → **thin `smith` v1**.

**Parallel-anytime (dependency-free):** eval data-fill (do the 5 pipeline-critical commands first —
`/plan`, `/ship` especially, since they WRITE the P0/P1 linkage); a CI-safe "every skill has `evals.json`" static check.

**Gated on P0:** `insights→skill` extraction (L4). **After P0 + smith:** P5 front-end. **Last:** P6 agent-native hooks / skill marketplace / cross-team+server.

**Deferrable decisions (advisor):** front-end mode → decide at P5 (localhost-web = cheapest reversible default);
server/multi-user → forced only by P6, not P5 (git `export↔hydrate` covers sync until a 2nd concurrent consumer exists).
**Only rule to honor now: all reads/writes go through the CLI/kernel API so a server can slot behind it later.**

**Over-valued / defer:** OKF publish before P1 has content; filling all 13/15 evals (do 5 pipeline-critical); marketplace/cross-team design.

**Candidate feature — native conditional auto-merge (promote `settle-merge.sh`).** Today
`shepherd` deliberately NEVER merges (hands off to human at MERGE_READY, per the
test-enforced never-auto-merge-by-default invariant); the settle-merge auto-merge used all
session is a bash stopgap. Promote it to a native, OPT-IN (default-OFF), condition-gated
forge feature — the designed `roles.merge.onPass: auto-merge` executor — with user-set
conditions in `.forge/config.yaml` (required checks known + all green + 0 unresolved threads
+ settle window + not-behind-base). Implement as `shepherd` Tier-B (like its existing
`--auto-rebase`) or the onPass executor. Independent of P0 — small standalone (logic already
proven in `scratchpad/settle-merge.sh`). Preserves the invariant because it's opt-in only.

Not a fixed checklist — a **customizable merge-RULES ENGINE** (hammer-and-shovel applied to
merge). A merge is allowed only when ALL configured rules pass, evaluated over a **PR context**
(comments/timestamps/actors/checks/threads/reviews from the GitHub API). Composable built-in
conditions: `checks_green`, `threads_resolved`, `not_behind`, `min_approvals: N`,
`settle_min: N` (time since last comment), `idle_min: N` (time since last activity),
`last_comment_by: X`, `approved_by: [account]`, `not_commented_by: Z`. Composition = AND by
default + any-of groups + NOT. Extensible seam: for odd/bespoke rules, a user drops in a
**custom predicate** (an expression over PR context, or a bring-your-own script registered via
`forge add` like an adapter). Declared in `.forge/config.yaml`; later clickable in the front-end
control panel. Same pattern as the rest of the system: configure built-ins + fork-point for your own.

**Candidate feature — lifecycle AUTOMATION engine (generalizes the merge gate; issue 482251b7).**
The merge-rules engine is ONE node of a broader `on <event> · when <conditions> · run <action>`
automation across the PR lifecycle (checks → review → merge), NOT merge-only. Building blocks
already exist: #289's PREDICATE engine = the reusable "when" (extract it out of merge-specificity),
gate events (#286) = lifecycle state to trigger on, the unified review-adapter design
(2026-07-03-unified-review-system) = BYO review agents, and **GitHub Actions = the runtime** (forge
orchestrates ON TOP of GHA — reads GHA check state as conditions, dispatches `workflow_dispatch`/
`repository_dispatch` as actions; never replaces CI). Config: `automations: [{on, when:[preds], run}]`
in `.forge/config.yaml`; actions = dispatch-a-GHA-workflow / run-a-review-adapter / merge / comment /
label. User example: `on checks_completed when checks_green run dispatch coderabbit-review` →
`on review_completed when review_clean+threads_resolved run merge`. Depends on the review-adapter +
predicate-engine extraction; build after the current wave.

## Already built — do NOT rebuild
Eval engine (`eval_win.py`, `run-command-eval.js`, `behavioral-judge.sh`), OKF tooling
(`okf.js`, `doc-gate.js`), governance scaffolding (`architecture/index.md`, `subsystems/README.md`,
`adr/README.md` templates), work-folder convention, git `export↔hydrate` sync substrate,
`forge add`/`forge.lock` import mechanism, `forge insights` pattern detector.
