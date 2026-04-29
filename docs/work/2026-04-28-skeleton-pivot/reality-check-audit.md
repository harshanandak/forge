# Forge v3 Reality Check — 6-Week MVP-A Audit

**Date**: 2026-04-29
**Scope**: D1–D14 buildability vs locked 6-week timeline

---

## 1. W0 in 1.5 weeks (forge migrate PoC + 5 spikes)

**Evidence**: `forge-ymff` lists 5 spikes (Cursor `.mdc` alwaysApply, Cursor agents/Composer, Codex slash dir, patch.md anchor bench <10% orphan, cross-machine race 50 trials <5%) PLUS `forge-0uo0` migrate PoC. Cursor alwaysApply is undocumented stable — needs primary-source confirmation. Cross-machine race needs 2 machines × 50 trials = real infra. agentskills.io adoption check is web research, not in `forge-ymff` description.

**Locked**: 1.5w. **Realistic**: 2.5–3w. Race bench alone is 3 days; migrate PoC is 4–5 days; anchor bench is 2 days; spec verification is parallel but blocked on each harness's docs being stable.

**Verdict**: TIGHT → ASPIRATIONAL.

---

## 2. Translator for 6 targets in 2 weeks (D14)

**Evidence**: `scripts/sync-commands.js:201-249` `AGENT_ADAPTERS` has 8 entries but transforms are trivial — only `copilotTransform` (`sync-commands.js:176`) and `keepDescriptionAddMode` do real shape work. Claude/OpenCode/Kilo/Roo just call `({...fm})` or `stripAllFrontmatter`. Cursor adapter does NOT emit `.mdc` with `alwaysApply` frontmatter — it just sets extension. There is NO `opencode.json` emission, NO Codex prompt-file convention, NO rules-file format encoder for Cline/Kilo. Plugin manifests in `lib/agents/*.plugin.json` describe Forge plugins, not target manifests.

**Locked**: 2w folded into N7+N10. **Realistic**: 4–5w. Each harness needs: native format emitter + capability matrix + golden-fixture tests + round-trip validation. agentskills.io→Cursor `.mdc` alone with frontmatter validation is ~3 days.

**Verdict**: ASPIRATIONAL.

---

## 3. forge migrate PoC against 228 issues + WORKFLOW_STAGE_MATRIX

**Evidence**: `lib/workflow/stages.js:42` — `WORKFLOW_STAGE_MATRIX` is `Object.freeze({...})`, 4 classifications mapping to stage arrays. Trivial to serialize to YAML. Beads issues are JSONL (`.beads/issues.jsonl`, one issue per line, schema includes id/title/status/dependencies/comment_count). Auto-migratable for shape.

BUT: green diff is the constraint. `enforce-stage.js:13` introduces `STATELESS_ENTRY_STAGES = new Set(['plan','dev','validate','verify'])` plus override-stage payload semantics. `state-manager.js`, runtime-health interactions, and 200+ existing dependency edges in beads must round-trip. Likely 5–10% manual fixup on dependency edges.

**Locked**: implicit ~3–5 days inside W0. **Realistic**: 5–7 days for green diff. Schema piece is easy; semantic equivalence test harness is the bulk.

**Verdict**: BUILDABLE, TIGHT.

---

## 4. review-coderabbit template (28-min walkthrough)

**Evidence**: CodeRabbit has a CLI (`coderabbit-cli`) but it requires a paid CodeRabbit subscription tied to GitHub App install for full review behavior. The free tier only does basic linting locally. No code in repo currently integrates CodeRabbit (grep for "coderabbit" in lib/ → none). Auth flow is per-repo OAuth via GitHub App. Demo without subscription will be hollow.

**Locked**: 1 of 3 templates at MVP. **Realistic**: 1w to build template + 1 unknown blocker for subscription/auth in demo env.

**Verdict**: TIGHT (demo dependency on paid third-party). Risk: 28-min walkthrough requires live API quota.

---

## 5. L1 rails — 5 rails enforceable today?

**Evidence** (`v3-redesign-strategy.md` D3 lists: TDD gate, secret scan, branch protection, signed commits, classification router):

| Rail | Today |
|---|---|
| TDD gate | YES — Lefthook pre-commit per `CLAUDE.md` |
| Branch protection | YES — pre-push hook |
| Classification router | YES — `stages.js:42` `WORKFLOW_STAGE_MATRIX` + `enforce-stage.js` |
| Secret scan | NOT in repo — needs gitleaks/trufflehog wiring |
| Signed commits | NOT enforced — git config only |

**Locked**: all 5 in L1. **Realistic**: 3 exist, 2 need new infra (~3–5 days each, including audit-record plumbing for `--force-skip-*` per D3).

**Verdict**: BUILDABLE but underestimated.

---

## 6. patch.md anchor bench in 2 days

**Evidence**: `forge-ymff` calls for "rename anchor, replay 5 patches, measure orphan rate <10%". No anchor system exists in repo today. Must first build the anchor extractor + patch replayer before benching. That's ~1 week of net-new infra, then the bench is 1 day.

**Verdict**: ASPIRATIONAL within W0.

---

## TOP 3 LOCKED DECISIONS LIKELY TO SLIP

1. **D11 (6-harness translator in 2w)** — `sync-commands.js:201` shows only 2 of 8 adapters do real shape transforms today. Real translation work is ~4–5w.
2. **D10 (W0 migrate PoC green diff)** — semantic equivalence harness on 228 issues + matrix is harder than schema mapping suggests.
3. **D9 (review-coderabbit demo)** — third-party paid-tier dependency is unaccounted-for risk.

## NOT-IN-PLAN TASKS THE TEAM WILL DISCOVER

1. **agentskills.io spec adapter layer** — `lib/skills/` does not exist; current skills live as flat `.claude/skills/` markdown. Need an emitter that maps SKILL.md frontmatter to each target's native format. Touches `scripts/sync-commands.js:201`.
2. **Audit-record plumbing for `--force-skip-*`** (D3) — `enforce-stage.js` has no audit log writer; needs to integrate with `.beads/interactions.jsonl` or a new `.forge/audit.log`. Currently stage refusals just throw.

## REALITY-CHECK QUESTION

If the W0 anchor bench shows orphan rate >10% on a simple anchor rename, do you cut D2 (hybrid patch.md) and fall back to one-file-per-patch, or extend W0 by a week to build a smarter anchor resolver?

## TOTAL TIMELINE

- **Locked**: 6 weeks MVP-A.
- **Realistic**: **9–11 weeks** assuming W0 extends to 3w, translator to 4–5w, L1 audit/secret/signed-commit rails add 1w, CodeRabbit demo unknowns add 0.5–1w.

Verdict: **6-week claim is ASPIRATIONAL. 9–11 weeks is the honest range.**
