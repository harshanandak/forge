# Forge Layered Skeleton — Config Architecture (refined)

Pivot model: **Layer 1 Core (locked)** + **Layer 2 Defaults (toggleable/swappable)** + **Layer 3 User overrides (`patch.md`)**.
User clarification: *"It's not deleting, it's turning off."* Toggling is first-class; `disabled` stages remain known and re-enableable.

---

## TOGGLE CONFIG — `.forge/config.yaml`

```yaml
forge: 1                              # schema version
core:                                 # Layer 1 (locked, read-only echo)
  - tdd-gate
  - branch-protection
  - hard-gate-runtime
stages:                               # Layer 2 — order = execution order
  plan:     { enabled: true }
  dev:      { enabled: true }
  validate: { enabled: false, reason: "team runs validation in CI" }
  ship:     { enabled: true }
  review:   { enabled: true, block: "@acme/forge-stage-pr-triage@1.2" }
  premerge: { enabled: true }
  verify:   { enabled: true }
gates:                                # per-gate toggles inside stages
  validate.security-scan: { enabled: false }
  ship.greptile-quality:  { threshold: 3 }   # swap, not disable
adapters:
  issue-tracker: beads                # or: linear, jira, none
  shell:        auto                  # auto | bash | pwsh
patches:                              # Layer 3
  - patch.md                          # user code-level overrides, applied last
```

Resolution order: `core` (frozen) → `stages/gates/adapters` (defaults, user-overrideable) → `patch.md` (free-form code/text patches keyed by anchor IDs in default blocks).

---

## AGENT API — introspection commands

The agent NEVER reads YAML directly. It calls these:

1. `forge options stages` — JSON list `[{id, enabled, locked, source, block}]`
2. `forge options gates --stage validate` — gates and their state
3. `forge options adapters` — resolved adapter bindings
4. `forge options diff` — what user config changed vs defaults
5. `forge options why <id>` — explains enabled/disabled/locked, cites `source` (core | default | config | patch.md:line)
6. `forge options lint` — validates schema + warns on disabled-but-required combinations
7. `forge run <stage> --dry-run` — shows what would execute given current toggles, without side effects

---

## "OFF" SEMANTICS

A disabled stage is **known, addressable, and recordable** — never silent.

| State | Behavior |
|---|---|
| `enabled: true` | Runs normally. |
| `enabled: false` | `forge run <stage>` **refuses by default** with a single-line notice: `stage 'validate' is disabled in .forge/config.yaml (reason: ...). Re-enable with: forge stages enable validate`. Exit code 0. The next stage in the matrix becomes the new transition target — `enforce-stage.js` skips disabled stages when computing `nextStages`. |
| `--force` | One-shot run of a disabled stage; logged to state. |
| Core item | Cannot be disabled; `forge options why` shows `locked: core`. |
| Required-by-classification | `forge options lint` warns (e.g., `critical` workflow with `validate: false`) but does not auto-enable. |

Stage-disable propagates: `WORKFLOW_STAGE_MATRIX` (lib/workflow/stages.js:42) is filtered through the config at runtime so `canTransition()` and `assertTransitionAllowed()` already understand the user's reduced path.

---

## UNIQUE ADVANTAGES TO PRESERVE

1. **Frozen stage matrix + transition enforcement** — `WORKFLOW_STAGE_MATRIX`, `assertTransitionAllowed`, `STAGE_MODEL` (`lib/workflow/stages.js:42-201`). Toggling must filter this matrix, not replace it.
2. **Stateful stage entry guard** — `enforceStageEntry` with `STATELESS_ENTRY_STAGES`, override input parsing, repaired-health diagnostics (`lib/workflow/enforce-stage.js`). Layer 1 must keep this.
3. **Classification-driven workflows** — six classifications (critical/standard/refactor/simple/hotfix/docs) each map to a different stage path (`AGENTS.md` + `stages.js:42`). Toggling is *per stage*, classifications stay as canonical paths.
4. **Multi-agent command sync** — `scripts/sync-commands.js` fans `.claude/commands/*.md` into 7 agent dirs (claude/cursor/codex/opencode/...). The skeleton must keep agent-agnostic command authoring.
5. **Conversational enforcement + Beads accountability** — `AGENTS.md` "offer solutions, create follow-up issues for skips". Disabling a stage should auto-offer a Beads issue for the gap, not just silently drop coverage. Plus the `forge` CLI abstraction (`lib/commands/*.js` — `push`, `worktree`, `clean`, `sync`, `test`) hides OS/beads/lefthook quirks; toggles must route through it.

---

## OPEN QUESTIONS

1. **Patch granularity:** Is `patch.md` a single file with anchor-ID blocks (`<!-- forge:anchor stage.review.body -->`), or a directory `patches/<stage>.md`? Anchors need to be declared in default blocks to be patchable.
2. **Disabled-but-required policy:** When a `critical` change is classified and `validate` is off, do we (a) hard-refuse classification, (b) auto-promote validate for that run, or (c) warn + require `--accept-risk` plus a Beads issue?
3. **Block distribution:** Are stage "blocks" (e.g., `@acme/forge-stage-pr-triage`) npm packages, git refs, or local paths? This decides registry/lockfile design (`skills-lock.json` precedent exists) and CI trust model.
