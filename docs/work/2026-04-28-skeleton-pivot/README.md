# Forge v3 Skeleton Pivot

**Date**: 2026-04-28 (started) → 2026-04-29 (consolidated through iteration #8)
**Status**: D1–D42 locked (D41 deferred — name TBD). Canonical "where we ended up" is **[FINAL-THESIS.md](./FINAL-THESIS.md)**. Release roadmap (v3.0 / v3.1 / v3.2 / v3.3+) locked per D39 in **[release-plan.md](./release-plan.md)**. Iteration #8 added D40 (hybrid semver back-compat) and D42 (staged launch: private alpha v3.0 → Show HN v3.1 → ProductHunt v3.2). Product naming decision held pending evaluation.
**Current wave**: Wave 0 (de-risk + verification spikes per D10/D38)
**Epic**: [`forge-besw`](../../../.beads/issues.jsonl) — ~33 children

---

## Summary

Forge v3 pivots from a fixed 7-stage opinionated workflow to a **layered skeleton + skill library**:

- **L1** locked rails — TDD intent gate, secret scan, branch protection, signed commits, schema + integrity (incl. Protected Path Manifest per D19)
- **L2** swappable defaults — stage workflow, gates, adapters in `.forge/config.yaml`
- **L3** project overrides — `.forge/patch.md`
- **L4** user profile — `~/.forge/profile/`

**Final stage model** (D27/D28/D29/D33/D34): 5 stages (`/plan`, `/dev`, `/ship`, `/review`, `/verify`) + `/merge` as a continuous PR-state hook. `/plan` is **optional** — bring your own planner. Validation runs continuously inside `/dev`.

**Release plan** (D39): v3.0 (~5–6w) → v3.1 (+3w) → v3.2 (+2w) → v3.3+. v3.0 ships ALL 3 harnesses (Claude + Cursor + Codex CLI) with 5 L1 rails, bd-backed memory, basic `/plan` and `/build`, and `forge recap --since=yesterday`. Iteration-driven 3-tier `/plan` and `forge insights` defer to v3.1; team mode defers to v3.2; Cline / OpenCode / Kilo defer to v3.3+. See [release-plan.md](./release-plan.md).

**Memory model** (D22/D24): typed memory API over **seven existing backends** — no new database, no vector store. Categories: decisions, episodes, skills, working state, issue graph, audit, preferences.

**Beads stance** (D31): Forge does NOT replace Beads. Lean on Beads harder (`bd remember`, `bd audit`, `bd preflight`, `bd doctor`, `bd formula`, `bd pour`, `bd prime`). Switch local Dolt to embedded mode (D30) for worktree pain. IssueAdapter interface stays as future-proofing only (D21).

---

## Reading Order (canonical)

1. **START HERE**: **[FINAL-THESIS.md](./FINAL-THESIS.md)** — the canonical "where we ended up" document. 3-tier architecture, 5 L1 rails, 7 typed memory categories, final stage model, 3-harness target, 39 decisions one-line summaries, release versioning, kill criteria.

2. **Release roadmap**: **[release-plan.md](./release-plan.md)** — v3.0 / v3.1 / v3.2 / v3.3+ with customer pitches, scope tables, dependency graph, per-version gate criteria. Locked as D39.

3. **Decisions ledger**: **[locked-decisions.md](./locked-decisions.md)** — D1–D39 with supersedes annotated inline. Each entry: rationale + tradeoff considered + anti-decision.

4. **Journey**: **[LEARNINGS.md](./LEARNINGS.md)** — 15 takeaways from the 6-iteration journey. Read this to understand *why* decisions changed across iterations.

5. **Method**: **[iteration-driven-planning-skill.md](./iteration-driven-planning-skill.md)** — the planning method this folder used, proposed as the canonical Forge `/plan` skill (Phase 1–5, classification-aware intensity, supersedes tracking). Lands in v3.1.

6. **Reference strategy**: [v3-redesign-strategy.md](./v3-redesign-strategy.md) — full strategy doc with workstream verdicts, harness targets, success metrics, risks. Sections marked SUPERSEDED inline where D21–D39 changed the framing.

6. **Design references** (read as needed):
   - [layered-skeleton-config.md](./layered-skeleton-config.md) — L1/L2/L3/L4 schema
   - [extension-system.md](./extension-system.md) — manifest spec, resolvers, lockfile, sandbox
   - [skill-distribution.md](./skill-distribution.md) — `forge-marketplace.json` allowlist + name collision rules
   - [skill-generation.md](./skill-generation.md) — observed-work mining → skill proposals (D18 substrate)
   - [agent-memory-architecture.md](./agent-memory-architecture.md) — 7 typed memory categories (substrate for D22/D24)
   - [marketplace-patchmd-use-case-kits.md](./marketplace-patchmd-use-case-kits.md) — use-case validation for layered config
   - [n1-moat-technical-deep-dive.md](./n1-moat-technical-deep-dive.md) — moat analysis (D8/D9, kill criteria for D38)
   - [beads-supabase-and-forge-memory-design.md](./beads-supabase-and-forge-memory-design.md) — Beads coexist analysis (substrate for D21/D31)

7. **Tactical**:
   - [beads-operations-manifest.md](./beads-operations-manifest.md) — bd create/reframe/close manifest (N1–N18+)
   - [v3-release-staging.md](./v3-release-staging.md) — release gating per wave

8. **Audits** (these critic-loop docs drove the iteration #5–#6 supersedes):
   - [reality-check-audit.md](./reality-check-audit.md) — survival audit (substrate for D37/D38)
   - [n1-survival-audit.md](./n1-survival-audit.md) — N=1 retention critique (substrate for D26/D34)
   - [efficiency-audit.md](./efficiency-audit.md) — 10 efficiency wins (substrate for D23/D25/D37)
   - [quality-vs-speed-tradeoff.md](./quality-vs-speed-tradeoff.md) — quality-vs-speed cuts (substrate for D32/D37)
   - [unconventional-alternatives.md](./unconventional-alternatives.md) — alternatives considered (sell-the-log, single-team, pure-runtime)
   - [template-library-and-merge-flow.md](./template-library-and-merge-flow.md) — template scope (D9/D26)

---

## Locked decisions index (one-liners)

| ID | Status | Topic |
|----|--------|-------|
| D1 | ACTIVE | Curated allowlist `forge-marketplace.json` (NOT mirror org) |
| D2 | ACTIVE | Hybrid `patch.md` (single index + auto-extract over 40 lines) |
| D3 | ACTIVE | Refuse-with-hint default + lenient opt-in + L1 always wins |
| D4 | ACTIVE | `AGENTS.md` = generated artifact + lint |
| D5 | ACTIVE | Team patches via per-user overlays |
| D6 | ACTIVE | v2 → v3 migration via explicit `forge migrate` + compat mode |
| D7 | ACTIVE | `forge upgrade` snapshots `.forge/backups/<ts>/` |
| D8 | ACTIVE | Keep N5 (`forge options *` introspection) |
| D9 | ACTIVE | 3 templates at MVP, 2 deferred to v3.1 |
| D10 | ACTIVE | `forge migrate --dry-run` PoC = Wave 0 NO-GO gate |
| D11 | **SUPERSEDED-BY-D15** | (was: lock 6-harness target) |
| D12 | ACTIVE | Adopt agentskills.io as canonical skill format |
| D13 | ACTIVE | Drop active maintenance for PI/Hermes/Aider/Copilot/Roo/legacy Cursor |
| D14 | ACTIVE | 2-week translator work folded into N7 + N10 |
| D15 | ACTIVE | 3-harness MVP: Claude + Cursor + Codex CLI |
| D16 | ACTIVE | Stage HARD-GATEs are L2 default-on; TDD enforcement stays L1 |
| D17 | **REVISED-BY-D23** | (intent stays; storage moves to `bd audit`) |
| D18 | ACTIVE | `forge insights` mines agent log for pattern-driven skill generation |
| D19 | ACTIVE | Protected Path Manifest enforces L1 rail #5 |
| D20 | ACTIVE | Auto-generated skill ownership matrix |
| D21 | ACTIVE | IssueAdapter interface as future-proofing; Beads is only impl |
| D22 | ACTIVE | Typed memory API over existing backends (no new database) |
| D23 | ACTIVE | Use `bd audit record` instead of parallel NDJSON writer |
| D24 | ACTIVE | Vector stores rejected as primary memory |
| D25 | ACTIVE (fallback) | `.forge/log.jsonl` collapse only if D23 reverts |
| D26 | ACTIVE | `forge new <template>` is the day-one entry point |
| D27 | ACTIVE | `/dev` and `/validate` collapse — continuous validation |
| D28 | ACTIVE | `/premerge` is NOT a stage; continuous PR-state hook |
| D29 | ACTIVE | Final stage list: 5 stages + `/merge` hook |
| D30 | ACTIVE | Switch local Dolt to `embedded` mode |
| D31 | ACTIVE | Forge does NOT replace Beads; lean harder |
| D32 | ACTIVE | Sandboxing concern overweighted; defer to v3.2 |
| D33 | ACTIVE | `/merge` is a hook, not a stage |
| D34 | ACTIVE | `/plan` is OPTIONAL — bring your own planner |
| D35 | ACTIVE | Skills auto-invoke via description match (Hermes-style) |
| D36 | ACTIVE | Single backend, no hedged maintenance |
| D37 | **SUPERSEDED-BY-D39** | (was: 8-week single-MVP W0–W5 timeline) |
| D38 | ACTIVE | Kill criteria: 5 falsifiable gates (now per-version per D39) |
| D39 | ACTIVE | Release versioning v3.0 / v3.1 / v3.2 / v3.3+ replaces single-MVP |

Full rationale + tradeoff + anti-decision: [locked-decisions.md](./locked-decisions.md).

---

## Release plan (D39 — versioned roadmap)

| Version | Cumulative | Pitch | Key scope |
|---------|------------|-------|-----------|
| v3.0 | ~5–6 wk | Forge protects you AND follows you | 5 L1 rails, bd-backed memory (embedded Dolt), `forge init/migrate/upgrade/rollback`, `forge recap --since=yesterday` (solo), `/merge` continuous hook, **mandatory full 3-harness translator** (Claude + Cursor + Codex CLI), skills auto-invoke, `/plan` 1-tier, `/build` basic TDD |
| v3.1 | ~9 wk | Forge plans with rigor | Iteration-driven 3-tier `/plan` (quick/standard/deep), classification auto-detect, parallel critics, supersedes-tracked decisions, `forge insights` pattern detector, `/build` evaluator orchestrator |
| v3.2 | ~11 wk | Forge for teams | `forge recap --team`, team patches (per-user overlays + shared `team-patch.md`), bidirectional log↔docs, `bd audit upstream --meta-json PR` (Plan A) or `.forge/log.jsonl` (Plan B), docs-as-memory 7-category nav |
| v3.3+ | ecosystem | Forge as a platform | Cline/OpenCode/Kilo translators, marketplace expansion, `/forge map-codebase`, profile sync, skill self-improvement, full evaluator suite, hardened sandbox |

See [release-plan.md](./release-plan.md) for full per-version scope, dependency graph, and gate criteria. The W0–W5 wave breakdown survives only as the build sequence inside v3.0.

---

## Iteration history

The original `v3-skeleton-plan.md` and `building-block-pivot.md` documents — early-iteration framings absorbed by `v3-redesign-strategy.md` and now by `FINAL-THESIS.md` — are preserved in [`_iteration-history/`](./_iteration-history/) with a `SUPERSEDED.md` breadcrumb. The `v3-ecosystem-audit.md` was the substrate for D11/D13/D15 and is also archived since its harness conclusions have been absorbed into D15.
