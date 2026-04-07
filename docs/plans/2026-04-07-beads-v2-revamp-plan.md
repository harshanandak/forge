# Beads Issue Revamp for v2 Plan

**Date**: 2026-04-07
**Scope**: Classify all 50 open beads issues against the v2 strategy, update each with the correct workstream mapping and parallel execution wave, close obsolete ones.

## Summary

| Action | Count | What happens |
|--------|:-----:|--------------|
| **INCORPORATE** | 31 | Tagged with v2 workstream + wave, stays open, worked in v2 |
| **SOLVED** | 6 | Kept open but marked "solved when WS3/WS2 ships" — closed on v2 release |
| **UNCHANGED** | 9 | Independent work, kept as-is in backlog |
| **OBSOLETE** | 4 | Closed now as superseded (Roo/Cline parity, test fixtures) |

## Workstream Distribution

| Workstream | Issues | Wave(s) |
|-----------|:------:|---------|
| WS1 (CLI + smart status) | 15 | wave-1, wave-4 |
| WS2 (commands → agents) | 9 | wave-2 |
| WS3 (beads wrapper + GitHub sync) | 10 | wave-1 |
| WS4 (context engineering) | 1 | wave-1 |
| WS7 (safety) | 2 | wave-1 |
| WS9 (eval infra) | 1 | wave-3 |
| WS10 (universal review) | 1 | wave-3 |
| WS11 (Context7 tech skills) | 1 | wave-2 |
| WS12 (doc automation) | 1 | wave-3 |
| WS13 (guardrails) | 2 | wave-2 |

## Parallel Execution Waves

Waves are designed so multiple engineers/agents can work simultaneously without stepping on each other. Each wave is a set of issues that share few file dependencies, so they can execute in parallel worktrees.

### Wave 0 (pre-work, tactical, 0-1w)
Ship before v2 starts. 1 issue.
- `forge-7vll` Resolve rebase conflicts on setup-hardening branch

### Wave 1 (Phase 1 Foundation, 4-5w, highly parallel)
19 issues. This is the largest wave — intentional, because WS1 Phase 0 + WS3 + WS4 are the foundational layers that unblock everything else. Split across 2 engineers or 2-3 parallel worktrees.

**Engineer A (or worktree A) — WS3 beads wrapper focus**:
- forge-f3lx (primary tracking epic for WS3)
- forge-nlgg (bidirectional GitHub sync)
- forge-ij1 (initial GitHub pull)
- forge-iaae (beads v0.49 → latest upgrade)
- forge-9ats (SOLVED by shared Dolt launcher)
- forge-epkw (SOLVED by shared Dolt server)
- forge-2ne3 (mostly SOLVED by WS3)
- forge-xdh7 (agent-agnostic project memory)

**Engineer B (or worktree B) — WS1 Phase 0 focus**:
- forge-0g2m (WSL bootstrap fixes)
- forge-u7go (source WSL bootstrap from all entrypoints)
- forge-byvq (preflight script)
- forge-jgwh (shell model documentation)
- forge-puba (bd list --status fix + CRLF hardening)
- forge-ujq.2 (lefthook in worktrees)
- forge-dq8j (setup hardening epic — parent)
- forge-dq8j.1 (setup defaults less invasive)
- forge-2b82 (maintainer scripts — CRITICAL for WS1 pre-work)
- forge-1uf6 (bare-repo guard bug)
- forge-vvhz (test runner migration)

### Wave 2 (Phase 2 Core Workflow, 4w, moderate parallelism)
10 issues. WS2 + WS13 — these all edit agent YAMLs so they need a single editor-of-record per file. Serialize per file but parallelize across different files.

**Serialized on agent YAMLs**:
- forge-s0c3 (primary tracking epic for WS2 consolidation)
- forge-m1n8.1 (workflow runtime enforcement core)
- forge-m1n8.3 (hook + prerequisite + repair enforcement)
- forge-m1n8.4 (agent capability schema)
- forge-m1n8.5 (Codex/Cursor/Kilo adapters)
- forge-m1n8.6 (OpenCode/Copilot adapters)
- forge-hwjq (validate contract mismatches — SOLVED by consolidation)
- forge-r6u3 (validate naming overload — SOLVED by consolidation)
- forge-dq8j.2 (workflow enforcement real gates — WS13)
- forge-fjbh (extension system — WS3 backend interface + WS11 skill pattern)

### Wave 3 (Phase 3 Quality + Reach, 4w, high parallelism)
4 issues. WS10 + WS12 + WS9 are independent workstreams.

- forge-m0fw (primary tracking epic for WS10 universal review)
- forge-4nvf (docs/research files — SOLVED by WS12)
- forge-g3e7 (branch protection + PAT docs — WS3 docs)
- forge-gcu (metrics dashboard — WS9)

### Wave 4 (Phase 4 Hardening + Polish, 2-3w, parallel)
12 issues. Independent polish work, fully parallel.

- forge-dq8j.3 (install and UX parity)
- forge-z1ft (enhanced onboarding broken)
- forge-6fm1 (README workflow profile counts)
- forge-9pxu (CI & git hooks alignment)
- forge-vmjc (npm package contents vs git repo)
- forge-0ht2 (extract bin/forge.js into lib/)
- forge-30k (documentation link checker)
- forge-9m47 (composite check()/run() step structure)
- forge-cfdi (command override layer)
- forge-dfup (--type persistence bug)
- forge-mymu (coverage gap for bin/forge.js)
- forge-x8es (forge CLI help surface area)

## Issues to Close Immediately (OBSOLETE)

4 issues close now as superseded:
- `forge-exmb` (test fixture)
- `forge-oz0t` (test fixture)
- `forge-yh1r` (test fixture)
- `forge-m1n8.7` (Roo/Cline parity — agents dropped from v2)

## Primary Tracking Epics (3)

These three existing epics become the v2 "north star" trackers:

1. **forge-f3lx** → WS3 "Beads wrapper + GitHub coordination" (wave-1)
2. **forge-s0c3** → WS2 "Commands to agents, 7→5 stage consolidation" (wave-2)
3. **forge-m0fw** → WS10 "Universal review system" (wave-3)

Each epic gets its scope updated to reflect the revised v2 plan (wrapper not rewrite, hybrid orchestrator pattern, NormalizedComment interface, etc.).

## Execution Strategy

**Solo engineer (recommended)**: Work waves sequentially. Within each wave, use parallel worktrees for issues with no file overlap.

**2-engineer team**: Engineer A owns WS3 + WS10 (issue/review plumbing). Engineer B owns WS1 + WS2 (CLI + agent workflow). Both converge on WS13 + WS5 in Phase 2.

**Parallel worktree pattern**: Use `forge worktree create forge-<id>` per issue being actively worked. Shared Dolt server (once WS3 Component 1 ships in wave-1) means all worktrees see consistent state.
