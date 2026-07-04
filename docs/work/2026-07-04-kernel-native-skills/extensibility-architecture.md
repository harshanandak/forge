# Forge Extensibility — Toggle-Driven Workflow Assembly

Status: design (no code). Date: 2026-07-04.
Companion to `super-skill-orchestrator.md` (the flagship) and `design.md` (the sub-skill catalog).

## 0. The one idea

Forge ships a **default assembly**: canonical skills (`skills/*/SKILL.md`) wired into
change-class **profiles** (`lib/workflow-profiles.js`). A user re-carves that assembly
with **one config file** and a few `forge` verbs — never by editing Forge's code. Three
move-sizes, smallest first: **toggle** a knob, **swap** a part, and (last resort)
**fork-and-edit** a part.

We do **not** invent a config system. We reuse three seams that already exist, each for
the job it already does:

| Seam (existing) | Existing job | Reused here as |
|---|---|---|
| `.forge/config.yaml` + its schema-validated reader `loadRuntimeGraphConfig` / `getResolvedRuntimeGraph` (`lib/core/runtime-graph.js`) | per-project runtime-graph overrides — already models `workflow.phases.<id>.enabled`, `workflow.gates.<id>.enabled`, `rails.*`, `adapters.*`, `planning.template` | **THE single config surface** (add sibling `roles` + `ideology` sections beside the ones it already validates) |
| `forge.lock` + `forge add` + `forge audit` (`forge-lock.js`) | provenance + trust + SHA-512 integrity ledger keyed by `name` | **trust ledger** for any swapped-in / forked part |
| canonical `skills/` + `.skills/` shadow + per-agent sync (`skills-sync.js`) | copy `SKILL.md` verbatim; `.skills/` overrides `skills/` on name collision | **swap + fork materialization** of skill files |

The read side is the **already-shipped `forge options` inspector** (`lib/commands/options.js`:
`stages|gates|adapters|diff|why|lint [--json]`), which already resolves
`defaults ⊕ .forge/config.yaml` into a JSON graph view via `getResolvedRuntimeGraph`. We
**extend** it (add `roles`/`ideology` views and a `forge options <role> --json` slice); we do
not invent it.

> **Correction to an earlier draft (verified against source 2026-07-04).** A prior version made
> `.forge/adapters.json` "THE surface" and claimed `.forge/config.yaml` "has no reader or writer
> in the repo." That is factually wrong: `.forge/config.yaml` is the *implemented,
> schema-validated* surface (`runtime-graph.js:8` `CONFIG_SOURCE`), consumed across `init.js`,
> `issue-backend.js`, `sync-backend.js`, and `protected-state-surfaces.js`, and it already
> validates `workflow.gates.<id>.enabled` toggles (`applyEnabledConfig`, runtime-graph.js:519).
> `.forge/adapters.json` is only a legacy per-project review-adapter registry
> (`setAdapterEnabled` hardcodes `config.review`, `adapter-cli.js:260-263`). **So config.yaml is
> the surface; the one missing primitive is a *sparse writer* for it — not a new file, and not a
> generalization of the `review`-only adapters.json writer.**

---

## 1. The single config surface — `.forge/config.yaml` (extended)

Today `loadRuntimeGraphConfig` (`runtime-graph.js:436`) already reads this file and its
schema-validators already honor **stage** and **gate** toggles plus rails/adapters/planning
overrides:

```yaml
# .forge/config.yaml — the shape the reader ALREADY validates today
workflow:
  phases:
    phase.plan: { enabled: true }          # stage toggle  (applyEnabledConfig)
  gates:
    gate.plan-exit: { enabled: true }      # gate toggle   (applyEnabledConfig, already honored)
rails:
  tdd_intent: { enabled: true }            # L1 rail (locked — cannot disable)
adapters:
  review: { enabled: true }                # review adapter config
planning:
  template:
    mode: full                             # full | partial
    partialInvocation: { skip: [] }        # CLOSED enum: canonical-plan sub-skills only (§2)
```

We add **two sibling sections** next to the ones it already validates — `roles` and
`ideology` — each the same `{ <key>: { …fields } }` primitive the reader already walks
(`readConfigSection`). New sections are additive and backward-compatible; every existing key
keeps working untouched. Full resolved shape with the additions:

```yaml
version: 1
profile: standard                          # which default assembly (lib/workflow-profiles.js)

roles:                                      # role -> bound skill + ideology  (SWAP point)
  brainstorm: { skill: plan,     ideology: design-first }
  plan:       { skill: plan,     ideology: design-first }
  dev:        { skill: dev,      ideology: strict-tdd }   # ← now carries an ideology (§ story 3)
  validate:   { skill: validate }
  ship:       { skill: ship }
  review:     { skill: review }
  verify:     { skill: verify }
  merge:      { onPass: handoff }           # handoff (default, safe) | auto-merge  (§3 / story 2)

workflow:
  gates:                                    # human + structural gates on/off  (TOGGLE point)
    gate.intent:        { enabled: true }   # human  (new graph gate, §3.A)
    gate.plan-approval: { enabled: true }   # human  (new graph gate, §3.A)
    gate.merge:         { enabled: true }   # human  (new graph gate, §3.A)
    gate.plan-exit:     { enabled: true }   # structural (already modeled)

ideology:                                   # a role's internal knobs  (TOGGLE / named SWAP)
  plan:
    brainstorm_depth: 5                     # 0 = skip Q&A, 2 = light, 5 = full
    security_analysis: true                 # OWASP pass on/off
    web_research: optional                  # required | optional | skip
    ripple_analyst: true
    yagni_filter: true
    hard_gate: strict                       # strict | relaxed
  dev:                                      # ← dev knobs now exist (§ story 3)
    tdd: strict                             # strict | spec-first | relaxed

adapters:
  review: { enabled: true }                 # EXISTING section — unchanged
```

`roles` keys are role names; `workflow.gates` keys are gate ids; `ideology` keys are role
names. Anything absent falls through to the profile default (§4). The file is **sparse**: it
records only overrides, so a fresh repo has no `.forge/config.yaml` gate/role keys at all and
runs on defaults.

The **one missing primitive** is a *sparse writer* for config.yaml (read-modify-write YAML,
via the existing `YAML.stringify` util already used by `init.js`). It is NOT a generalization of
the `review`-only `adapters.json` writer — that legacy path stays where it is. CLI verbs are thin
wrappers over that one writer:

```
forge role  plan --use my-plan              # roles.plan.skill = my-plan            (SWAP)
forge role  plan --ideology spec-first      # roles.plan.ideology = spec-first      (named SWAP)
forge role  dev  --ideology spec-first      # roles.dev.ideology = spec-first       (named SWAP)
forge role  merge --on-pass auto-merge      # roles.merge.onPass = auto-merge       (SWAP, opt-in)
forge gate  disable gate.merge              # workflow.gates.gate.merge.enabled=false (TOGGLE)
forge gate  enable  gate.intent
forge options set plan.security_analysis false   # ideology knob                    (TOGGLE)
forge options --json                        # print RESOLVED assembly (read side, §4)
```

---

## 2. Role → skill binding (swap the plan skill; pick its ideology)

**Swap the skill.** `roles.<role>.skill` names a skill. Resolution of that name reuses the
existing skills precedence verbatim (`skills-sync.js` / `packages/skills` sync):

```
.skills/<name>/SKILL.md   (installed or forked shadow — wins on collision)
        >  skills/<name>/SKILL.md   (canonical, shipped default)
```

To bind a bring-your-own plan skill:
1. Place it at `.skills/my-plan/SKILL.md` (or `skills add my-plan` from the registry).
2. `forge add .skills/my-plan/SKILL.md --name my-plan` → records provenance + `sha512` in
   `forge.lock` (`addLockEntry`, local files inside root are `trusted:true`, hashed).
3. `skills sync` materializes it into each agent dir (`.claude/skills/…`, `.codex/skills/…`).
4. `forge role plan --use my-plan` → `roles.plan.skill = "my-plan"`.

Now the orchestrator (§4) invokes `my-plan` wherever it would have invoked `plan`. `forge audit
verify` recomputes the hash and **fails on drift**, so a swapped part is tamper-evident.

**Pick the ideology.** Two granularities, both already-native move-sizes:
- *Named ideology (a SWAP):* `roles.<role>.ideology = "spec-first"` selects a bundle that ships
  **with the bound skill**, at `<resolved-skill-dir>/ideologies/<name>.json` (resolved via the
  same `.skills/ > skills/` precedence). For canonical `plan` that is
  `skills/plan/ideologies/{design-first,spec-first,lightweight}.json`; for a BYO `my-plan` it is
  `.skills/my-plan/ideologies/<name>.json`. A bundle is just a preset block of the §1
  `ideology.<role>.*` knobs. **The named ideology is validated only against the bundles present
  in the resolved skill dir — never against a Forge-source enum** — so a BYO skill carries its
  own thinking-styles.
- *Individual knobs (TOGGLES):* `ideology.plan.security_analysis=false`,
  `brainstorm_depth=0`, etc. These override the named bundle key-by-key.

**The closed `PLAN_SUBSKILL` enum does not block any of this.** `validatePlanSubSkillList`
(`runtime-graph.js:636`, throws `UNKNOWN_PLAN_SUBSKILL`) governs exactly one thing:
`planning.template.partialInvocation.only/skip` — the *within-canonical-plan* on/off list for
the shipped plan sub-skills. It is scoped to the canonical `plan` template only. A `roles.*.skill`
binding is a **different artifact** whose name and ideology are open-world (validated for *trust*
via `forge.lock` hash, not against `PLAN_SUBSKILL_IDS`). So swapping in a genuinely
different-ideology skill is never rejected as an "unknown sub-skill."

This closes the gap the seam audit flagged: `plan/SKILL.md` runs a fixed 5-dimension /
OWASP-mandatory procedure today and ignores the inert `tdd`/`research` fields on the profile.
Here those become **read** inputs (§4), and the same read path (`forge options <role> --json`)
carries the ideology into *every* role skill, not just plan (§8).

---

## 3. Gates toggled yes/no

Two gate families; both **declared** in the one surface, different **enforcers**:

**A. Human / workflow gates — enforced by the orchestrator.**
`gate.intent`, `gate.plan-approval`, `gate.merge` (the three from
`super-skill-orchestrator.md §3`). *These are not in the default graph yet* — today the graph
ships only the structural evidence gates `gate.plan-exit / dev-exit / validate-exit /
ship-entry` (`runtime-graph.js:324-347`). The increment is small and mechanical: **add the three
human gates as graph gates** so the *existing* `workflow.gates.<id>.enabled` reader
(`applyEnabledConfig`, runtime-graph.js:519) honors them and `forge options gates --json` reflects
them for free. The orchestrator then reads `gate.<name>.enabled`; `false` ⇒ it does not pause at
that point and proceeds autonomously. The consumer is the orchestrator; no second config home.

**Merge: turning the gate off ≠ auto-merging.** These are two independent moves, and the design
now keeps them independent so each is a clean single move:

1. **Stop pausing (TOGGLE):** `forge gate disable gate.merge` → `workflow.gates.gate.merge.enabled
   = false`. The orchestrator no longer pauses for human approval at MERGE_READY. **By itself this
   merges nothing** — it just removes the pause.
2. **Perform the merge (SWAP of a default-OFF executor) — PLANNED (§8), not yet shipped:** the
   merge role would carry an on-pass action, `roles.merge.onPass`. NOTE: this is design intent —
   the shipped `forge role` CLI today supports only `--use`/`--ideology` (`lib/commands/role.js`);
   the `onPass` field and the `--on-pass` flag are future work. Two intended values:
   - `handoff` — **default**. Present the PR and stop (today's behavior; honors the
     never-auto-merge invariant: `pr-shepherd.js:11`, `ship/SKILL.md:218,243`).
   - `auto-merge` — a Forge-provided executor that would ship OFF. `forge role merge
     --on-pass auto-merge` would opt in. The executor runs `gh pr merge --auto` **only when the
     family-B CI/review gates resolve green** (it reads `forge options gates --json`, see B),
     so "once CI + review pass" is the executor's own precondition.

   This converts "auto-merge" from *"the user must author a missing merge action"* (the old
   contradiction) into *"the user swaps `roles.merge.onPass` to an existing shipped part."* The
   safety invariant is preserved because the shipped default is `handoff`; auto-merge is a
   deliberate, tamper-evident opt-in (the executor is a tracked adapter under
   `forge.lock`/`audit verify`). Forge authoring the `auto-merge` executor is a one-time build
   increment (§8); the *user's* move stays a clean swap. Disabling `gate.merge` **without**
   swapping `onPass` simply falls through to `handoff` with no pause — never a silent merge.

**B. Mechanical CI / hook gates — enforced by lefthook / CI.**
`commitlint`, `tdd-check`, `lint`, `tests`, `doc-gate`, `protected-state`. These live in
`lefthook.yml` / `.github/workflows`, not in the orchestrator. The surface is the **single
declaration point** (`gates.lint.enabled`, `gates.tests.enabled`, `gates.doc-gate.enabled`, …);
honoring it requires a **thin reader** added to each hook — the same "config written but not yet
consumed" gap the adapter `enabled` flag has today. Map to what already exists so the increment
is small:

| Gate | Declared as | Enforcement today | Wiring increment |
|---|---|---|---|
| lint / tests / branch-protection (pre-push) | `gates.{lint,tests,branch-protection}` | all-or-nothing skip via `.forge-push-token` (`check-forge-token.js`) | per-gate check reads surface before running |
| doc-gate (CI) | `gates.doc-gate.enabled` | `no-docs-needed` PR label / `.docgate.json` (`gate.js:310`) | CI passes `--skip` when surface says off |
| protected-state (pre-commit) | `gates.protected-state.surfaces` | `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` env | script reads surface list |
| tdd-check / commitlint | `gates.{tdd,commitlint}.enabled` | hardcoded (interactive only) | hook reads surface flag |

Bare-bones rule: **declare all gates in the surface now; wire family A immediately (orchestrator
already reads the surface), wire family B hook-by-hook as an incremental follow-up.** No gate
ever gets a second config home.

---

## 4. How the orchestrator reads it — one resolver, `forge options`

The orchestrator super-skill must not parse markdown stage tables. It calls **one** read-side
verb that resolves the layered config into a flat JSON view:

```
forge options gates --json      # SHIPPED today: resolved gate/stage/adapter primitives
forge options --json            # whole resolved assembly (extend to include roles/ideology)
forge options plan --json       # NEW slice: the plan role's resolved skill + ideology
```

`forge options` is the **shipped inspector** (`lib/commands/options.js`) over
`getResolvedRuntimeGraph`. It already computes, for gates/stages/adapters:

```
resolved = shipped_defaults  ⊕  profile(profile)  ⊕  .forge/config.yaml overrides
```

We add two views to it: the `roles`/`ideology` sections in the whole-assembly output, and a new
`forge options <role> --json` slice that returns `{ role, skill, ideology }`. Resolution order
(last wins, sparse merge): (0) hardcoded shipped defaults → (1) the named change-class
**profile** from `lib/workflow-profiles.js` (its `stages`, `tdd`, `research`) → (2) the surface's
`roles` / `workflow.gates` / `ideology` overrides.

Orchestrator loop, per work item:
1. `forge options --json` → resolved assembly (profile chosen by change-class per
   `super-skill-orchestrator.md §5`; a docs typo yields a profile with `intent` skipped).
2. For each stage in `resolved.stages`: read `gates.<gate>.enabled` → pause or drive through.
3. Resolve `roles.<role>.skill` → invoke that skill (name resolved via `.skills/ > skills/`).
4. Pass `forge options <role> --json` (its ideology slice) as invocation context, so the skill
   branches on `security_analysis`, `brainstorm_depth`, etc.

Because both the orchestrator **and** a directly-invoked skill read the same
`forge options <role>`, a `/plan` run alone honors the identical config — the surface is
authoritative, single-sourced, and never duplicated.

---

## 5. Default assembly the user re-carves (defaults + overrides)

Three layers, additive:

- **Layer 0 — shipped defaults (canonical, committed).** `skills/*/SKILL.md` + the six profiles
  in `lib/workflow-profiles.js` (critical / standard / simple / hotfix / docs / refactor). A
  clean checkout runs entirely on this. No `.forge/config.yaml` roles/gates keys required.
- **Layer 1 — profile selection.** `profile` (or `forge setup --type=<profile>`, already stored
  in `.forge/context.json`) picks which default assembly. This is the coarse re-carve: the whole
  stage set, tdd stance, and research stance shift at once.
- **Layer 2 — surface overrides.** `.forge/config.yaml` overrides individual roles, gates, and
  ideology knobs. Sparse; only what you changed.

Reset = delete the relevant key (fall back to profile) or the whole file (fall back to
defaults). "Re-carving" is always additive edits over a working default — never a rewrite of the
Forge tree. `forge audit verify` proves the parts you carved (via `forge.lock`) still match
their recorded hashes.

---

## 6. Toggle vs Swap vs Fork-and-edit

Decision rule: **prefer the smallest move that expresses the change.** Toggle → Swap → Fork.

| Move | What it is | Where it lands | Provenance | Example |
|---|---|---|---|---|
| **Toggle** | flip a boolean/enum already exposed | one key in `.forge/config.yaml` | none | `forge gate disable gate.merge`; `forge options set plan.security_analysis false` |
| **Swap** | rebind a role/ideology/on-pass action to a **different existing artifact** | `roles.*.skill` / `roles.*.ideology` / `roles.merge.onPass` / `adapters.*` | if external, `forge add` (trust+hash) then `skills sync` | `forge role plan --use my-plan`; `forge role dev --ideology spec-first`; `forge role merge --on-pass auto-merge` |
| **Fork-and-edit** (last resort) | copy a canonical part, edit the copy, then swap to it | `.skills/<name>/SKILL.md` or `.forge/adapters/<kind>/<name>.js` (shadow) | **required** — `forge add <path> --name <n>`, tracked by `forge audit verify` | copy `skills/plan` → `.skills/plan-fork`, edit, `forge add`, `forge role plan --use plan-fork` |

- **Toggle** when the behavior is already a knob. No new files, instantly reversible.
- **Swap** when a *different but existing* part does what you want (a registry skill, a shipped
  ideology bundle, another review adapter). You point a role at another head; you don't author
  behavior.
- **Fork-and-edit** only when neither a toggle nor a swap can express it. You now own a divergent
  copy; the cost is that `forge.lock` + `audit verify` must track it, and you re-sync on upstream
  changes yourself. This is the deliberate "hammer and shovel" escape hatch — powerful, and last.

---

## 7. Naming & guardrails

- **No "kernel" on the surface.** Config keys are role/gate/ideology names; the flagship is
  named per `super-skill-orchestrator.md §6` (e.g. `forge-flow`). "kernel" stays in code/docs only.
- **One surface, one resolver.** All toggles/swaps live in `.forge/config.yaml`; all reads go
  through `forge options`. Nothing gets a second config home. (`.forge/adapters.json` stays the
  legacy review-adapter registry only; it is not extended.)
- **Already hardened:** `.forge/config.yaml` is **already** on the protected-state surface
  (`protected-state-surfaces.js:57`), so raw edits are gated and the `forge` verbs (the sparse
  writer) are the sanctioned path — no extra work needed for this guardrail.

## 8. Minimal build increments

1. **Sparse `.forge/config.yaml` writer** (read-modify-write via the `YAML.stringify` util already
   used by `init.js`) + thin verbs `forge gate`, `forge role`, `forge options set`. Writes to the
   schema-validated surface; does NOT touch the legacy `adapters.json` `review` writer.
2. **Extend `forge options`** (`lib/commands/options.js`) with `roles`/`ideology` in the resolved
   view and a new `forge options <role> --json` slice = defaults ⊕ profile ⊕ config.yaml.
3. **Reader for `roles` + `ideology` sections** in `runtime-graph.js` (siblings to
   `workflow.gates`), with **open-world** validation: role names are known, but skill/ideology
   names are checked against the resolved skill dir — never against `PLAN_SUBSKILL_IDS` (§2).
4. **Add the three human graph gates** `gate.intent / gate.plan-approval / gate.merge` to the
   default graph so the *existing* `workflow.gates.<id>.enabled` reader honors them (§3.A). The
   orchestrator reads `forge options --json` and honors `gates` (family A) + `roles`.
5. **Generalize ideology-reading to EVERY role skill, not just plan.** Each canonical
   `skills/<role>/SKILL.md` reads `forge options <role> --json` and branches on its ideology slice.
   Ship the bundles: `skills/plan/ideologies/*.json` **and** `skills/dev/ideologies/{strict-tdd,
   spec-first}.json` (dev branches its RED-GREEN-REFACTOR HARD-GATE, `dev/SKILL.md:112-120`, on
   `ideology.dev.tdd`) — closes the inert-`tdd`/`research`-fields gap for dev as well as plan
   (stories 1 + 3).
6. **Ship the `auto-merge` on-pass executor (default OFF)** bound via `roles.merge.onPass`; it runs
   `gh pr merge --auto` only when family-B gates resolve green (story 2). Tracked under
   `forge.lock` / `audit verify`; `handoff` stays the shipped default so the never-auto-merge
   invariant holds out of the box.
7. Wire family-B gate hooks (lint/tests/doc-gate/…) to read the surface, one hook at a time.

---

## 9. First implementation slice

The single smallest end-to-end thing to ship. It is the **one primitive every story needs** — a
sparse writer for the surface — proven against the reader that *already exists*, so the slice adds
the least new code that is still a real vertical.

**The slice = the sparse `.forge/config.yaml` writer + two thin verbs, read back through the
resolver.**

- **Config file / field:** `.forge/config.yaml`.
  - gate-toggle field: `workflow.gates.<id>.enabled` — **reader already exists**
    (`applyEnabledConfig`, runtime-graph.js:519) and `forge options gates --json` already prints it.
  - role-swap field: `roles.<role>.skill` — needs one small reader fn (`applyRoleConfig`) plus one
    line in `lib/commands/options.js` for the `forge options <role> --json` slice.
- **One gate-toggle path:** `forge gate disable gate.plan-exit` ⇒ writes
  `workflow.gates.gate.plan-exit.enabled: false`. This is the true end-to-end proof: **zero new
  read code** — the shipped resolver already reflects the flip.
- **One role-swap path:** `forge role plan --use my-plan` ⇒ writes `roles.plan.skill: my-plan`,
  surfaced by `forge options plan --json` (rides the same writer + the tiny `applyRoleConfig`).

**New code (bare-bones):**
1. `lib/config-writer.js` — `setConfigOverride(projectRoot, keyPath, value)`: load config.yaml (or
   `{}`), set the nested key, `YAML.stringify`, write. (~15 lines; reuses the util `init.js` uses.)
2. `bin/forge.js` — two command cases: `gate` (`disable|enable <id>` → `workflow.gates.<id>.enabled`)
   and `role` (`<role> --use <name>` → `roles.<role>.skill`), each a one-liner over the writer.
3. `applyRoleConfig` reader in `runtime-graph.js` + the `forge options <role> --json` slice in
   `lib/commands/options.js`.

**TDD — the RED test (write this first):**

- File: `test/config-writer.test.js`
- Name: **`forge gate disable gate.plan-exit writes workflow.gates.gate.plan-exit.enabled=false and forge options gates --json reflects it`**
- Body: in a temp project with no `.forge/config.yaml`, invoke the `gate` handler for
  `disable gate.plan-exit`; assert the written YAML contains
  `workflow.gates.gate.plan-exit.enabled === false`; then resolve `forge options gates --json` and
  assert `gate.plan-exit.enabled === false`.
- Why it is RED today: neither `lib/config-writer.js` nor the `forge gate` verb exists. It goes
  GREEN with **only** increment 1 + the `gate` case — *no new reader*, because the shipped
  `applyEnabledConfig` / `forge options gates --json` already consume the field. That is the whole
  point of picking this vertical first: it exercises write → existing schema-validated read in one
  test, the smallest closed loop on the real surface.
- Sibling test (same slice, same writer, drives the role-swap half):
  **`forge role plan --use my-plan writes roles.plan.skill and forge options plan --json returns skill=my-plan`**
  — this one also forces `applyRoleConfig` + the `<role>` slice (increment 3).

**Ship-first RED is the gate test**; the role-swap sibling follows immediately on the same writer.
Everything else (ideology bundles, human gates, the `auto-merge` executor) layers on top of this
one writer + resolver seam.
