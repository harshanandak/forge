# Forge v3 Redesign Strategy

**Date**: 2026-04-28 (originally) → 2026-04-29 (sections marked SUPERSEDED inline by iterations #5–#7)
**Status**: Reference doc — **canonical "where we ended up" is now [FINAL-THESIS.md](./FINAL-THESIS.md)** + **release roadmap is [release-plan.md](./release-plan.md)** (D39). This doc retains its strategic framing but several sections have been superseded by D21–D39 (memory architecture, audit collapse, stage model, harness narrowing, release versioning, kill criteria). See inline SUPERSEDED notes.
**Supersedes**: [v2 unified strategy](../2026-04-06-v2-unified-strategy/unified-strategy.md) (preserved for historical reference)
**Superseded by (in part)**: [FINAL-THESIS.md](./FINAL-THESIS.md), [locked-decisions.md](./locked-decisions.md) (D21–D38)
**Source design docs (same folder)**:
- [v3-skeleton-plan.md](./v3-skeleton-plan.md)
- [layered-skeleton-config.md](./layered-skeleton-config.md)
- [extension-system.md](./extension-system.md)
- [skill-generation.md](./skill-generation.md)
- [skill-distribution.md](./skill-distribution.md)
- [beads-operations-manifest.md](./beads-operations-manifest.md)
- [building-block-pivot.md](./building-block-pivot.md)

---

## 1. Document Purpose

This is the **v3 redesign of the Forge unified strategy**. It is a fresh master doc, not a patch on top of v2.

The v2 doc (`docs/work/2026-04-06-v2-unified-strategy/unified-strategy.md`) is preserved as historical reference. It captured the v2 thesis — "wrap, don't rewrite; ship an opinionated 7-stage TDD workflow as a monolith" — and is still useful for understanding why specific defaults (rubric thresholds, beads-as-spine, the 7-stage shape) were chosen the way they were.

v3 reflects a **structural pivot** prompted by adoption signal: the *shape* of the v2 workflow is right, but the *specifics* leak — rubric thresholds, the exact stage count, beads-as-mandatory-spine, and review-gate strictness all vary by team. v3 reframes Forge as a **layered skeleton with toggleable defaults** rather than a fixed pipeline. Same opinions, expressed as defaults instead of as hard-coded behavior.

This doc keeps the section structure of v2 so readers can map old → new mentally. Where v2 said "this is the workflow", v3 says "this is the default workflow; here is how a project replaces it."

---

## 2. The Pivot in One Diagram

```
+------------------------------------------------------------+
| L4  USER PROFILE      ~/.forge/profile/                    |
|     personal defaults, sync via git, optional server later |
+------------------------------------------------------------+
                              ^ overrides
+------------------------------------------------------------+
| L3  PROJECT OVERRIDES  .forge/patch.md  (+ patches/)       |
|     hybrid index + auto-extract over 40 lines              |
+------------------------------------------------------------+
                              ^ overrides
+------------------------------------------------------------+
| L2  SWAPPABLE DEFAULTS  forge-defaults/                    |
|     v2 7-stage workflow, beads adapter, rubric gate,       |
|     review parsers, eval harness — replace any of these    |
+------------------------------------------------------------+
                              ^ overrides (LIMITED)
+------------------------------------------------------------+
| L1  LOCKED RAILS       forge-core/                         |
|     handoff schema, hard safety, lifecycle contract,       |
|     extension manifest spec — L1 ALWAYS WINS               |
+------------------------------------------------------------+
```

Resolution order: **L1 → L2 → L3 → L4**. Later layers override earlier, except L1 cannot be overridden. The runtime computes an effective config tree at session start and emits it to `.forge/.cache/effective-config.json` for inspection via `forge options why <id>`.

---

## 3. What Changed from v2 → v3

### Side-by-side thesis

| Dimension | v2 thesis | v3 thesis |
|---|---|---|
| Shape | Fixed 7-stage TDD workflow shipped as monolith | Layered skeleton: locked rails + swappable defaults + project patches + user profile |
| Customization | Edit Forge source / fork the repo | `.forge/config.yaml` toggles + `patch.md` overrides + extension marketplace |
| Stage count | 7, hard-coded in `WORKFLOW_STAGE_MATRIX` | 7 by default, but `stages.<id>.enabled: false` collapses to any subset |
| Issue tracker | Beads is the spine; everything binds to it | Beads is the **default L2 adapter**; pluggable via the adapter contract |
| Rubric gate | Built into core | Default L2 gate, tunable in `patch.md`, replaceable by extension |
| Distribution | Single `bunx forge setup` install | Curated `forge-marketplace.json` (Claude Code-compatible schema) + SHA-pinned add |
| Safety | Always-on hard checks | L1 rails locked, L2 gates lenient-opt-in, every `--force-skip` audited |
| Open-source ethos | Forge defines the workflow | Forge defines the *contract*; the community defines workflows on top of it |

### Why the change

- **Customizability**: Teams asked for 5-stage paths, alternate review gates, no-beads modes. v2 forced them to fork. v3 makes those config flips.
- **Agent-friendliness**: Agents need a stable contract to plan against. L1 freezes that contract; everything above it can move without breaking agent prompts.
- **Open-source ethos**: A skeleton with documented contracts invites contribution. A monolith invites forks that drift.
- **Customer fit**: The "just one more thing" pressure on v2 was real. v3 redirects that pressure into extensions and patches instead of into the core.

### What stays (deliberately)

- **Beads + Dolt** as the default issue + history substrate — but as an adapter, not the spine.
- **HARD-GATE quality enforcement** — enforced through the canonical L1 rails (TDD intent gate, secret scan, branch protection, signed commits, schema + integrity incl. Protected Path Manifest).
- **Greptile / Sonar / CodeRabbit review automation** — re-shipped as L2 extensions, each installable independently.
- **Forge CLI as the agent abstraction layer** — agents still only call `forge`, never the underlying tools.
- **7-dimension ambiguity rubric** — still the default scoring rubric, now in `patch.md`-tunable form.
- **TDD-first orientation** — stays the default; teams can opt out via L3, but the L1 TDD gate cannot be silently disabled.

---

## 4. Locked Decisions D1–D20

> **FORWARD POINTER**: D21–D38 (added in iterations #5–#6 on 2026-04-29) cover memory architecture (D21–D25), stage model reframing (D26–D29), and Beads under-utilization + ship discipline (D30–D38). They live in [locked-decisions.md](./locked-decisions.md), summarized in [FINAL-THESIS.md §7](./FINAL-THESIS.md#7-the-38-locked-decisions-one-line-summaries). Decisions D11 and D17 are annotated with supersedes (by D15 and D23 respectively).

> Full decision rationale, tradeoffs, and anti-decisions for every entry below live in [locked-decisions.md](./locked-decisions.md). This section is the in-strategy summary.

### D1 — Curated allowlist `forge-marketplace.json` (NOT mirror org)

A single `forge-marketplace.json` ships in `forge-core/`, schema-compatible with Claude Code's marketplace JSON. Each entry pins `name`, `owner/repo`, `sha`, `forge-core` version range, and capabilities. Bot opens nightly PRs to bump SHAs. Name collisions resolve Homebrew-style: short name `dev` works until two extensions claim it; thereafter both must be referenced as `owner/repo/dev`.

**Rationale**: discoverability + safety + zero-config for the 95% case while keeping an escape hatch. A mirror-org model was rejected because it doubles the maintenance surface and forks supply-chain trust.

### D2 — Hybrid F3 patch.md (single index + auto-extract over 40 lines)

`.forge/patch.md` is a single human-readable index of overrides keyed by extension id and section anchor. Any patch body exceeding 40 lines is auto-extracted by `forge` to `.forge/patches/<id>-<slug>.md` and replaced with an `@include` reference, keeping `patch.md` reviewable in one screen.

**Rationale**: small projects stay one-file simple; large projects don't drown the index. Hybrid avoids both the "1000-line patch.md" and the "100 tiny files" failure modes.

### D3 — Refuse-with-hint default + lenient opt-in + L1 always wins

Default policy on violation: refuse and emit a single-line hint (e.g., `test missing for src/foo.ts — run \`forge dev\` or set \`lenient.tdd: true\` in patch.md`). Projects may opt in to lenient mode at L3 for specific gates. L1 safety rails (TDD gate, secret scanning, branch protection, signed commits, classification router) cannot be lenient. Every `--force-skip-*` flag emits an audit record.

**Rationale**: agents must not silently bypass; humans get a visible emergency lever, not a hidden one.

### D4 — AGENTS.md = generated artifact + lint

`AGENTS.md` becomes a generated artifact assembled from L1 contract + effective L2 config + project patches. A CI lint blocks commits that hand-edit it. The generator runs on `forge sync` and on `forge upgrade`.

**Rationale**: hand-edited AGENTS.md drifts. A generated artifact stays in sync with the effective config and gives agents a deterministic source of truth.

### D5 — Team patches via per-user overlays

Teams compose project policy out of layered patches: a base `patch.md` shared in the repo plus per-user overlays at `~/.forge/profile/patches/<project>.md`. Overlay merging respects the L1 → L2 → L3 → L4 order and never lets a personal overlay defeat an L1 rail.

**Rationale**: shared team standards plus personal ergonomics, without forcing one to win.

### D6 — v2 → v3 migration via explicit `forge migrate` + compat mode

Existing v2 installs are not auto-migrated. Users run `forge migrate` to convert `WORKFLOW_STAGE_MATRIX` usage into a generated `.forge/config.yaml`, scaffold an empty `patch.md`, and re-pin extensions in `forge.lock`. A compat mode keeps v2 commands working through Wave 4; cutover happens at Wave 5.

**Rationale**: a 14–18 week pivot spans live projects. An explicit migrate command + compat window beats silent surprises.

### D7 — `forge upgrade` snapshots `.forge/backups/<ts>/`

Every `forge upgrade` writes a timestamped snapshot of the prior `.forge/` tree to `.forge/backups/<ts>/`, plus a single-line entry to `.forge/audit.log`. `forge upgrade --rollback` restores the most recent backup. Snapshots GC after 30 days unless the user pins them.

**Rationale**: upgrades will mis-merge patches occasionally; a one-command rollback turns that from a crisis into an inconvenience.

### D8 — Keep N5 (`forge options *` introspection)

Retain `forge options list / get / set / why` (currently `forge-besw.4`) as a Wave-1 deliverable. The `forge options why <id>` resolution-chain output is the load-bearing piece — without it the L1→L4 layering promise is unfalsifiable at runtime.

**Rationale**: `forge options` is what makes the layered config legible to agents and humans. It is also the cheapest way for agents to discover what's tunable without reading source.

### D9 — 3 templates at MVP, 2 deferred to v3.1

Ship `review-coderabbit` (the 28-min walkthrough demo), `review-stub` (canonical SPI blank canvas), and `gate-cli-json` (covers ESLint / Biome / gitleaks / semgrep / license-checker) at MVP. Defer `notify-webhook` and `issue-mcp-passthrough` to v3.1.

**Rationale**: Three templates is the minimum that proves the SPI generalizes (one concrete review adapter, one blank canvas, one non-review category) without padding the MVP cutover with adapters that have no forcing demo.

### D10 — `forge migrate --dry-run` PoC is the Wave 0 NO-GO gate

Before any other v3 work merges, `forge migrate --dry-run` must successfully migrate this repo (228 beads issues + current `WORKFLOW_STAGE_MATRIX`) with a green diff. If the PoC fails, v3 work pauses until the migration model is fixed.

**Rationale**: D6 commits us to an explicit migrate path; without a PoC against a real workload, every Wave 1+ workstream is built on an unproven assumption. Forcing the PoC up front converts a Wave-5-cutover risk into a Wave-0 schedule risk.

### D11 — Lock 6-harness target

v3 actively maintains six harness targets: **Claude Code, Codex CLI, OpenCode, Kilo Code, Cline, Cursor**. Capability matrix and feature parity tracked per harness. See "Harness Targets (Locked)" section below.

**Rationale**: Six is the set with formal manifest support, slash-command surface, and active user bases that justify ongoing translator work.

### D12 — Adopt agentskills.io as canonical skill format

SKILL.md authored against the agentskills.io spec is the canonical Forge skill format. The translator emits agentskills.io-compliant fragments to each of the six harness target dirs and adapts to native formats (Cursor `.mdc`, OpenCode `opencode.json`, Claude Code plugin manifest) where required.

**Rationale**: agentskills.io is the only cross-harness skill spec with momentum across our targets. Adopting it constrains scope creep in the skill format and makes Forge skills portable inputs/outputs of the wider ecosystem.

### D13 — Drop active maintenance for PI / Hermes / Aider / Copilot / Roo / legacy Cursor

v3 does not maintain translator output, capability matrix, or test coverage for: PI, Hermes, Aider, GitHub Copilot, Roo Code, and Cursor's legacy single-file `.cursorrules`. Cursor's modern `.cursor/rules/*.mdc` is supported under D11.

**Rationale**: These targets either lack a stable manifest story, have niche user bases that don't justify translator surface, or overlap a target we already cover. Best-effort coverage was producing translator drift without adoption.

### D14 — 2-week translator work folded into N7 + N10 (no separate workstream)

The ~2 weeks of harness translator engineering required for D11/D12/D13 scope is absorbed into existing workstreams N7 (extension manifest spec) and N10 (multi-target sync extension). No new top-level workstream, no new wave, no schedule re-base.

**Rationale**: The translator is a feature of the manifest + multi-target sync surface, not a standalone product. Folding it in keeps N7 and N10 honest about real scope and avoids double-counted estimates.

### D15 — 3-harness MVP (Claude + Cursor + Codex CLI); Cline/OpenCode/Kilo deferred to v3.1

MVP narrows D11's six-harness scope to three: Claude Code, Cursor (modern `.mdc` + `.cursor/commands/*.md`), and Codex CLI. Cline, OpenCode, and Kilo Code defer to v3.1 (they share architecture with the MVP three and ship as a follow-on bundle). PI / Hermes / Aider / Copilot / Roo / legacy Cursor remain dropped per D13.

**Rationale**: A "shared protocol" claim only requires crossing 3 distinct agents. Codex CLI's hooks parity with Claude Code makes a 3-harness translator a ~1.5–2 week effort versus ~4–5 weeks for six. Iteration #4 audit framed the 6-harness target as aspirational at MVP scope.

### D16 — Stage HARD-GATEs are L2 default-on (toggleable); TDD enforcement stays L1

Stage transition gates (must complete /plan before /dev, etc.) demote from L1 to L2, default-on. Projects can lock specific stages with `required: true` in `.forge/config.yaml` (project-level override that survives upgrade). Users may patch non-required stage gates via `patch.md`. **TDD intent enforcement remains L1** — protocol identity, not workflow opinion.

**Rationale**: Stage order is workflow opinion (varies by team); TDD discipline is protocol opinion (the thing Forge stands for). Iteration #3 default of "everything L1" produced a ~50% bail rate at the first refused commit per the UX critic.

### D17 — Mandatory agent action log at `.forge/agent-log.ndjson`

Every agent action (tool calls, stage transitions, gate firings, file mutations, test runs, git ops, hook invocations, MCP calls) appends to `.forge/agent-log.ndjson`. NDJSON, append-only, harness-agnostic format, redacted via existing project-memory redaction. Folded into the existing audit log writer (extends N3 scope) — not a separate sixth L1 rail.

**Rationale**: Enables the self-improvement loop in D18; enables agent-claim verification ("did the agent actually run the test?"); compounds with use at N=1 without requiring a community.

### D18 — `forge insights` mines the agent log for pattern-driven skill generation

Replaces N13's review-feedback PoC. Pattern detector reads agent log, surfaces repeated tool-call sequences (≥5 occurrences over 2 weeks), proposes new skills as `.forge/proposals/<id>.md`. User runs `forge skill accept <id>` to promote into `.forge/extensions/local/<slug>/SKILL.md` and record in `patch.md`. Review-feedback signal is no longer primary in MVP.

**Rationale**: Review-feedback is too narrow a signal — it only fires when reviewers flag something. Agent traces fire on every action and are local-first. Compounds at N=1.

### D19 — Protected Path Manifest enforces L1 rail #5 (no new rail)

`.forge/protected-paths.yaml` ships with seven categories: `forge_core` (checksum-verified), `user_protocol` (CLI-only), `generated_artifacts` (CI-blocked hand-edits), `append_only_logs` (runtime-only), `secrets` (rail #2 already), `beads_state` (bd CLI only), `immutable` (`.git`, etc). Enforced via per-harness PreToolUse hooks (Claude + Codex), Cursor file-watcher fallback, pre-commit lefthook, session-start checksum verification, CI lint. Refuse-with-hint UX guides agents to proper CLI commands. **L1 rail count stays at 5** — this expands rail #5 (schema + integrity) scope, not a new rail.

**Rationale**: Prevents agent drift from silently breaking project state (generated artifacts, beads internals, audit log). Forces work through proper channels.

### D20 — Auto-generated skill ownership matrix (Forge proposes; user accepts)

Forge **proposes** at `.forge/proposals/` (regenerable, not committed). User **accepts** via `forge skill accept <id>`, which moves to `.forge/extensions/local/<slug>/` (user-owned, preserved on upgrade, tracked in `patch.md`). Forge regenerates on demand via `forge skill regenerate <slug>`. `forge upgrade` respects acceptance state — never overwrites accepted skills.

**Rationale**: Clean ownership matrix prevents "Forge generated this, now what?" confusion. Proposals are disposable; accepted skills are durable.

---

## 4a. Harness Targets (Locked)

> **STATUS NOTE (D15 supersedes D11)**: This section's original "6-harness MVP" framing (D11) was narrowed to **3 harnesses** — Claude Code + Cursor + Codex CLI — by D15. The other three (Cline, OpenCode, Kilo Code) defer to v3.1. The MVP-active and v3.1-deferred subsections below already reflect the D15 narrowing; the section heading "(Locked)" refers to the D15 lock.

Per D11/D13/D15. **MVP active maintenance**: 3 harnesses (Claude Code, Cursor, Codex CLI). **v3.1 deferred**: 3 harnesses (Cline, OpenCode, Kilo Code). **Dropped from scope**: 6 harnesses (PI, Hermes, Aider, Copilot, Roo, legacy `.cursorrules`).

### MVP active targets (3) — D15

| Harness | Skill format | Slash commands | Hooks | Plugin manifest | Translator strategy |
|---|---|---|---|---|---|
| Claude Code | agentskills.io SKILL.md (`.claude/skills/`) | `.claude/commands/*.md` | settings.json hooks (PreToolUse, Stop, etc.) | `plugin.json` | Native — reference implementation |
| Cursor (modern) | `.cursor/rules/*.mdc` w/ `alwaysApply` frontmatter | `.cursor/commands/*.md` | file-watcher fallback for protected paths | n/a | `.mdc` + `.cursor/commands/*.md` emission |
| Codex CLI | SKILL.md adaptation | Prompt files (per Codex CLI convention) | Shared hook event names with Claude Code | `.codex/` | SKILL.md + prompt-file emission; reuse Claude hook event names |

### v3.1 deferred (3) — D15

| Harness | Reason for deferral | v3.1 plan |
|---|---|---|
| Cline | Shares rules-file architecture with Kilo; can ship as bundle post-MVP. | Rules-file emission |
| OpenCode | `opencode.json` manifest distinct from MVP three; needs its own emitter. | Emit `opencode.json` + SKILL.md |
| Kilo Code | Shares architecture with Cline. | Rules-file + SKILL.md emission |

### Dropped from active maintenance (6) — D13 (unchanged)

| Harness | Reason |
|---|---|
| PI | Niche user base; no stable manifest story justifying translator surface. |
| Hermes | Same — niche, no manifest stability. |
| Aider | No skill/manifest convention to target deterministically. |
| GitHub Copilot | No file-on-disk skill convention; closed extension surface. |
| Roo Code | Overlaps Cline / Kilo coverage materially. |
| Cursor legacy `.cursorrules` (single-file) | Superseded by `.cursor/rules/*.mdc`; maintaining both forks the translator. |

### Wave 0 verification spikes (gate to Wave 1)

Per the locked W0 NO-GO gate (D10) and harness scope (D11/D13), Wave 0 must verify against primary sources before Wave 1 build:

1. Cursor `.mdc` frontmatter spec — confirm `alwaysApply` field, scope rules.
2. Cursor agents/Composer file format — confirm conventions for the modern surface.
3. Codex CLI slash-command file location — confirm prompt-file path convention.
4. `patch.md` anchor stability bench — rename anchor IDs across an upgrade, measure orphan rate, target <10%.
5. Cross-machine race test — 50 trials of two-machine effective-config resolution, target <5% manual resolve rate.

---

## 5. Workstream Verdicts

23 rows: WS1–WS22 plus the killed `forge-s0c3`.

| ID | Title | Verdict | Wave | Effort | Value | Note |
|----|-------|---------|------|--------|-------|------|
| WS1 | Forge CLI abstraction | Aligned | 1 | M | 5 | Already shipping; add `forge config` to inspect effective tree. |
| WS2 | Stages as swappable agents | Reframe | 2 | L | 5 | Each stage becomes an L2 agent extension. |
| WS3 | Beads as adapter, not spine | Reframe | 2 | M | 4 | Issue tracker pluggable; beads stays default L2 adapter. |
| WS4 | Handoff schema | Aligned | 1 | S | 5 | Promote schema to L1 contract; freeze v1 wire format. |
| WS5 | Rubric gate as default | Reframe | 2 | M | 4 | Move rubric out of core into L2 default gate; tunable in patch.md. |
| WS6 | Parallel agent teams | Defer | — | XL | 3 | Out of scope; revisit after Wave 5. |
| WS7 | Safety hard-rails | Aligned | 1 | M | 5 | Becomes L1; refuse-with-hint logic lives here. |
| WS8 | Long-running orchestration | Aligned | 4 | L | 4 | Minor changes for layered config. |
| WS9 | Eval infrastructure | Aligned | 4 | L | 4 | Evals run against effective config. |
| WS10 | Review parsers (Greptile/Sonar/CodeRabbit) | Aligned | 3 | M | 4 | Each parser becomes an L2 extension. |
| WS11 | Context7 skills | Aligned | 3 | M | 3 | Integrate with skill-generation pipeline. |
| WS12 | Detect vs verify split | Reframe | 3 | S | 3 | Detector lives in L2; verifier lives in L1. |
| WS13 | Hard rails (L1) vs toggleable gates (L2) | Reframe | 1 | M | 5 | Implements D3 in code. |
| WS14 | forge-core contract extraction | New | 1 | L | 5 | Carve handoff schema, lifecycle, manifest spec into `forge-core/`. |
| WS15 | `.forge/config.yaml` schema migration | New | 1 | M | 5 | Replace `WORKFLOW_STAGE_MATRIX` with config; ship JSON schema + migration tool. |
| WS16 | Extension system | New | 2 | XL | 5 | Manifest, resolver, lockfile, sandbox, marketplace client. |
| WS17 | `patch.md` + `forge upgrade` self-healing | New | 2 | L | 4 | Auto-extract over 40 lines, conflict detection, dry-run, snapshots. |
| WS18 | Skill generation from observed work | New | 3 | L | 4 | Mine session transcripts → propose skills → user approves → publish. |
| WS19 | User profile (L4) + git-backed sync | New | 4 | M | 3 | `~/.forge/profile/`; optional server is post-v3. |
| WS20 | Doc reorganization | New | 5 | M | 3 | `docs/{work,reference,guides,adr}/`; ADRs for D1–D7. |
| WS21 | `forge migrate` v2→v3 + compat mode | New | 1 | M | 5 | Implements D6; honored through Wave 4. |
| WS22 | Team patches + per-user overlays | New | 4 | M | 3 | Implements D5. |
| forge-s0c3 | Premature 7→5 stage merge | Kill | — | — | — | Removed; stage count is now per-project via L3 config. |

---

## 6. Wave Plan / Release Staging

> **STATUS NOTE (2026-04-29 iteration #7 — D39)**: The canonical release plan is now the **versioned roadmap** in [release-plan.md](./release-plan.md): v3.0 (~5–6 weeks, solo MVP with 5 L1 rails + bd-backed memory + 3-harness translator + basic `/plan` and `/build`) → v3.1 (~+3 weeks, iteration-driven 3-tier `/plan` + `forge insights` + evaluator orchestrator) → v3.2 (~+2 weeks, team mode + bidirectional links) → v3.3+ (ecosystem). The single-MVP wave plans below (Options A/B/C — 14-18w / 6w / 10w / 8w) are **all superseded by D39**'s release versioning. The W0–W5 breakdown survives only as the build sequence inside v3.0. Preserved below for traceability.

### v3.0 build sequence (release-plan.md scope)

Per release-plan.md, v3.0 ships in ~5–6 weeks across these workstreams (a slimmer cut of the W0–W5 plan below): W0 spikes + `forge init` / `migrate`, 5 L1 rails + `bd audit` integration (D23), `patch.md` + `upgrade` + `rollback`, **mandatory full 3-harness translator** (Claude + Cursor + Codex CLI), `forge recap --since=yesterday` (solo only), `/merge` continuous hook, basic `/plan` 1-tier + basic `/build` TDD loop. `forge insights`, evaluator orchestrator, and team mode are explicitly v3.1 / v3.2 scope.

Per iterations #3 and #4 (D15-D20), the *iteration-#4* canonical MVP plan was **Option C below — a 10-week, 6-wave plan**. **D37 supersedes Option C with an 8-week W0–W5 plan** that applies the efficiency-audit cuts and the D32/D36 descopes.

### Option C — 10-week MVP (CANONICAL after iterations #3/#4)

Six waves, ~10 weeks total. Replaces Option B as the MVP path; extends Option B's scope with the locked decisions from iterations #3 and #4.

**Wave 0 — Bootstrap + verification (1.5 weeks)**
Deliverables: `forge init` (fresh-repo entry door — scaffolds `.forge/config.yaml`, empty `patch.md`, `protected-paths.yaml`, detects active harness from filesystem; first-time wizard for classification + L1 rail confirmation + harness target); `forge migrate --dry-run` PoC against this repo (NO-GO gate per D10); the five Wave 0 verification spikes from §4a (Cursor `.mdc` frontmatter, Cursor agents/Composer, Codex CLI slash file, `patch.md` anchor stability, cross-machine race test).
Exit: `forge init` and `forge migrate --dry-run` both pass on this repo with green diff; all five spikes confirmed against primary sources.

**Wave 1 — L1 rails + introspection + protected paths + agent log (2 weeks)**
Deliverables: 5 L1 rails landed (TDD intent gate, secret scan, branch protection, signed commits, schema + integrity — the last including Protected Path Manifest enforcement per D19); `forge options *` introspection API including `forge options why <id>` (D8); `forge explain <gate>` prose-mode complement to `options why`; agent action log writer at `.forge/agent-log.ndjson` (D17); per-harness PreToolUse hooks for Claude + Codex, Cursor file-watcher fallback, pre-commit lefthook entry, session-start checksum verification, CI lint job.
Exit: L1 rails enforce on this repo without bypass; agent log captures all tool calls cross-harness; `forge options why` and `forge explain` both return correct resolution chains; protected paths refuse-with-hint on every category.

**Wave 2 — patch.md, upgrade, rollback, ownership-aware upgrade (2 weeks)**
Deliverables: `patch.md` spec + `forge patch record --from-diff` (N9); `forge upgrade` with self-heal + 3-way merge (N11); `forge rollback` + `.forge/backups/<ts>/` snapshots (D7); ownership-aware upgrade that respects accepted skills per D20 (never overwrites `.forge/extensions/local/`).
Exit: `forge upgrade` round-trips overrides with green diff on this repo; rollback restores prior state in one command; accepted skills survive upgrade unmodified.

**Wave 3 — 3-harness translator + project-required-stages plumbing (1.5 weeks)**
Deliverables: harness translator emits to Claude (`.claude/`), Cursor (`.cursor/rules/*.mdc` + `.cursor/commands/*.md`), Codex CLI (`.codex/`) per D15; project-level `required: true` stage declaration plumbing per D16 (config schema + runtime enforcement + upgrade preservation).
Exit: a single Forge skill renders correctly across all three harnesses; project-required stages survive upgrade; non-required stage gates accept `patch.md` overrides.

**Wave 4 — Pattern detector + insights + skill proposal/acceptance + recap + 2 templates (2 weeks)**
Deliverables: pattern detector reads `.forge/agent-log.ndjson`, surfaces ≥5-occurrence sequences as proposals at `.forge/proposals/<id>.md` (D18); `forge skill accept <id>` promotes to `.forge/extensions/local/<slug>/SKILL.md` and records in `patch.md`; `forge skill regenerate <slug>` re-runs detection; `forge recap` weekly digest (pattern frequencies + insights candidates + bd-stats + L1 audit summary + skill suggestions); two reference templates (`review-coderabbit` and `review-stub` per D9).
Exit: pattern detector proposes ≥1 valid skill from this repo's agent log; one proposal is accepted end-to-end; `forge recap` produces a usable Monday digest.

**Wave 5 — Cutover + demo (1 week)**
Deliverables: third reference template (`gate-cli-json` per D9); flip default install to v3; archive v2 monolith path; publish ADRs for D1–D20; cutover demo + announce.
Exit: `bunx forge@latest setup` installs v3 by default; v2 commands still work via compat mode; ADRs merged.

**Total Option C schedule**: ~10 weeks (1.5 + 2 + 2 + 1.5 + 2 + 1).

### Option A — 5 waves (~14–18 weeks, full v3)

**Wave 1 — Foundation (Weeks 1–4)**. Carve L1, freeze contracts, ship config schema. Parallel: WS14, WS4, WS15, WS13, WS7, WS1, WS21.
**Exit**: `forge-core/` builds standalone; v2 install passes regression on top of L1+L2; migration round-trips on 3 sample repos.

**Wave 2 — Extension System (Weeks 5–8)**. Make L2 swappable. Parallel: WS16, WS2, WS3, WS5, WS17.
**Exit**: A user replaces `/dev` via patch.md; `forge upgrade` round-trips overrides; marketplace install fails closed on tampered SHA.

**Wave 3 — Review, Skills, Detection (Weeks 9–11)**. Parallel: WS10, WS11, WS12, WS18 phase 1.
**Exit**: 3+ review-parser extensions installable; skill-gen yields ≥1 skill per 5 dev sessions in eval; detect/verify split behind feature flag.

**Wave 4 — Long-running, Eval, Profile, Teams (Weeks 12–14)**. Parallel: WS8, WS9, WS19, WS22, WS18 phase 2.
**Exit**: same project on two machines produces identical effective config; eval reports per-layer attribution; profile + team overlay round-trips via git.

**Wave 5 — Docs, ADRs, Cutover (Weeks 15–18)**. Parallel: WS20, deprecation messaging, migration guide, release.
**Exit**: `bunx forge@latest setup` installs v3 by default; v2 monolith removed from `master`; ADRs for D1–D7 merged.

### Option B — MVP-A: Wave 0 de-risk + 4-week build + cutover (~6 weeks)

Per locked D10, Wave 0 (de-risk + verification spikes, ~1.5 weeks) precedes the build. Wave 1–5 build runs four weeks across two parallel tracks. Wave 6 is cutover (~0.5 week).

**Wave 0 — De-risk + verification (1.5 weeks)**: `forge migrate --dry-run` PoC against this repo (228 beads + current `WORKFLOW_STAGE_MATRIX`) — green diff is the NO-GO gate. In parallel, the five verification spikes from §4a (Cursor `.mdc` frontmatter, Cursor agents/Composer format, Codex CLI slash file location, `patch.md` anchor stability bench, cross-machine race test) all pass before Wave 1 starts.

**Waves 1–5 — Build (4 weeks)**: Two-track parallel work below.

Sequencer's MVP-A path. Two engineers run in parallel.

**Track 1 — Contract + Config (4 weeks)**: WS14 → WS15 → WS21 → WS13. Output: `forge-core/`, `.forge/config.yaml`, `forge migrate`, refuse-with-hint logic. This is the load-bearing track.

**Track 2 — Extension shell (4 weeks, starts Week 2)**: WS16 manifest + resolver + lockfile, plus WS17 patch.md tooling. Stops at "install one extension end-to-end"; defers marketplace client to post-MVP.

**MVP-A exit (end of build)**: v3 installable via `forge migrate` on this repo; one extension installed via local resolver; patch.md round-trips one stage override; v2 commands still work via compat mode; three reference templates (`review-coderabbit`, `review-stub`, `gate-cli-json`) ship per D9.

**Wave 6 — Cutover (0.5 week)**: Flip default install to v3, archive v2 monolith path, publish ADRs for D1–D14, announce.

**Total MVP-A schedule**: ~6 weeks (Wave 0 1.5w + Build 4w + Cutover 0.5w).

**Post-MVP**: Resume Option A waves 3–5 in order, treating Option B as Wave 1 + a slimmer Wave 2.

### Recommendation

Ship Option C (the 10-week, 6-wave plan above) as the canonical MVP. It absorbs the iteration #3/#4 locked decisions (D15-D20) into a coherent build sequence. Option B is preserved for historical reference but is superseded by Option C. Resume Option A waves 3–5 from there as the post-MVP roadmap.

---

## 6b. Protected Path Manifest

Per D19, the Protected Path Manifest enforces L1 rail #5 (schema + integrity) by declaring which paths an agent may not silently edit. The manifest ships as `.forge/protected-paths.yaml` with seven categories:

| Category | Examples | Enforcement | Allowed mutator |
|---|---|---|---|
| `forge_core` | `forge-core/`, `AGENTS.md` | Session-start checksum + CI lint | `forge upgrade` only |
| `user_protocol` | `.forge/config.yaml`, `patch.md` | PreToolUse hook (Claude+Codex), file-watcher (Cursor) | `forge` CLI only |
| `generated_artifacts` | `AGENTS.md`, sync'd command files | CI lint + lefthook pre-commit | Generator scripts only |
| `append_only_logs` | `.forge/audit.log`, `.forge/agent-log.ndjson` | PreToolUse hook (refuse non-append writes) | Runtime writers only |
| `secrets` | `.env`, `*.pem`, `credentials.json` | Already covered by L1 rail #2 (secret scan) | Out of band |
| `beads_state` | `.beads/issues.jsonl`, `.beads/dolt/` | PreToolUse hook + lefthook | `bd` CLI only |
| `immutable` | `.git/`, `.git/hooks/` | PreToolUse hook (refuse all writes) | Git itself only |

The refuse-with-hint message on each violation guides the agent toward the proper CLI command (e.g., "Edit blocked on `AGENTS.md` — this is a generated artifact. Run `forge sync` to regenerate."). Per D19, this is rail #5 expanded scope, not a new rail.

---

## 6c. Self-Improvement Loop (D17 + D18 + D20)

Per D17, D18, and D20, Forge ships a closed-loop skill-generation system that compounds with use at N=1:

```
Agent action → .forge/agent-log.ndjson  (D17 — every tool call appended)
                          |
                          v
                  Pattern detector       (D18 — ≥5 occurrences over 2 weeks)
                          |
                          v
       .forge/proposals/<id>.md          (D20 — Forge-owned, regenerable)
                          |
                forge skill accept <id>  (D20 — user gate)
                          |
                          v
   .forge/extensions/local/<slug>/       (D20 — user-owned, upgrade-safe)
   + patch.md entry tracking acceptance
```

Properties:
- **Local-first**: no community required; the loop fires on the user's own agent log.
- **Cross-harness**: log format is harness-agnostic per D17, so a skill mined from Claude usage applies in Cursor and Codex CLI.
- **Upgrade-safe**: per D20, accepted skills are user-owned; `forge upgrade` never overwrites them.
- **Regenerable**: `forge skill regenerate <slug>` re-runs detection without losing the user's edits to the accepted artifact.
- **Auditable**: every proposal references the agent-log event range it was mined from, so the user can verify the pattern.

This is the substrate that makes `forge insights` and `forge recap` (Wave 1 / Wave 4 deliverables) more than documentation tools.

---

## 7. Critic Loop Summary

The v3 plan went through three critic passes before locking. Each pass changed the plan; here is what we kept and what we cut.

**Anti-architect cuts.** The first draft over-specified observability, install modes, and a beyond-seed marketplace, and front-loaded a doc reorg. The anti-architect critic flagged those as work that bought no MVP value. We cut: full skill-gen observability (replaced by a Week-1 PoC at WS18 phase 1), three install modes (collapsed to one default + flags), marketplace beyond a seed allowlist (deferred to Wave 3 / post-MVP), and the doc reorg (deferred to Wave 5). Net effect: ~6 weeks removed from the critical path.

**Gap-finder additions.** The gap-finder critic surfaced four missing workstreams that turned out to be load-bearing. We added: WS21 `forge migrate` + compat mode (without it, v2 users have no upgrade path); D7 `forge upgrade` snapshots + rollback (without it, a bad upgrade is unrecoverable); D4 AGENTS.md as generated artifact + lint (without it, AGENTS drifts from effective config); D5 + WS22 team patches via per-user overlays (without it, teams either can't share standards or can't customize personally).

**Sequencer rewrite.** The sequencer critic rejected the original 5-wave plan as too slow for a "prove the contract" goal. It proposed two parallel tracks with a 4-week MVP-A. We integrated this as **Option B above** and made it the recommended MVP path. Option A survives as the roadmap from Wave 3 onward — the wave structure is still useful for post-MVP staging.

How we integrated each: anti-architect cuts shaped the wave contents, gap-finder additions became WS21/WS22 + D4/D5/D7, and the sequencer rewrite became the recommended MVP shape. The locked decisions D1–D7 are the surviving consensus across all three critics.

---

## 8. Success Metrics

1. **Override adoption**: ≥30% of active projects ship a non-empty `patch.md` within 60 days of v3 GA. Indicates layering is being used, not ignored.
2. **Upgrade safety**: `forge upgrade` succeeds without manual intervention on ≥95% of projects in the eval corpus; rollback used <5% of upgrades.
3. **Marketplace health**: ≥10 third-party extensions listed in `forge-marketplace.json` within 90 days, zero SHA-mismatch incidents.
4. **Refuse-with-hint efficacy**: ≥80% of refuse events resolved by following the hint within the same session (audit log + session reconciliation).
5. **Skill generation yield**: pipeline produces ≥1 user-approved skill per 5 `/dev` sessions in eval.
6. **Time-to-customize**: a developer swaps one stage end-to-end (read docs → write patch.md → commit) in under 30 minutes.

---

## 9. Risks + Mitigations

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Patch.md becomes the new monolith** — projects pile every override into one file until it's unreviewable. | 40-line auto-extract (D2) enforced by `forge`; CI lint warns above 200 total lines; `forge config explain` shows resolved tree, not raw patches. |
| 2 | **Marketplace supply-chain attack** — malicious extension at a pinned SHA. | SHA pinning + sandbox at L1 + `forge-core` allowlist for filesystem/network capabilities + signed manifest in marketplace JSON. |
| 3 | **L1/L2 boundary creep** — pressure to put "just one more thing" into L1 erodes the swappability promise. | Every L1 addition requires an ADR; CI guard fails PR if `forge-core/` grows beyond a budgeted line count without an ADR reference. |
| 4 | **Migration breaks existing v2 users mid-flight** — the 14-week cutover spans live projects. | v2 stays on `master` behind a feature flag through Wave 4; v3 ships as opt-in (`forge --v3`); cutover only at Wave 5 after ≥30 dogfood weeks. |
| 5 | **`forge upgrade` mis-merges patches** — overrides silently dropped or duplicated after a base extension changes. | Three-way merge with explicit conflict markers (WS17); `forge upgrade --dry-run` mandatory in CI; `.forge/backups/<ts>/` snapshot (D7) enables one-command rollback. |

---

## 10. Open Questions

1. **Marketplace governance** — who approves additions to `forge-marketplace.json`? Single maintainer? PR + 2 reviewers? Automated SHA-only acceptance from a trusted GH org? Affects WS16 launch policy.
2. **Lenient-mode telemetry** — should opting into lenient mode at L3 phone home (anonymized) so we learn which gates teams disable most? Privacy vs product-feedback tradeoff. Affects WS7 / WS13.
3. **L4 sync transport** — Wave 4 ships git-backed profile sync. Is the post-v3 optional server a Forge-hosted service, a self-hosted reference impl only, or dropped entirely? Affects WS19 surface area.

---

## 11. Source Documents

All v3 design docs live in this folder (`docs/work/2026-04-28-skeleton-pivot/`). Start with [README.md](./README.md) for an overview + reading order:

- [README.md](./README.md) — folder index + reading order + status
- [locked-decisions.md](./locked-decisions.md) — canonical D1–D20 decisions ledger (this doc summarizes; that doc has full rationale + tradeoffs + anti-decisions)
- [n1-moat-technical-deep-dive.md](./n1-moat-technical-deep-dive.md) — moat analysis underpinning D8/D9
- [v3-ecosystem-audit.md](./v3-ecosystem-audit.md) — harness landscape underpinning D11/D13
- [template-library-and-merge-flow.md](./template-library-and-merge-flow.md) — template scope underpinning D9
- [v3-skeleton-plan.md](./v3-skeleton-plan.md) — wave plan + workstream table
- [layered-skeleton-config.md](./layered-skeleton-config.md) — L1/L2/L3/L4 config schema
- [extension-system.md](./extension-system.md) — manifest spec, resolvers, lockfile, sandbox
- [skill-generation.md](./skill-generation.md) — observed-work mining → skill proposals
- [skill-distribution.md](./skill-distribution.md) — marketplace allowlist + name collisions
- [beads-operations-manifest.md](./beads-operations-manifest.md) — beads create/reframe/close manifest (N1–N18)
- [building-block-pivot.md](./building-block-pivot.md) — building-block framing of the pivot

v2 reference: [`../2026-04-06-v2-unified-strategy/unified-strategy.md`](../2026-04-06-v2-unified-strategy/unified-strategy.md).
