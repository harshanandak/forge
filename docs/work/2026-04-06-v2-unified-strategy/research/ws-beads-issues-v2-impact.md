# Beads Issues v2 Impact Analysis

**Date**: 2026-04-06
**Context**: Forge v2 consolidates 7 stages to 5, replaces Beads/Dolt with forge-issues MCP server + GitHub Issues, converts commands to agents across 6 AI coding agents, and adds parallel dispatch.

**Source**: `bd list` — 50 open issues analyzed (includes children of epics).

---

## Summary

| Category | Count | Action |
|----------|-------|--------|
| A. SOLVED by v2 | 16 | Close when v2 ships |
| B. INCORPORATE into v2 | 11 | Feed into v2 plan |
| C. UNCHANGED by v2 | 14 | Remain as-is |
| D. OBSOLETE (superseded) | 9 | Close as superseded |
| **Total** | **50** | |

---

## A. SOLVED by v2 (close when v2 ships) — 16 issues

These are resolved by v2 architectural changes (forge-issues MCP replaces Beads/Dolt, validate merges into dev, forge CLI as single authority, canonical YAML + 6 templates).

| Issue | Title | Solved By |
|-------|-------|-----------|
| forge-epkw | Beads bootstrap for external worktrees — auto-detect and 3-tier recovery | forge-issues MCP (no more Beads/Dolt) |
| forge-9ats | Beads auto-recovery: read DB name from .beads/metadata.json | forge-issues MCP (no more Beads DB) |
| forge-iaae | Upgrade beads from v0.49.x to latest (SQLite to Dolt migration) | forge-issues MCP (Beads removed entirely) |
| forge-2ne3 | Epic: Beads & Windows — install path fragility, stats/blocked mismatch | forge-issues MCP (Beads removed) |
| forge-puba | Fix bd list --status comma-separated rejection | forge-issues MCP (no more bd CLI) |
| forge-g3e7 | Setup guide: branch protection + PAT configuration for GitHub-Beads sync | forge-issues MCP (GitHub Issues native) |
| forge-nlgg | Bidirectional Forge-GitHub sync — normalized shared issue state | forge-issues MCP (GitHub Issues is authority) |
| forge-ij1 | Forge team sync --pull: import existing GitHub issues | forge-issues MCP (GitHub Issues is source of truth) |
| forge-r6u3 | Naming overload: 'validate' means 3 different things | 7-to-5 consolidation (validate merges into dev, removes ambiguity) |
| forge-4nvf | forge-validate dev requires docs/research/*.md that may not exist | validate merged into dev agent (no separate forge-validate) |
| forge-hwjq | Epic: forge-validate contract mismatches — plan paths, research paths, hardcoded npm | validate merged into dev (forge-validate removed) |
| forge-m1n8.1 | Workflow runtime enforcement core | forge CLI as single workflow authority |
| forge-m1n8.3 | Hook, prerequisite, and repair enforcement | forge CLI as single workflow authority |
| forge-m1n8.4 | Agent capability schema and normalization | canonical YAML + 6 agent templates |
| forge-0g2m | Commit WSL bootstrap fixes and test coverage | forge-issues MCP (Beads scripts removed) |
| forge-byvq | Add preflight script for new environment bootstrap | forge-issues MCP (no Beads/Dolt preflight needed) |

---

## B. INCORPORATE into v2 plan — 11 issues

These map directly to v2 work or contain requirements that v2 must address.

| Issue | Title | How to Incorporate |
|-------|-------|--------------------|
| forge-s0c3 | Workflow consolidation: merge /validate into /dev (7 to 5 stages) | **Core v2 work** — this IS the consolidation. Close after v2 implements it. |
| forge-f3lx | Epic: Forge issue authority and GitHub-backed coordination | **Core v2 work** — forge-issues MCP server fulfills this epic's vision. |
| forge-m0fw | Universal review system — support multiple AI review tools | Feed into review-agent design. Pluggable review tool detection. |
| forge-xdh7 | Agent-agnostic Forge project memory — share context across agents | Feed into forge-issues MCP design. Shared memory via MCP server. |
| forge-dq8j | Epic: Setup hardening — side effects, enforcement, and install UX | v2 setup must incorporate these learnings (opt-in defaults, fail-fast). |
| forge-dq8j.1 | Setup defaults — reduce side effects and require opt-in | v2 setup design constraint. |
| forge-dq8j.2 | Workflow enforcement — real plan gates and prerequisite failures | v2 agent design must enforce real gates. |
| forge-dq8j.3 | Install and UX parity — packaging, docs, help, and IDE discoverability | v2 packaging and onboarding. |
| forge-fjbh | Extension system architecture — pluggable add-ons for Forge workflow | v2 MCP server is the extension mechanism. Beads becomes optional extension. |
| forge-m1n8.5 | Codex, Cursor, and Kilo parity adapters | v2 targets 6 agents. Parity requirements carry forward. |
| forge-m1n8.6 | OpenCode and Copilot parity adapters | v2 targets 6 agents. Parity requirements carry forward. |

---

## C. UNCHANGED by v2 — 14 issues

These are independent of the Beads/workflow/agent changes and remain as-is.

| Issue | Title | Reason Unchanged |
|-------|-------|------------------|
| forge-ujq.2 | Lefthook missing in worktrees — no quality gates on raw git push | Git hooks infrastructure, independent of v2 |
| forge-1uf6 | Bare-repo guard catch block should return error, not continue | Pure bug in worktree.js |
| forge-6fm1 | README workflow profile stage counts don't match PROFILES code | Documentation accuracy bug |
| forge-7vll | Resolve rebase conflicts against origin/master for setup hardening branch | Stale branch cleanup |
| forge-9pxu | Epic: CI & git hooks alignment — divergent lint, path filters | CI/CD alignment, independent of v2 |
| forge-jgwh | Standardize shell model documentation (WSL vs Git Bash vs PowerShell) | Platform docs, independent of v2 |
| forge-vmjc | Epic: npm package contents vs git repo — sync/setup mismatch | npm packaging, independent of v2 |
| forge-vvhz | Migrate test-env/ from node:test to bun:test — unify test runner | Test infrastructure |
| forge-0ht2 | Epic: Structural maintainability — extract bin/forge.js into lib/ modules | Code structure refactor |
| forge-2b82 | Epic: Maintainer scripts — sync-commands.js & check-agents.js gaps | Script tooling |
| forge-mymu | Epic: Coverage gap — bin/forge.js excluded from c8 | Test coverage |
| forge-30k | Documentation link checker — Lefthook pre-push hook + GitHub Action | CI tooling |
| forge-dfup | --type persistence depends on auto-detect: saveWorkflowTypeOverride can silently no-op | Bug in workflow type system |
| forge-u7go | Source WSL bootstrap helper from all bash entrypoints | WSL platform fix (still needed for remaining bash scripts) |

---

## D. OBSOLETE (close as superseded) — 9 issues

These address problems in systems that v2 removes entirely.

| Issue | Title | Why Obsolete |
|-------|-------|--------------|
| forge-m1n8.7 | Roo and Cline parity review or deprecation path | v2 drops Roo and Cline from supported agents |
| forge-exmb | beads-context-test-issue | Test issue for Beads context — Beads removed |
| forge-oz0t | beads-context-fresh-test | Test issue for Beads context — Beads removed |
| forge-yh1r | beads-context-fresh-test | Test issue for Beads context — Beads removed |
| forge-z1ft | Epic: Enhanced onboarding broken — profiles unused | v2 replaces onboarding with new setup flow |
| forge-x8es | Epic: forge CLI help & surface area — dead flags | v2 rewrites CLI surface entirely |
| forge-cfdi | Command override layer — base + overrides/ for user customization | v2 replaces commands with agents; override model changes |
| forge-9m47 | Composite check()/run() step structure for setup flow | v2 rewrites setup flow |
| forge-gcu | Forge metrics dashboard — cross-team usage analytics | Premature — revisit after v2 stabilizes |

---

## Issues not in main list (P4 / future)

| Issue | Title | Category |
|-------|-------|----------|
| forge-na3x | Future: bidirectional field sync (title/description/labels) | SOLVED — forge-issues MCP handles this natively |
| forge-s3cb | Future: package GitHub-Beads sync as reusable GitHub Action | OBSOLETE — Beads sync removed |
| forge-h5yj | Epic: Nice-to-have — forge doctor, artifact parity test | UNCHANGED — defer to post-v2 |

---

## Recommended Actions

### Before v2 development starts:
1. Close all 9 OBSOLETE issues with note: "Superseded by v2 architecture"
2. Add v2 label to all 11 INCORPORATE issues
3. Link forge-s0c3 and forge-f3lx as primary tracking issues for v2

### During v2 development:
4. As each v2 milestone ships, close corresponding SOLVED issues
5. Use INCORPORATE issues as requirements checklist for v2 agents

### After v2 ships:
6. Close remaining 16 SOLVED issues
7. Triage UNCHANGED issues against new v2 codebase (some bugs may no longer apply)
