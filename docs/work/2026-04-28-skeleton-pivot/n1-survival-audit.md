# N=1 Survival Audit — Forge v3 Locked Plan

**Test**: Solo dev installs v3. No community, no marketplace traffic, no future maintainer updates. Does it retain?

## N=1 Retention Scorecard

| Checkpoint | Still using? | Why / Why not |
|---|---|---|
| Day 1 | 60% | Install + `/plan` + `/dev` produces a real PR with TDD-enforced commits. The 7-stage flow is the demo. But "skeleton + marketplace" pitch lands as empty when there's no marketplace to browse. |
| Day 7 | 40% | Beads is the hook — `bd ready` after a context switch genuinely beats re-reading PR comments. Risk: TDD gate refuses on a legitimate WIP commit, dev hits `--force-skip-tdd`, asks why they're paying this tax. |
| Day 30 | 25% | Beads has ~30–60 issues and a real dependency graph. That's the switching cost. L1 rails have prevented maybe 1–2 bad commits — invisible win. `patch.md` is empty or ~5 lines. |
| Day 90 | 15% | If they survived Day 30, the workflow is muscle memory. If they didn't customize `patch.md`, the layered config is dead weight they're paying schema cost for. The 6-harness translator is unused (they picked one harness Day 1). |
| Day 365 | 8–10% | Survivors are people who fell in love with Beads-as-a-product. Forge-the-harness is a thin wrapper they tolerate. The 5 templates / agentskills.io / marketplace are pure dead weight at N=1. |

## Top 3 Features That Genuinely Retain N=1

1. **Beads + Dolt persistent issue state (D-implicit)** — the only thing that compounds in value with no community input. Day-7 `bd ready` after a break is the killer feature. Cross-machine sync is a *bonus*; the local graph is the moat.
2. **L1 rails / TDD gate (D3)** — invisible-but-real prevention. Solo dev with no reviewer benefits MORE than a team dev because there's no second pair of eyes. The audit log is irrelevant; the *refusal* is the value.
3. **`forge upgrade --rollback` snapshot (D7)** — the only feature that pays off precisely when nobody is around to help. Solo + bad upgrade + no community = this is the lifeline.

## Top 3 Features That Don't Move N=1 Retention

1. **D1 curated marketplace + D11 6-harness translator + D12 agentskills.io** — pure community bets. At N=1 the user picks one harness and never installs an extension. Defer all of it past v3.0.
2. **D9 5/3 templates + D14 translator workstream** — useful only when the user *publishes* an adapter. Solo dev consumes, doesn't author.
3. **D5 per-user overlays + D8 `forge options why` resolution chain** — the L1→L4 layering is invisible at N=1 because layers L3 and L4 are empty. Solo dev has one config, not four.

## 1 Killer N=1 Feature the Plan Is Missing

**`forge recap`** — a "what did I do last week" command that reads Beads + git + audit log and produces a personal weekly digest (commits shipped, issues closed, gates triggered, time-since-last-touch on stale branches). Solo devs have no standup, no PR review, no teammate noticing they've drifted. A weekly self-mirror is the single thing that converts accumulated Beads/audit data into *felt value* for one person. Cost: ~1 week. Replaces the marketplace as the "open Forge on Monday" reason.

## Abandonment Scenario (Specific)

**Maya, indie React dev, week 5.** She installs v3, runs through `/plan` → `/dev` on a side-project payments feature. Day 12 her TDD gate refuses a commit because she renamed a test file and the heuristic loses the link. She uses `--force-skip-tdd` once. Day 18 it happens again on a refactor. Day 22 she opens her own bypass alias. Day 30 she realizes she's run `--force-skip-tdd` more than the gate has caught a real miss. She uninstalls the pre-commit hook but keeps Beads because `bd ready` is genuinely useful. **Forge lost; Beads won.** Lesson: the L1 rails need a personal-noise-floor calibration mode, or solo devs route around them within 30 days.

## 1 Big Ask for the User

Imagine a specific solo dev — Maya from above, or your own version. **Walk me through her Tuesday morning of week 6.** Concretely: she opens her laptop. What does she type first? Does `forge` appear in that sequence, or does she go straight to `code .` + `claude`? If Forge isn't in her muscle-memory by week 6, every locked decision past Wave 1 is theater. The plan needs a Tuesday-of-week-6 user story before any wave merges.
