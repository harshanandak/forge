# Forge Documentation Index

This is the entry point for all Forge documentation. The structure mirrors how docs are used:

- **work/** — one folder per work item (design + decisions + tasks + supporting research).
- **reference/** — stable, cross-cutting docs (roadmap, toolchain, validation, examples, templates).
- **guides/** — how-tos for setup, onboarding, integrations.
- **adr/** — architectural decision records (currently empty).

---

## Active Work

### Featured: Forge v3 Skeleton Pivot (2026-04-28 → 2026-04-29)

**Status**: D1–D38 locked across 6 iterations. Canonical 8-week W0–W5 plan (D37). Epic: `forge-besw` (~33 children).

**Reading order** for `docs/work/2026-04-28-skeleton-pivot/`:

1. **START HERE**: **[FINAL-THESIS.md](work/2026-04-28-skeleton-pivot/FINAL-THESIS.md)** — canonical "where we ended up" document. 3-tier architecture, 5 L1 rails, 7 typed memory categories, final stage model, 3-harness target, 38 decisions, 8-week timeline, kill criteria.
2. **Decisions**: [locked-decisions.md](work/2026-04-28-skeleton-pivot/locked-decisions.md) — D1–D38 with supersedes inline (D11→D15, D17→D23). Rationale + tradeoff + anti-decision per entry.
3. **Journey**: [LEARNINGS.md](work/2026-04-28-skeleton-pivot/LEARNINGS.md) — 15 takeaways from the 6-iteration journey. Why decisions changed.
4. **Method**: [iteration-driven-planning-skill.md](work/2026-04-28-skeleton-pivot/iteration-driven-planning-skill.md) — the planning method this folder used, proposed as the canonical Forge `/plan` skill (Phase 1–5, classification-aware intensity).
5. **Strategy reference**: [v3-redesign-strategy.md](work/2026-04-28-skeleton-pivot/v3-redesign-strategy.md) — original master strategy doc; sections 4a/6 marked SUPERSEDED inline.
6. **Folder index**: [README.md](work/2026-04-28-skeleton-pivot/README.md) — all docs with one-line descriptions.

**Design references**:
- [layered-skeleton-config.md](work/2026-04-28-skeleton-pivot/layered-skeleton-config.md) — L1/L2/L3/L4 config schema
- [extension-system.md](work/2026-04-28-skeleton-pivot/extension-system.md) — manifest spec, resolvers, lockfile, sandbox
- [skill-distribution.md](work/2026-04-28-skeleton-pivot/skill-distribution.md) — marketplace allowlist + name collisions
- [skill-generation.md](work/2026-04-28-skeleton-pivot/skill-generation.md) — observed-work mining → skill proposals (D18)
- [agent-memory-architecture.md](work/2026-04-28-skeleton-pivot/agent-memory-architecture.md) — 7 typed memory categories (D22/D24)
- [marketplace-patchmd-use-case-kits.md](work/2026-04-28-skeleton-pivot/marketplace-patchmd-use-case-kits.md) — use-case validation
- [n1-moat-technical-deep-dive.md](work/2026-04-28-skeleton-pivot/n1-moat-technical-deep-dive.md) — moat analysis (D8/D9, kill criteria for D38)
- [beads-supabase-and-forge-memory-design.md](work/2026-04-28-skeleton-pivot/beads-supabase-and-forge-memory-design.md) — Beads coexist analysis (D21/D31)

**Tactical**:
- [beads-operations-manifest.md](work/2026-04-28-skeleton-pivot/beads-operations-manifest.md) — bd manifest (N1–N18)
- [v3-release-staging.md](work/2026-04-28-skeleton-pivot/v3-release-staging.md) — release gating

**Audits** (drove iteration #5–#6 supersedes):
- [reality-check-audit.md](work/2026-04-28-skeleton-pivot/reality-check-audit.md) — survival audit (D37/D38)
- [n1-survival-audit.md](work/2026-04-28-skeleton-pivot/n1-survival-audit.md) — N=1 retention critique (D26/D34)
- [efficiency-audit.md](work/2026-04-28-skeleton-pivot/efficiency-audit.md) — 10 efficiency wins (D23/D25/D37)
- [quality-vs-speed-tradeoff.md](work/2026-04-28-skeleton-pivot/quality-vs-speed-tradeoff.md) — quality cuts (D32/D37)
- [unconventional-alternatives.md](work/2026-04-28-skeleton-pivot/unconventional-alternatives.md) — alternatives considered
- [template-library-and-merge-flow.md](work/2026-04-28-skeleton-pivot/template-library-and-merge-flow.md) — template scope (D9/D26)

**Iteration history** (superseded earlier-iteration docs preserved with breadcrumb):
- [_iteration-history/](work/2026-04-28-skeleton-pivot/_iteration-history/) — `v3-skeleton-plan.md`, `building-block-pivot.md`, `v3-ecosystem-audit.md` + `SUPERSEDED.md` note

### All active work

| Work Item | Summary |
|-----------|---------|
| [2026-04-28-skeleton-pivot](work/2026-04-28-skeleton-pivot/README.md) | Forge v3 layered skeleton + skill library. **D1–D38 locked**. 5 L1 rails / 7 typed memory categories / 5 stages + `/merge` hook / 3 harness MVP / 8-week W0–W5 plan. See [FINAL-THESIS.md](work/2026-04-28-skeleton-pivot/FINAL-THESIS.md). Epic forge-besw. |
| [2026-04-06-v2-unified-strategy](work/2026-04-06-v2-unified-strategy/README.md) | Historical v2 strategy doc, superseded by v3 skeleton pivot. Preserved for reference on why v2 chose its specific defaults. |

## Recent Completed Work

See [work/](work/) for the full list of date-prefixed work folders. Each folder contains a `README.md` with status and links.

## Reference

- [ROADMAP.md](reference/ROADMAP.md) — Forge roadmap
- [TOOLCHAIN.md](reference/TOOLCHAIN.md) — Toolchain conventions (Bun, lefthook, beads, MCP, shell model)
- [VALIDATION.md](reference/VALIDATION.md) — Validation stage requirements
- [EXAMPLES.md](reference/EXAMPLES.md) — Worked examples
- [RESEARCH_TEMPLATE.md](reference/RESEARCH_TEMPLATE.md) — Template for research docs (formerly docs/research/TEMPLATE.md)

## Guides

- [SETUP.md](guides/SETUP.md) — Project setup
- [ENHANCED_ONBOARDING.md](guides/ENHANCED_ONBOARDING.md) — Onboarding flow
- [GREPTILE_SETUP.md](guides/GREPTILE_SETUP.md) — Greptile integration
- [BEADS_GITHUB_SYNC.md](guides/BEADS_GITHUB_SYNC.md) — Beads ↔ GitHub sync
- [MANUAL_REVIEW_GUIDE.md](guides/MANUAL_REVIEW_GUIDE.md) — Manual PR review process
- [AGENT_INSTALL_PROMPT.md](guides/AGENT_INSTALL_PROMPT.md) — Agent install prompt

## Architectural Decision Records

- [adr/README.md](adr/README.md) — ADR purpose and template (empty for now)

## Archive

- [work/_archive/general-research/](work/_archive/general-research/) — Historical research not tied to a specific work item (formerly docs/research/)
- [work/_archive/planning-snapshots/](work/_archive/planning-snapshots/) — Historical planning snapshots (formerly docs/planning/)

## Notes

- `docs/forge/` (TOOLCHAIN.md, VALIDATION.md) is a **consumer-installed** directory created by `forge setup`. Do not move or rename — referenced by `lib/reset.js`, `lib/docs-copy.js`, and `lib/commands/setup.js`.
- New `/plan` artifacts live under `docs/work/YYYY-MM-DD-<slug>/`. Runtime tools keep a legacy `docs/plans/` read fallback only for older work items.
