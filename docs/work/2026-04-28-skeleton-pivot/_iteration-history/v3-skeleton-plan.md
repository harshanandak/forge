# Forge v3 Skeleton Plan

**Date**: 2026-04-28
**Status**: Active plan — supersedes [2026-04-06-forge-v2-unified-strategy.md](./2026-04-06-forge-v2-unified-strategy.md) (kept as historical reference)
**Scope**: Pivot from fixed 7-stage opinionated workflow to layered skeleton architecture
**Source design docs**:
- [2026-04-28-layered-skeleton-config-proposal.md](./2026-04-28-layered-skeleton-config-proposal.md)
- [2026-04-28-extension-system-design.md](./2026-04-28-extension-system-design.md)
- [2026-04-28-skill-generation-from-observed-work-design.md](./2026-04-28-skill-generation-from-observed-work-design.md)
- [2026-04-28-skill-distribution-design.md](./2026-04-28-skill-distribution-design.md)

---

## 1. Executive Summary

Forge v2 shipped a fixed 7-stage TDD workflow (`/plan → /dev → /validate → /ship → /review → /premerge → /verify`) with stages, gates, and policies hard-coded into a monolithic `WORKFLOW_STAGE_MATRIX` and per-agent command files. Adoption signal across teams shows the *shape* of the workflow is right but the *specifics* leak: rubric thresholds, beads-as-spine, exact stage count, and review gate strictness all vary by team.

**v3 reframes Forge as a layered skeleton.** L1 ships a tiny set of locked rails (handoff schema, safety, contract). L2 ships swappable defaults (the v2 7-stage workflow, beads adapter, rubric gate) every project gets out-of-the-box. L3 lets a project override anything via a single `patch.md` index (large patches auto-extracted to `patches/`). L4 layers a per-user profile on top so personal preferences survive across machines and projects.

Three decisions are now locked: **Q1** marketplace = curated allowlist `forge-marketplace.json` with SHA pinning and Homebrew-style `owner/repo/name` collision fallback; **Q2** project overrides = hybrid `patch.md` (single index + auto-extracted long patches under `patches/<id>-<slug>.md`); **Q3** safety = refuse-with-hint default, opt-in lenient mode at L3, L1 always wins, every `--force-skip-*` audited.

Calendar target: **14–18 weeks across 5 waves**, starting Wave 1 in 2026-W19.

---

## 2. The 4-Layer Architecture

```
+--------------------------------------------------------------+
| L4  USER PROFILE      ~/.forge/profile/                      |
|     personal defaults, sync via git, optional server later   |
+--------------------------------------------------------------+
                              ^ overrides
+--------------------------------------------------------------+
| L3  PROJECT OVERRIDES  .forge/patch.md  (+ patches/)         |
|     hybrid index + auto-extract >40 lines                    |
+--------------------------------------------------------------+
                              ^ overrides
+--------------------------------------------------------------+
| L2  SWAPPABLE DEFAULTS  forge-defaults/                      |
|     v2 7-stage workflow, beads adapter, rubric gate,         |
|     review parsers, eval harness — replace any of these      |
+--------------------------------------------------------------+
                              ^ overrides (LIMITED)
+--------------------------------------------------------------+
| L1  LOCKED RAILS       forge-core/                           |
|     handoff schema, hard safety, lifecycle contract,         |
|     extension manifest spec — L1 ALWAYS WINS                 |
+--------------------------------------------------------------+
```

Resolution order on every command: **L1 → L2 → L3 → L4** (later layers override earlier, except L1 cannot be overridden). The runtime computes an effective config tree at session start and emits it to `.forge/.cache/effective-config.json` for inspection.

---

## 3. Locked Decisions

### Q1 — Curated marketplace `forge-marketplace.json` (Claude Code schema), SHA-pinned, fully-qualified collision fallback

A single `forge-marketplace.json` ships in `forge-core/` listing approved extensions by `name`, `owner/repo`, `sha`, `forge-core` version range, and capabilities. Schema mirrors Claude Code's marketplace JSON so existing tooling round-trips. SHA pinning blocks supply-chain drift; lockfile resolution is deterministic. Name collisions resolve Homebrew-style: short name `dev` works until two extensions claim it, then both must be referenced as `owner/repo/dev`. **Rationale**: discoverability + safety + zero-config for the 95% case while keeping an escape hatch.

### Q2 — Hybrid `patch.md` (single index + auto-extract over 40 lines)

Project overrides live in `.forge/patch.md` as a single human-readable index of edits keyed by extension id and section. Any patch body exceeding 40 lines is auto-extracted by `forge` to `.forge/patches/<id>-<slug>.md` and replaced with an `@include` reference, keeping `patch.md` reviewable in one screen. **Rationale**: small projects stay one-file simple; large projects don't drown the index. Hybrid avoids both the "1000-line patch.md" and "100 tiny files" failure modes.

### Q3 — Refuse-with-hint default, lenient opt-in, L1 always wins, audited force-skip

Default behavior on policy violation is *refuse and hint* (e.g., "test missing for src/foo.ts — run `forge dev` or set `lenient.tdd: true` in patch.md"). Projects may opt-in to lenient mode at L3 for specific gates. **L1 safety rails (secret scanning, branch protection, signed commits) cannot be lenient.** Every `--force-skip-*` flag emits an audit record (timestamp, user, reason, commit SHA) to `.forge/audit.log`, surfaced in PR templates. **Rationale**: agents must not silently bypass; humans get an emergency lever that is visible.

---

## 4. Workstream Table (WS1–WS20)

| ID | Title | Status | Wave | Depends on | Effort | Value | Note |
|----|-------|--------|------|-----------|--------|-------|------|
| WS1 | Forge CLI abstraction | Aligned | 1 | — | M | 5 | Keep; already shipping. Add `forge config` to inspect effective tree. |
| WS2 | Stages as swappable agents | Reframe | 2 | WS14, WS15 | L | 5 | Each stage becomes an L2 agent extension, not a hard-coded command. |
| WS3 | Beads as adapter, not spine | Reframe | 2 | WS14 | M | 4 | Issue tracker becomes pluggable; beads is the default L2 adapter. |
| WS4 | Handoff schema | Aligned | 1 | — | S | 5 | Promote schema to L1 contract; freeze v1 wire format. |
| WS5 | Rubric gate as default | Reframe | 2 | WS14 | M | 4 | Move rubric out of core into L2 default gate; tunable in patch.md. |
| WS6 | Parallel agent teams | Defer | — | v3.x | XL | 3 | Out of scope; revisit after Wave 5. |
| WS7 | Safety hard-rails | Aligned | 1 | WS14 | M | 5 | Becomes L1; refuse-with-hint logic lives here. |
| WS8 | Long-running orchestration | Aligned | 4 | WS2 | L | 4 | Keep; minor changes for layered config. |
| WS9 | Eval infrastructure | Aligned | 4 | WS2, WS18 | L | 4 | Keep; evals run against effective config. |
| WS10 | Review parsers (Greptile/Sonar/CodeRabbit) | Aligned | 3 | WS2 | M | 4 | Keep; each parser becomes an L2 extension. |
| WS11 | Context7 skills | Aligned | 3 | WS18 | M | 3 | Keep; integrate with skill-generation pipeline. |
| WS12 | Detect vs verify split | Reframe | 3 | WS7 | S | 3 | Detector lives in L2; verifier lives in L1. |
| WS13 | Hard rails (L1) vs toggleable gates (L2) | Reframe | 1 | WS7, WS14 | M | 5 | Already implied by Q3; this WS does the actual code split. |
| WS14 | forge-core contract extraction | New | 1 | — | L | 5 | Carve handoff schema, lifecycle contract, manifest spec into `forge-core/`. |
| WS15 | `.forge/config.yaml` schema migration | New | 1 | WS14 | M | 5 | Move config out of `WORKFLOW_STAGE_MATRIX`; add JSON schema + migration tool. |
| WS16 | Extension system | New | 2 | WS14, WS15 | XL | 5 | Manifest, resolver, lockfile, sandbox, marketplace client. |
| WS17 | `patch.md` + `forge upgrade` self-healing | New | 2 | WS15, WS16 | L | 4 | Auto-extract over 40 lines, conflict detection on upgrade, dry-run. |
| WS18 | Skill generation from observed work | New | 3 | WS9 | L | 4 | Mine session transcripts → propose skills → user approves → publish. |
| WS19 | User profile (L4) + git-backed sync | New | 4 | WS15, WS16 | M | 3 | `~/.forge/profile/`; optional server is post-v3. |
| WS20 | Doc reorganization | New | 5 | all | M | 3 | `docs/{work,reference,guides,adr}/`; ADRs for the 3 locked decisions. |
| forge-s0c3 | Premature 7→5 stage merge | Kill | — | — | — | — | Removed; stages are now per-project via L3. |

---

## 5. Wave Plan

### Wave 1 — Foundation (Weeks 1–4)
**Goals**: Carve L1, freeze contracts, ship config schema. Nothing user-visible changes yet.
**Parallel work**: WS14 (contract extraction) ‖ WS4 (handoff schema freeze) ‖ WS15 (config schema + migration tool) ‖ WS13 (rails/gates code split) ‖ WS7 (refuse-with-hint logic) ‖ WS1 (`forge config` inspect command).
**Exit criteria**: `forge-core/` package builds standalone; existing v2 install passes regression suite when run on top of L1+L2; `.forge/config.yaml` round-trips via migration tool on 3 sample repos.

### Wave 2 — Extension System (Weeks 5–8)
**Goals**: Make L2 swappable. Ship marketplace and patch.md.
**Parallel work**: WS16 (manifest, resolver, lockfile, sandbox) ‖ WS2 (re-package each stage as an extension) ‖ WS3 (beads adapter extraction) ‖ WS5 (rubric gate extraction) ‖ WS17 (patch.md tooling, auto-extract, `forge upgrade`).
**Exit criteria**: A user can replace `/dev` with a custom extension via patch.md; `forge upgrade` round-trips without losing overrides; marketplace install resolves SHA-pinned and fails closed on tampered SHA.

### Wave 3 — Review, Skills, Detection (Weeks 9–11)
**Goals**: Move ecosystem integrations to extensions; turn skills into a pipeline.
**Parallel work**: WS10 (parsers as extensions) ‖ WS11 (Context7 wiring) ‖ WS12 (detect/verify split) ‖ WS18 Phase 1 (transcript mining + proposal UX).
**Exit criteria**: At least 3 review-parser extensions installable from marketplace; skill-generation produces ≥1 useful skill per 5 dev sessions in eval; detect/verify split shipped behind feature flag.

### Wave 4 — Long-running, Eval, Profile (Weeks 12–14)
**Goals**: Multi-session and multi-machine ergonomics.
**Parallel work**: WS8 (orchestration over layered config) ‖ WS9 (eval against effective config) ‖ WS19 (L4 profile, git-backed sync) ‖ WS18 Phase 2 (skill publishing).
**Exit criteria**: Same project on two machines produces identical effective config; eval harness reports per-layer attribution; profile sync round-trips via git.

### Wave 5 — Docs, ADRs, Cutover (Weeks 15–18)
**Goals**: Make v3 the default; retire v2 paths.
**Parallel work**: WS20 (doc reorg + ADR-001/002/003 for Q1/Q2/Q3) ‖ deprecation messaging in v2 commands ‖ migration guide ‖ release.
**Exit criteria**: `bunx forge@latest setup` installs v3; v2 monolith path removed from `master`; ADRs merged; release notes published.

---

## 6. Open Questions Needing User Input

1. **Marketplace governance** — who approves additions to `forge-marketplace.json`? (Single maintainer? PR + 2 reviewers? Automated SHA-only acceptance from a trusted GH org?) Affects WS16 launch policy.
2. **Lenient-mode telemetry** — should opting into lenient mode at L3 phone home (anonymized) so we learn which gates teams disable most? (Privacy vs product feedback tradeoff.) Affects WS7 / WS13.
3. **L4 sync transport** — Wave 4 ships git-backed profile sync. Is the post-v3 optional server (Q-from-design-doc) a Forge-hosted service, a self-hosted reference impl only, or dropped entirely? Affects WS19 surface area.

---

## 7. Success Metrics

- **Override adoption**: ≥30% of active projects ship a non-empty `patch.md` within 60 days of v3 GA. (Indicates the layering is being used, not ignored.)
- **Upgrade safety**: `forge upgrade` succeeds without manual intervention on ≥95% of projects in the eval corpus.
- **Marketplace health**: ≥10 third-party extensions listed in `forge-marketplace.json` within 90 days, zero SHA-mismatch incidents.
- **Refuse-with-hint efficacy**: ≥80% of refuse events are resolved by following the hint within the same session (measured via audit log + session reconciliation).
- **Skill generation yield**: skill-generation pipeline produces ≥1 user-approved skill per 5 `/dev` sessions in eval.
- **Time-to-customize**: a developer can swap one stage end-to-end (read docs → write patch.md → commit) in under 30 minutes.

---

## 8. Risks + Mitigations

| # | Risk | Mitigation |
|---|------|------------|
| 1 | **Patch.md becomes the new monolith** — projects pile every override into one file until it's unreviewable. | 40-line auto-extract (Q2) is enforced by `forge` itself; CI lint warns above 200 total lines; `forge config explain` shows resolved tree, not raw patches. |
| 2 | **Marketplace supply-chain attack** — malicious extension at a pinned SHA. | SHA pinning + sandbox at L1 + `forge-core` allowlist for filesystem/network capabilities + signed manifest in marketplace JSON. |
| 3 | **L1/L2 boundary creep** — pressure to put "just one more thing" into L1 erodes the swappability promise. | Every L1 addition requires an ADR; CI guard fails PR if `forge-core/` grows beyond a budgeted line count without an ADR reference. |
| 4 | **Migration breaks existing v2 users mid-flight** — the 14-week cutover spans live projects. | v2 stays on `master` behind a feature flag through Wave 4; v3 ships as opt-in (`forge --v3`); cutover only at Wave 5 after ≥30 dogfood weeks. |
| 5 | **`forge upgrade` mis-merges patches** — overrides silently dropped or duplicated after a base extension changes. | Three-way merge with explicit conflict markers (WS17); `forge upgrade --dry-run` mandatory in CI; audit log records every patch resolution decision. |

---

**Word count**: ~1,950. Ready for review.
