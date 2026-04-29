# Iteration History — Superseded Design Docs

The documents in this folder were earlier-iteration framings of the v3 skeleton pivot. They have been **absorbed and superseded** by the canonical [FINAL-THESIS.md](../FINAL-THESIS.md) and the D1–D38 ledger in [locked-decisions.md](../locked-decisions.md).

**Why archive instead of delete?** Per the supersedes model documented in [iteration-driven-planning-skill.md](../iteration-driven-planning-skill.md), original framings are preserved so the audit trail (why decisions changed, what we tried before, what evidence flipped which decision) is permanently traceable.

---

## What was moved here

### `v3-skeleton-plan.md`

The **original wave plan + workstream table** from the iteration #1 framing. Workstream verdicts and the original wave structure were folded into [v3-redesign-strategy.md §5/§6](../v3-redesign-strategy.md). The 8-week W0–W5 plan in D37 supersedes every wave plan in this doc.

**Read instead**: [FINAL-THESIS.md §8](../FINAL-THESIS.md#8-the-8-week-realistic-timeline-w0w5) and [v3-redesign-strategy.md §6](../v3-redesign-strategy.md#6-wave-plan--release-staging).

### `building-block-pivot.md`

The **building-block framing** of the pivot — an early articulation of "Forge as composable parts" that was reframed as the "layered skeleton + skill library" model in `v3-redesign-strategy.md` and finalized as the 3-tier architecture (harnesses / skills / runtime) in FINAL-THESIS.md §2.

**Read instead**: [FINAL-THESIS.md §2 (3-tier architecture)](../FINAL-THESIS.md#2-the-3-tier-architecture).

### `v3-ecosystem-audit.md`

The **harness landscape research** that produced D11 (lock 6-harness target). D11 was superseded by D15 (3-harness MVP: Claude + Cursor + Codex CLI) after the Cursor capability spike and the iteration #4 ecosystem narrowing. The audit's evidence stands; its conclusion does not.

**Read instead**: [locked-decisions.md D15](../locked-decisions.md) and [FINAL-THESIS.md §6 (3-harness target)](../FINAL-THESIS.md#6-3-harness-target).

---

## What was NOT moved

Most design docs in the parent folder were **not** archived. They received targeted SUPERSEDED notes inline (e.g., D11 in `locked-decisions.md`, §6 in `v3-redesign-strategy.md`) but their bodies remain authoritative for non-superseded sections. Archive policy: only move a doc when its core conclusion is superseded; leave it in place when only specific sections are.

Active docs that were updated in place rather than moved:

- [v3-redesign-strategy.md](../v3-redesign-strategy.md) — sections 4a (harness target) and 6 (wave plan) marked SUPERSEDED inline
- [locked-decisions.md](../locked-decisions.md) — D11 marked SUPERSEDED-BY-D15, D17 marked REVISED-BY-D23, all other D1–D20 entries remain ACTIVE
- All audits, design refs, and tactical docs — ACTIVE; cited as substrate by D21–D38

---

## How to navigate forward

1. Read [FINAL-THESIS.md](../FINAL-THESIS.md) first.
2. For every claim that surprises you, check [locked-decisions.md](../locked-decisions.md) for the rationale + tradeoff + anti-decision.
3. For "why did we change our minds?", read [LEARNINGS.md](../LEARNINGS.md).
4. Only dive into this `_iteration-history/` folder when you need to understand a *prior* framing for the audit trail.
