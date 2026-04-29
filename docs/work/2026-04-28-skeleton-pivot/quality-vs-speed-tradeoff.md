# Forge v3 Quality-vs-Speed Tradeoff Analysis

**Date**: 2026-04-29
**Scope**: Quality investment audit across the 10 major v3 pieces vs the locked Option-B 6-week plan and the reality-check 9–11w range. (User asked about "10 weeks"; no 10w version exists in the locked docs — see verdict.)

**Evidence anchors**: `n1-moat-technical-deep-dive.md` LOC table (line 152), `reality-check-audit.md` per-item realistic estimates, `v3-redesign-strategy.md` §6 wave plan, `locked-decisions.md` D11/D15 (already internally inconsistent: D11 locks 6 harnesses, D15 locks 3).

---

## Score Table

| # | Item | Score | Delta (days) | Anchor |
|---|---|---|---|---|
| 1 | L1 rails 4-layer enforcement (D19) | UNDER_INVESTED | **+5d needed** | audit: secret scan + signed commits missing; audit-log writer doesn't exist |
| 2 | patch.md anchor-ID three-way merge | OVER_INVESTED | **−10d saved** | deep-dive: 1,500 new LOC + 1,800 test LOC; kill-criterion already names "fall back to full-file overrides" |
| 3 | 3-harness translator native shapes | OVER_INVESTED | **−10d saved** | audit: only 2 of 8 adapters do real work today; realistic 4–5w vs locked 2w |
| 4 | Agent log JSON Schema per event (D17) | OVER_INVESTED | **−3d saved** | directional; lenient ingest + later validation is standard observability practice |
| 5 | Pattern detector + skill suggestion UX (D18) | OVER_INVESTED | **−7d saved** | WS18 phase 1 already PoC-scoped; full UX is post-MVP value, not MVP value |
| 6 | Cross-machine Beads+Dolt sync | RIGHT_LEVEL | 0 | already shipping; three-way merge is Dolt's native behavior, not new code |
| 7 | `forge migrate` v2→v3 100% green diff (D10) | RIGHT_LEVEL | 0 | this is the NO-GO gate; cutting it removes the trust demo |
| 8 | `forge upgrade` self-heal flow | OVER_INVESTED | **−5d saved** | "refuse-with-hint + dump conflict" is already the documented fallback; agent-driven reconcile is gold-plating |
| 9 | Conformance test suite automation | OVER_INVESTED | **−4d saved** | deep-dive's own kill-criterion: "publish contract as docs-only" if second harness can't pass in 1w |
| 10 | 6 vs 3 vs 1 harness coverage | UNDER_INVESTED on Claude; OVER on others | **−7d saved** by cutting to Claude-only MVP, +2d hardening Claude path | D11/D15 already inconsistent; audit estimates 4–5w real work for 6, ~1.5w for Claude alone |

---

## Net Days Delta

- Cuts (items 2,3,4,5,8,9,10-cut): **−46 days**
- Hardens (items 1, 10-Claude): **+7 days**
- **Net: −39 working days ≈ −7.8 weeks** off the realistic 9–11w line, before integration tax.
- Apply 30% integration/contingency tax: **net ≈ −5.5 weeks** real schedule compression.

---

## Verdict on "10-week MVP"

The plan does not have a 10-week version. Locked Option B = **6 weeks**. Reality-check = **9–11 weeks**. With every recommendation in this doc applied:

- **Realistic floor**: 7 weeks (Claude-only MVP, patch.md as full-file overrides, refuse-with-hint instead of self-heal).
- **Realistic ceiling**: 9 weeks (keep 3 harnesses but ship 80% parity, defer conformance automation).
- **10 weeks is achievable** only if W0 holds at 1.5w *and* L1 audit-log + secret-scan + signed-commits get hardened (the items currently most under-invested). Without that hardening, the moat is theatre.
- **6-week locked plan is fiction.** It survives only by ignoring the L1 gaps the audit found.

---

## Don't Cut (quality is the whole product)

1. **Beads+Dolt cross-session resume** — the demo-able N=1 win. Already shipping. Cutting kills the moat.
2. **L1 enforcement** (rails 1–5 actually working, not just declared) — if `--force-skip-tdd` doesn't write an audit entry, the protocol identity is a lie.
3. **`forge migrate` green diff on this repo's 228 issues** — this is the trust demo. 80% with manual fixes ships *as a v2.5 patch tool*, not as v3.

## Cut Hard (quality is theatre)

1. **3-harness perfect parity at MVP** — D11/D15 are already in conflict. Pick Claude. Ship Cursor + Codex as v3.1 with documented capability gaps.
2. **patch.md three-way diff3 self-heal** — `git format-patch` + `git am` + refuse-with-hint covers 80%. Save 10 days. Migration path: layer anchor index on top in v3.1 once real conflict patterns are observed in audit log.
3. **Conformance test suite automation** — ship docs-only contract + a manual checklist. The deep-dive itself names this as the kill-criterion fallback.

---

## Single Shippable Philosophy

**Ship the N=1 moat at full quality. Ship everything else at 80% with refuse-with-hint as the fallback when it breaks.**

The docs already name this split: protocol opinion (TDD, L1 rails, audit log integrity, migrate green diff) is non-negotiable; workflow opinion (stage gates, harness parity, patch sophistication, skill-gen UX) is configurable and degradable. Every quality investment should be filtered through: *"is this protecting the moat, or is this protecting a workflow opinion?"* Workflow opinions get refuse-with-hint and a v3.1 upgrade path. Moat gets gold.

---

**Word count**: ~680
