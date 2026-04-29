# Beads Operations Manifest — Forge v3 Skeleton Pivot

**Date:** 2026-04-28
**Scope:** Canonical list of every beads create/reframe/close needed to align the tracker with the layered-skeleton pivot (L1 locked rails / L2 swappable defaults / L3 patch.md / L4 user profile).
**Locked decisions feeding this manifest:**
- Skill distribution: **allowlist** (`forge-marketplace.json`) — not mirror org.
- Patch format: **hybrid** — single `patch.md` with anchor-ID blocks, optional `patches/<stage>.md` overflow.
- Disabled-required: **refuse + hint** (single-line notice with `forge stages enable <id>`).

Source plans:
- `docs/plans/2026-04-28-layered-skeleton-config-proposal.md`
- `docs/plans/2026-04-28-extension-system-design.md`
- `docs/plans/2026-04-28-skill-generation-from-observed-work-design.md`
- `docs/plans/2026-04-28-skill-distribution-design.md`

---

## A. NEW ISSUES TO CREATE

> Total: **18**. Effort key: **S**=<1d, **M**=2-5d, **L**=1-2w, **XL**=2w+. Value 1-5 (5=highest).

### N1. EPIC: Forge v3 Skeleton Architecture
- **Type:** epic · **Priority:** P0 · **Wave:** — (umbrella) · **Effort:** XL · **Value:** 5
- **Parent:** none (replaces forge-titl as top-of-tree for v3)
- **Description:** Forge pivots from a fixed 7-stage workflow to a layered skeleton: L1 locked rails (TDD gate, branch protection, hard-gate runtime), L2 swappable defaults (stages, gates, adapters in `.forge/config.yaml`), L3 user `patch.md` overrides, L4 git-backed user profile. This epic tracks all workstreams: core contract extraction, config layer, extension system, distribution/marketplace, observed-work skill generation, docs reorg. Replaces v2 wave epics for net-new work; v2 in-flight items (forge-krfx, forge-6muf) are reframed as inputs.
- **Blocks:** —
- **Depends-on:** —
- **Acceptance:**
  1. All Wave-1 issues (N2-N5) closed and `forge options *` introspection API live.
  2. `extension.yaml` spec frozen; at least one third-party extension installed via `forge add`.
  3. `forge insights --review-feedback` PoC running on this repo.

### N2. Extract `forge-core` contract (Stage interface, lifecycle, schema)
- **Type:** feature · **P1** · **Wave 1** · **L** · **Value 5**
- **Parent:** N1
- **Description:** Carve out the immutable contract that Layer 1 enforces and Layer 2 implements against: `Stage` interface (`enter`, `run`, `exit`, `gates[]`), lifecycle events, JSON schemas for handoff context, and the registry shape. Today this is implicit in `lib/workflow/stages.js`, `lib/workflow/enforce-stage.js`, and `lib/runtime-health.js`. Extract into `lib/core/` with no behavior change, then publish as `@forge/core` for consumers. This is the load-bearing precondition for everything else — extensions, patch.md, profiles all bind to this contract.
- **Blocks:** N3, N5, N7
- **Depends-on:** —
- **Acceptance:**
  1. `lib/core/stage-contract.js` exports `StageContract`, JSON schema published.
  2. All existing stage code imports from `lib/core/` (no duplicate definitions).
  3. `bun test` passes; `forge run --dry-run plan` works against the new contract.

### N3. Layer 1 lockdown spec (5 rails + audit log format)
- **Type:** feature · **P1** · **Wave 1** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Define the exact 5 locked rails (tdd-gate, branch-protection, hard-gate-runtime, classification-router, stage-entry-guard) with formal "cannot be disabled" semantics and an audit log for any attempt to bypass them. Doc lives at `docs/reference/layer-1-rails.md`; runtime enforcement in `lib/core/rails.js`. `forge options why <rail>` returns `locked: core` and cites the file/line. Audit entries written to `.forge/audit.log` (NDJSON, append-only).
- **Blocks:** N4, N9
- **Depends-on:** N2
- **Acceptance:**
  1. 5 rails enumerated with code citations and test coverage.
  2. Attempt to set `core.tdd-gate.enabled: false` in config.yaml → schema validation error.
  3. Audit log records every `--force` bypass with actor, timestamp, rail, reason.

### N4. Migrate `WORKFLOW_STAGE_MATRIX` → `.forge/config.yaml`
- **Type:** feature · **P1** · **Wave 1** · **L** · **Value 5**
- **Parent:** N1
- **Description:** Replace the hardcoded matrix at `lib/workflow/stages.js:42` with a runtime-loaded config. `canTransition()` and `assertTransitionAllowed()` filter the matrix through `.forge/config.yaml` so disabled stages are skipped in `nextStages` computation. Six classification paths (critical/standard/refactor/simple/hotfix/docs) move from constants into config defaults. Migration writes a default `.forge/config.yaml` on `forge upgrade` for existing projects.
- **Blocks:** N5, N6, N11
- **Depends-on:** N3
- **Acceptance:**
  1. Deleting `WORKFLOW_STAGE_MATRIX` constant breaks nothing; tests still pass.
  2. Setting `stages.validate.enabled: false` skips validate in transitions.
  3. `forge upgrade` migrates existing repos with a generated config.yaml + audit entry.

### N5. `forge options *` introspection API
- **Type:** feature · **P1** · **Wave 1** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Implement the 7 introspection commands the agent uses instead of reading YAML directly: `forge options stages|gates|adapters|diff|why <id>|lint`, plus `forge run <stage> --dry-run`. JSON output mode (`--json`) for agent consumption. This is the API contract that keeps agents pinned to forge CLI per project rule "agents only use forge commands".
- **Blocks:** N6, N12
- **Depends-on:** N2, N4
- **Acceptance:**
  1. All 7 subcommands implemented with JSON + human output.
  2. `forge options why validate` cites `source: config | core | patch.md:<line>`.
  3. `forge options lint` warns on critical+validate-disabled combo (refuse+hint policy).

### N6. Install modes (`--minimal | --standard | --full`)
- **Type:** feature · **P2** · **Wave 2** · **M** · **Value 4**
- **Parent:** N1
- **Description:** Three install profiles for `bunx forge setup`. Minimal = L1 rails only (no beads, no lefthook, no greptile). Standard = L1 + default L2 stages + beads + lefthook. Full = standard + sample extensions + sample patch.md. Replaces the current "install everything" UX. Profile selection writes a `.forge/install-mode` marker that `forge upgrade` honors.
- **Blocks:** —
- **Depends-on:** N4, N5
- **Acceptance:**
  1. Three install paths produce three different `.forge/config.yaml` defaults.
  2. `bunx forge setup --minimal` works without beads installed.
  3. Existing fixture tests cover all three modes.

### N7. `extension.yaml` manifest spec + validator
- **Type:** feature · **P1** · **Wave 2** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Freeze the v1 manifest schema (`apiVersion: forge.dev/v1`, `kind: Extension`, spec fields per design doc §1) and ship a validator at `lib/extensions/manifest-schema.js`. Validator enforces: kebab-case names, semver versions, peer-range against forge core, permissions allowlist, layer in {1,2,3}. Used by `forge add` (install-time) and CI linting (publish-time).
- **Blocks:** N8, N9
- **Depends-on:** N2
- **Acceptance:**
  1. JSON Schema published at `lib/extensions/manifest-schema.json`.
  2. 6 round-trip fixtures (valid + 5 invalid) pass/fail correctly.
  3. `forge add --dry-run` runs validator and prints diff.

### N8. Source resolvers (`gh:`, `npm:`, `./local`, `https:`, `gist:`)
- **Type:** feature · **P1** · **Wave 2** · **L** · **Value 5**
- **Parent:** N1
- **Description:** Implement five resolver modules under `lib/extensions/resolvers/<scheme>.js`. Each returns `{tarballStream, sourceMeta}`, writes to temp dir, runs `validateManifest()`, atomically renames into `.forge/extensions/<author>/<name>/`. `https:` requires `--allow-untrusted` unless checksum supplied. Versioned cache kept at `.forge/extensions/.cache/` for rollback.
- **Blocks:** N9, N10
- **Depends-on:** N7
- **Acceptance:**
  1. All 5 resolvers pass install-and-rollback integration test.
  2. Network-failure mid-install leaves no partial extension on disk.
  3. Collision report on duplicate name (exits non-zero unless `--force`).

### N9. `forge.lock` + audit log + `--allow-untrusted`
- **Type:** feature · **P1** · **Wave 2** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Lockfile (committed) records `version`, `source`, `resolved`, `integrity` (SRI), optional `signature`, `installedAt`, `installedBy` per extension. `.forge/audit.log` (NDJSON append-only) records install/update/remove with `trust:` field (signed | checksum-only | none). CI can fail when `trust!=signed`. `--allow-untrusted` skips signature verify but still logs.
- **Blocks:** N16
- **Depends-on:** N3, N8
- **Acceptance:**
  1. `forge add` writes lockfile + audit entry; `forge.lock` diff is reviewable.
  2. Tampered tarball (mismatched SRI) → install refused.
  3. `forge audit verify` re-checks all integrity hashes against lockfile.

### N10. Multi-target sync extension (`scripts/sync-commands.js` v2)
- **Type:** feature · **P2** · **Wave 2** · **M** · **Value 4**
- **Parent:** N1
- **Description:** Extend the existing 7-agent sync to walk author-namespaced subtrees (`.claude/commands/<author>/<cmd>.md`). Generate `.forge/registry.json` flat index. Resolve collisions via author-prefix (`/obra:plan` vs core `/plan`). Honor `--check` for CI drift detection; honor `--dry-run` for previews.
- **Blocks:** —
- **Depends-on:** N8
- **Acceptance:**
  1. Installing two extensions with overlapping `/plan` produces both as `/obra:plan` and `/gsd:plan`.
  2. `node scripts/sync-commands.js --check` exits non-zero on drift.
  3. All 7 agent dirs (claude/cursor/codex/opencode/cline/kilo/aider) receive namespaced commands.

### N11. `patch.md` spec + `forge patch record --from-diff`
- **Type:** feature · **P1** · **Wave 2** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Hybrid patch format: single `patch.md` with anchor-ID blocks (`<!-- forge:anchor stage.review.body -->`), optional overflow at `patches/<stage>.md`. Anchors must be declared in default L2 blocks to be patchable. `forge patch record --from-diff` captures a working-tree diff into a properly-anchored patch.md entry. `forge options why <id>` cites `source: patch.md:<line>` when an override applies.
- **Blocks:** N17
- **Depends-on:** N4
- **Acceptance:**
  1. Spec doc at `docs/reference/patch-md-format.md` with 3 worked examples.
  2. `forge patch record --from-diff` round-trips: edit → record → re-apply → diff is clean.
  3. Patch against undeclared anchor → error with hint.

### N12. `forge upgrade` self-heal flow
- **Type:** feature · **P2** · **Wave 3** · **M** · **Value 4**
- **Parent:** N1
- **Description:** `forge upgrade` migrates existing projects from current layout to v3 skeleton. Generates default `.forge/config.yaml` from observed `WORKFLOW_STAGE_MATRIX` usage, scaffolds empty `patch.md`, re-pins extensions in `forge.lock`. Idempotent. Self-heals broken state: missing config → regenerate, drifted lockfile → reconcile, orphaned extension dirs → prompt remove.
- **Blocks:** —
- **Depends-on:** N5, N9, N11
- **Acceptance:**
  1. `forge upgrade` on a v2 repo produces a working v3 layout, all tests pass.
  2. Idempotency: running twice produces identical state.
  3. `forge doctor` finds no issues post-upgrade.

### N13. `forge insights --review-feedback` PoC (Week 1 deliverable)
- **Type:** feature · **P1** · **Wave 1** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Smallest end-to-end slice of skill-generation: detect recurring Greptile/Sonar review categories on this repo's last 50 PRs, surface top 3 candidates with evidence trails, write to `.forge/insights/pending.jsonl`. Validates the data pipeline (sources → detector → ranking → suggestion) before scaling to all 8 trigger patterns. Uses existing `lib/greptile-match.js`.
- **Blocks:** N14
- **Depends-on:** N2
- **Acceptance:**
  1. `forge insights --review-feedback` runs in <30s, prints ranked candidates.
  2. Pending JSONL committed; decisions JSONL appended on accept/reject.
  3. PoC report doc at `docs/work/2026-W18-insights-poc-report.md`.

### N14. `/forge map-codebase` brownfield onboarding (steal from GSD)
- **Type:** feature · **P2** · **Wave 3** · **L** · **Value 4**
- **Parent:** N1
- **Description:** New slash command that scans an existing brownfield repo and proposes: classification of stage paths in use, suggested L2 config, candidate skills from observed git/PR history. Inspired by GSD's `/map-codebase`. Output is a draft `.forge/config.yaml` + `docs/work/onboarding-<date>.md` for user review. This converts "Forge for greenfield" into "Forge for any repo."
- **Blocks:** —
- **Depends-on:** N5, N13
- **Acceptance:**
  1. Run on a non-Forge repo (e.g., a public OSS project) produces a reviewable plan.
  2. Plan cites concrete file paths and commit-history evidence.
  3. User-accept path writes config.yaml + creates onboarding beads issue.

### N15. Rewrite ROADMAP Phase 3 + create BUILDING_BLOCKS.md, SKELETON_TEMPLATES.md
- **Type:** task · **P2** · **Wave 1** · **S** · **Value 3**
- **Parent:** N1
- **Description:** Documentation alignment. ROADMAP.md Phase 3 currently describes v2 wave goals — replace with v3 skeleton goals. New `docs/reference/BUILDING_BLOCKS.md` enumerates L1 rails, L2 default stages/gates/adapters, L3 patch anchors, L4 profile fields. New `docs/reference/SKELETON_TEMPLATES.md` shows 3-4 worked `.forge/config.yaml` templates (minimal/standard/full/team).
- **Blocks:** N18
- **Depends-on:** N3, N4
- **Acceptance:**
  1. Three docs land on master with cross-links.
  2. ROADMAP phase 3 references concrete beads IDs (N1-N18).
  3. README updated to point to new BUILDING_BLOCKS.md as entry point.

### N16. `forge-marketplace.json` + name-collision rule
- **Type:** feature · **P1** · **Wave 3** · **M** · **Value 5**
- **Parent:** N1
- **Description:** Implement the locked allowlist distribution model. `forge-marketplace.json` lives in the Forge repo, schema-compatible with Claude Code's marketplace format. Each entry: `name`, `source`, `sha` (mandatory), `version`, `verified`, optional `attestation_url`. Bot opens nightly PRs to bump SHAs. Name-collision rule: first-come-first-serve in the allowlist; subsequent submissions must use namespace prefix (`@author/name`).
- **Blocks:** —
- **Depends-on:** N9
- **Acceptance:**
  1. `forge add seo-skill` resolves via marketplace and pins SHA.
  2. PR template + bot for nightly SHA bumps live.
  3. Collision-rule documented in `docs/reference/marketplace-policy.md`.

### N17. `forge profile` command + git-backed sync (Path A)
- **Type:** feature · **P2** · **Wave 4** · **M** · **Value 3**
- **Parent:** N1
- **Description:** Layer 4 — user-level profile that persists across projects. `~/.forge/profile.yaml` holds preferred adapters, default install mode, trusted keys, alias preferences. `forge profile sync` does git-backed pull/push to a user-owned profile repo (default: `gh:<user>/forge-profile`). Path A = git-backed (vs cloud sync). Profiles overlay onto project config but never override Layer 1.
- **Blocks:** —
- **Depends-on:** N5, N11
- **Acceptance:**
  1. `forge profile init` scaffolds repo; `forge profile sync` round-trips.
  2. Profile fields documented in BUILDING_BLOCKS.md.
  3. Project config + profile + patch.md merge order verified by integration test.

### N18. Reorg `docs/` to `work/` + `reference/` + `guides/` + `adr/`
- **Type:** task · **P3** · **Wave 4** · **S** · **Value 2**
- **Parent:** N1
- **Description:** Current `docs/plans/` mixes design docs, research, and ADRs. Reorganize: `docs/work/` for in-flight plans/research (date-prefixed), `docs/reference/` for stable specs (BUILDING_BLOCKS, patch-md-format, layer-1-rails), `docs/guides/` for user-facing how-tos, `docs/adr/` for architecture decisions. Add a redirect map in `docs/README.md` so external links don't 404.
- **Blocks:** —
- **Depends-on:** N15
- **Acceptance:**
  1. All existing docs moved to new homes; CI link checker passes.
  2. `docs/README.md` index links every category.
  3. Old paths redirect (or have stub files) for 90 days.

---

## B. EXISTING ISSUES TO REFRAME

| Beads ID | Old WS | Reframe |
|---|---|---|
| **forge-fjbh** | WS-Extensions | **New parent:** N1. **New description:** "Implementation umbrella for the L2/L3 extension system. Subdivided into N7 (manifest spec), N8 (resolvers), N9 (lockfile + audit), N10 (multi-target sync), N11 (patch.md), N16 (marketplace). This issue stays open as a tracking parent and is closed only when all six are merged." **New deps:** depends-on N2, blocks N1. |
| **forge-cfdi** | Override layer | **New parent:** N1. **New description:** "Superseded conceptually by L3 `patch.md` (N11) which provides anchor-based override instead of file-tree shadowing. Keep open as the *integration* issue: ensure `overrides/` directory continues to work during the deprecation window, with a migration tool to convert overrides → patch.md anchors." **New deps:** depends-on N11. |
| **forge-ny6j** | Neutral command source | **New parent:** N1. **New description:** "Move canonical commands out of `.claude/commands/` into `lib/commands/` (neutral). Now scoped to v3: this is a precondition for N10 (multi-target sync v2) since author-namespaced subtrees presume a neutral root. Bump priority P4→P2." **New deps:** blocks N10. |
| **forge-s0c3** | WS2 7→5 stages | **New description:** "Replaced by L2 toggle model (N4). Users who want 5 stages set `stages.validate.enabled: false` and `stages.premerge.enabled: false` in `.forge/config.yaml`. This issue becomes the *acceptance test* for the toggle model: prove the 7→5 collapse works via config alone, no code change." **New parent:** N4. **New deps:** depends-on N4. |
| **forge-m1n8.4** | Agent capability schema | **New description:** "Becomes the L1 contract for adapters (N3 rails: how stages discover agent capabilities). Schema must be lockable so adapters can't lie about capabilities. Re-scope to define `AgentCapability` schema in `lib/core/`, integrate with N3 lockdown spec." **New parent:** N3. **New deps:** depends-on N2, blocks N3. |
| **forge-titl** | v2 master tracking | **New description:** "v2 master tracking — frozen as 'v2 wave' historical record. Active development moves to N1 (v3 skeleton). Keep open until all v2 in-flight items (forge-krfx Wave-1 sub-issues currently in progress) close; then close with reason 'superseded by N1 (v3 skeleton)'." **No reparent.** |
| **forge-eehh** | v2 Wave 3 | **Close** — see section C. |
| **forge-tujc** | v2 Wave 4 | **Close** — see section C. |
| **forge-6muf** | v2 Wave 2 | **Reframe:** Keep open ONLY for the WS5 evaluator and WS13 guardrails sub-issues, which feed N13 insights. Drop WS2 commands→agents (covered by N4). **New deps:** blocks N13. |

---

## C. EXISTING ISSUES TO CLOSE

| Beads ID | Reason | Replacement |
|---|---|---|
| **forge-eehh** (v2 Wave 3) | Wave 3 (universal review + doc automation + metrics observatory) is reframed: universal review folds into N16 (extension-based reviewers), doc automation into N15+N18, metrics into N13. No standalone wave needed. | N13, N15, N16, N18 |
| **forge-tujc** (v2 Wave 4) | Hardening + polish moves into per-issue acceptance criteria on N1-N18 (each has its own test/docs requirements). No separate wave. | distributed |
| **forge-dwm** (PR8: Advanced Features & Dashboard) | Stale v1 issue; "advanced features" now defined as N13 + N16. | N13, N16 |
| **forge-jvc** (PR7: Documentation Automation) | Replaced by N15 + N18. | N15, N18 |
| **forge-gcu** (Forge metrics dashboard) | Folded into N13 insights pipeline. | N13 |
| **forge-r6u3** (Naming overload: validate) | Resolved by L2 config: `stages.validate` is the single canonical "validate" name. | N4 |

---

## D. DEPENDENCY GRAPH

```
                                    N1 (epic)
                                       |
              +------------------------+------------------------+
              |                        |                        |
           Wave 1                   Wave 2                   Wave 3+4
              |                        |                        |
   +----------+----------+   +---------+---------+   +----------+----------+
   |          |          |   |         |         |   |          |          |
  N2 ----->  N3 ----->  N4   N7 -----> N8 -----> N9  N12      N14        N17
   |          |          |   |         |         |   ^         ^          ^
   v          v          v   v         v         v   |         |          |
  N13        N5 <-------+   N10       N11 ----> N16  +-N5      +-N13     +-N5
   |          |              ^         |         ^             +-N5      +-N11
   v          v              |         v         |
  N14        N6 (W2)        N10       N17       N9
                                       ^
                                       |
                                    forge-cfdi
```

**Key edges:**
- **N2 (core contract)** is the universal precondition.
- **N4 (config.yaml)** unlocks N5/N6/N11 and reframes forge-s0c3.
- **N7 → N8 → N9** is the linear extension-install chain.
- **N13 (insights PoC)** unblocks N14 (map-codebase).
- **N15 (docs)** unblocks N18 (reorg).
- **forge-titl** stays a parallel tracker until v2 Wave 1 in-flight closes.

| Wave | Issues | Blocks downstream |
|---|---|---|
| 1 | N2, N3, N4, N5, N13, N15 | All later waves |
| 2 | N6, N7, N8, N9, N10, N11 | N12, N16, N17 |
| 3 | N12, N14, N16 | N17 (partial) |
| 4 | N17, N18 | — |

---

## E. EFFORT TOTALS

| Wave | S | M | L | XL | Calendar (solo) | Calendar (2 eng) |
|---|---|---|---|---|---|---|
| 1 | 1 (N15) | 3 (N3, N5, N13) | 2 (N2, N4) | 0 | ~5 weeks | ~3 weeks |
| 2 | 0 | 4 (N6, N7, N9, N11) | 2 (N8, N10) | 0 | ~5 weeks | ~3 weeks |
| 3 | 0 | 2 (N12, N16) | 1 (N14) | 0 | ~3 weeks | ~2 weeks |
| 4 | 1 (N18) | 1 (N17) | 0 | 0 | ~1.5 weeks | ~1 week |
| **Total** | **2** | **10** | **5** | **0** (N1 epic only) | **~14.5 weeks solo** | **~9 weeks 2-eng** |

**Notes:**
- N1 (epic XL) is umbrella effort, not additive.
- Solo numbers assume ~80% focus, no cross-cutting interruptions.
- 2-eng numbers assume parallelism on independent issues per wave (N2/N3 parallel in W1; N7/N10 parallel in W2; etc.).
- Add ~20% buffer for v2 in-flight wind-down (forge-krfx sub-issues currently open).

---

## Execution checklist (for follow-up `bd create` session)

1. Create N1 epic first (parent for all others).
2. Create N2-N18 with `--parent forge-<N1-id>` and the deps listed.
3. Run reframe `bd update` commands for forge-fjbh, forge-cfdi, forge-ny6j, forge-s0c3, forge-m1n8.4, forge-titl, forge-6muf.
4. Close forge-eehh, forge-tujc, forge-dwm, forge-jvc, forge-gcu, forge-r6u3 with `--reason "superseded by v3 skeleton (N1)"`.
5. `forge sync` to push to GitHub-backed shared state.
6. Verify with `bd list --status=open -n 100` and `bd show forge-<N1-id>`.
