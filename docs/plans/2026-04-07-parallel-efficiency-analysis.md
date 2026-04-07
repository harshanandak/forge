# Forge v2 Parallel Efficiency Analysis

**Date**: 2026-04-07
**Method**: Critical-path analysis + list-scheduling simulation across 21 workstream components with real dependencies
**Source of truth**: docs/plans/2026-04-06-forge-v2-unified-strategy.md

## Executive Summary

**Theoretical minimum calendar time: 7.5 weeks** (fixed by critical path, cannot be reduced by adding sessions).

**Sweet spot: 2 parallel sessions** — 16.5 weeks calendar at 98.5% efficiency. Nearly ideal work packing.

**Diminishing returns kick in at 3+ sessions**: the WS3-C2 bidirectional GitHub sync (3 weeks) becomes a serial bottleneck that extra sessions can't work around.

## Parallel Efficiency Table

| Sessions | Calendar weeks | Speedup vs solo | Parallel efficiency |
|:---:|:---:|:---:|:---:|
| **1 (solo)** | 32.5 | 1.00x | 100% |
| **2** | **16.5** | **1.97x** | **98.5%** ← sweet spot |
| 3 | 13.5 | 2.41x | 80.2% |
| 4 | 10.5 | 3.10x | 77.4% |
| 5 | 10.5 | 3.10x | 61.9% ← 5th slot idle |
| 6 | 8.5 | 3.82x | 63.7% |
| 8 | 7.5 | 4.33x | 54.2% ← hits critical path floor |
| 10 | 7.5 | 4.33x | 43.3% ← wasted slots |

## The Critical Path

**7.5 weeks minimum**. No amount of parallelism can beat this.

```
WS3-C1 (Shared Dolt launcher, 0.5w)
    ↓
WS3-C2 (Bidirectional GitHub sync, 3.0w)
    ↓
WS1-status (forge status command, 2.5w)
    ↓
WS1-board (forge board command, 1.5w)
    ─────────────────────────
    Total: 7.5w critical path
```

Every other workstream CAN run in parallel with this chain, so adding sessions beyond 2 only helps fill in the gaps — not extend the floor.

## Why 2 Sessions Is The Sweet Spot

At 2 sessions, work packs near-perfectly:

**Session A (WS3 + WS10 track)** — ships the plumbing:
- WS3-C1 → WS3-C2 (critical path)
- WS3-C3 cloud-agent adapter (parallel)
- WS3-C4 backend interface (parallel)
- WS10 universal review (after WS3-C2)
- WS9 eval infrastructure (independent)

**Session B (WS1 + WS2 + WS4/WS5/WS11/WS13 track)** — ships the UX:
- WS1 Phase 0 → Phase 1 → Phase 2 → Phase 3 → Phase 4 error layer
- WS1-status (after WS3-C2 ships)
- WS1-board (after WS1-status)
- WS4 schema freeze (early, independent)
- WS11 Context7 skills (independent)
- WS13 guardrails (after WS4)
- WS5 evaluator (after WS11 + WS4)
- WS2 commands → agents (after WS13)
- WS7 safety (independent)
- WS8 long-running (after WS4)
- WS12 doc automation (after WS1-claude)

Total Session A: ~16w, Total Session B: ~16.5w, maximum overlap, zero wasted slots.

**Efficiency at 2 sessions: 98.5%** — essentially perfect work packing.

## Why 3+ Sessions Hits Diminishing Returns

At 3 sessions we gain 3w calendar (16.5 → 13.5) but lose 18 points of efficiency (98.5% → 80.2%).

The reason: **the critical path chain prevents Session C from doing anything load-bearing**. Session C can only work on truly independent workstreams (WS7, WS9, WS11, WS8, WS4), and once those are done, it sits idle waiting for the critical path to progress.

At 4 sessions: 10.5w (−3w more), but efficiency drops to 77%.
At 5 sessions: no improvement — the 5th session has nothing to do.
At 6 sessions: barely any improvement, down to 63.7% efficiency.
At 8+: hits the 7.5w theoretical floor, further sessions are pure waste.

## Concrete Scenarios

### Scenario A: Solo developer

- **Calendar**: 32.5 weeks
- **Recommended approach**: **3 sequenced releases** from the strategy doc
  - v2.0 (4-5w): WS3 wrapper + WS1 smart status MVP + Claude Code only
  - v2.1 (5-6w): WS1 complete + WS10 review system + WS12 doc automation
  - v2.2 (6-8w): WS2 all agents + WS5 + WS11 + WS13
- Total calendar: ~16-19w (ships value at 4-5 week intervals)
- Reason: sequenced releases let you learn from real usage between phases, so you're not flying blind for 32 weeks

### Scenario B: 2 engineers (RECOMMENDED)

- **Calendar**: 16.5 weeks (within the originally planned 13-15w range)
- **Efficiency**: 98.5% — nearly perfect work packing
- **Split**:
  - Engineer A: WS3 + WS10 + WS9 + WS12 (backend/plumbing/review)
  - Engineer B: WS1 + WS2 + WS4 + WS5 + WS7 + WS8 + WS11 + WS13 (CLI/UX/agents/safety)
- Both converge in weeks 10-14 on integration + hardening
- This is the **sweet spot**: ship ~2x faster at almost zero coordination cost

### Scenario C: 3 engineers

- **Calendar**: 13.5 weeks (+3w saved vs 2 engineers)
- **Efficiency**: 80.2% (−18pt)
- Worth it if you have strict deadline pressure, but each engineer's time is less well-utilized
- Third engineer owns: WS7, WS8, WS11 (all independent), then helps with WS5 + WS13 integration

### Scenario D: 4+ engineers

- **Calendar**: 10.5 weeks (+3w more) at 77% efficiency
- Not recommended. Coordination overhead + idle time starts to eat savings.
- If you have 4 engineers, consider instead:
  - Ship v2 with 2 engineers (16.5w)
  - Have the other 2 start v3+ research (open-source models, Karpathy auto-research, OpenClaw integration)

## Multi-Session Parallel Work Within One Wave

Even with 1-2 engineers, you can run **multiple parallel sessions** within a single wave using worktrees. Each session works on a different issue in its own worktree.

### Wave 1 (Foundation) — up to 8 parallel worktrees safely

Zero file overlap between these, can all run in parallel:

| Worktree | Work | Person-weeks |
|----------|------|:-:|
| worktree-1 | WS3-C1 Shared Dolt launcher | 0.5 |
| worktree-2 | WS3-C2 GitHub sync (after C1) | 3.0 |
| worktree-3 | WS3-C3 Cloud adapter | 1.0 |
| worktree-4 | WS3-C4 Backend interface | 0.5 |
| worktree-5 | WS1-P0 WSL bootstrap | 1.0 |
| worktree-6 | WS4 Schema freeze | 1.0 |
| worktree-7 | WS11 Context7 skills | 1.5 |
| worktree-8 | WS7 Safety + auto mode | 2.5 |

Wave 1 person-week sum: 11.0 — achievable in 5.5 calendar weeks with 2 engineers using parallel worktrees.

### Wave 2 (Core Workflow) — careful serialization on agent YAMLs

These all edit `.forge/stages/*.yaml` or `.claude/agents/*.md`, so they need a single editor-of-record per file. Parallelize across different files only.

| Parallel group | Issues | Person-weeks |
|---|---|:-:|
| Group A (.forge/stages/plan.yaml) | WS2 plan-agent + WS5 (partial) | 2.0 |
| Group B (.forge/stages/dev.yaml) | WS2 dev-agent + WS13 guardrails | 2.5 |
| Group C (.forge/stages/ship.yaml) | WS2 ship-agent + WS12 doc automation | 2.0 |
| Group D (.forge/stages/review.yaml) | WS2 review-agent + WS10 | 3.0 |
| Group E (.forge/stages/verify.yaml) | WS2 verify-agent | 0.5 |

5 parallel sessions possible if 2-3 engineers coordinate on YAML locks. Wave 2 person-week sum: 10.0 — achievable in 4 calendar weeks with 2 engineers.

### Wave 3 (Quality + Reach) — high parallelism

| Worktree | Work | Person-weeks |
|----------|------|:-:|
| worktree-1 | WS10 Review system (parsers) | 2.5 |
| worktree-2 | WS12 Doc automation | 1.0 |
| worktree-3 | WS9 Eval infrastructure | 1.5 |
| worktree-4 | WS1-error-layer (downstream translation) | 1.0 |
| worktree-5 | WS3-C5 Fork beads (parallel Go work) | 2.0 (deferred to v3 if solo) |

Wave 3 person-week sum: 8.0 — achievable in 3-4 calendar weeks with 2 engineers.

### Wave 4 (Hardening + Polish) — fully parallel

12 issues, all independent, can run in any order across as many worktrees as you have hands. Total ~3-4 person-weeks, 1-2 calendar weeks.

## The Answer

**How fast can v2 ship with parallel sessions?**

| Team | Calendar weeks | Notes |
|------|:---:|-------|
| **1 engineer, sequential** | 32.5 | Not recommended — use 3 sequenced releases instead |
| **1 engineer, 3 releases** | 16-19 | Ships value at 4-5 week intervals |
| **2 engineers, parallel** | **16.5** | ⭐ **RECOMMENDED** — 98.5% efficiency, within 13-15w planning target |
| **3 engineers, parallel** | 13.5 | Rushed but viable |
| **4+ engineers** | 10.5 | Diminishing returns; excess engineers better on v3+ |
| **Theoretical minimum** | 7.5 | Critical path floor — cannot go faster regardless of team size |

**The recommendation**: **2 engineers, 16.5 weeks**. This hits the planning sweet spot and leaves room for slip without pushing the timeline past v2 plans.

## What Can We Do to Shrink the Critical Path?

The 7.5w critical path is `WS3-C1 → WS3-C2 → WS1-status → WS1-board`. To ship faster, we'd need to shorten this chain:

| Critical path step | Current | Can we compress? |
|-------------------|:-:|------------------|
| WS3-C1 (Shared Dolt launcher) | 0.5w | No — already minimum |
| WS3-C2 (GitHub sync) | 3.0w | Maybe to 2.5w by deferring webhook (Method 3) to v3+, already done |
| WS1-status | 2.5w | Maybe to 2w by shipping MVP (3 groups instead of 4) and adding the 4th post-launch |
| WS1-board | 1.5w | Could defer entirely to v2.1 — GitHub Projects v2 sync is additive |

**Aggressive compression scenario**: defer `forge board` to v2.1 and ship MVP `forge status` at 2w. New critical path: 0.5 + 3.0 + 2.0 = **5.5 weeks**. That's the absolute minimum calendar time for v2.0 if we cut scope aggressively.

## Conclusion

- **Use 2 engineers** for 16.5 weeks (recommended)
- **Don't use more than 3** unless you have deadline pressure
- **The critical path is WS3 + WS1 smart views** — any slip there extends the calendar
- **Parallel worktrees within a session** let a single engineer run multiple work streams using the shared Dolt launcher (once WS3-C1 ships in week 1)
- **v2.0 floor is 7.5 weeks** — no team size beats this
- **Aggressive scope cut floor is 5.5 weeks** — if `forge board` defers to v2.1 and status ships as 3-group MVP
