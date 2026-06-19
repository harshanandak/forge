# Forge Kernel Completion Plan — Position Eval & Next Phase

**Date:** 2026-06-19 · **Branch baseline:** origin/master @ #221 (`cf9e753`)
**Status:** Position-eval sections (below) remain accurate. **Ordering SUPERSEDED by [canonical-backlog.md](canonical-backlog.md)** and the surface design by [kernel-skill-surface-design.md](kernel-skill-surface-design.md). The old "Next phase — sequenced PRs" section is retained only as history — its PR-A (build `.claude/commands/` + `sync-commands.js`) **contradicts the locked no-command-surface decision**; do not follow it. Use the canonical backlog.

## Where we are (verified)

The kernel is **substantially built** (PRs #204–#221):

| Capability | PR | State |
|---|---|---|
| Builtin SQLite driver (node:/bun:, feature-detected) | #207 | ✅ `lib/kernel/sqlite-driver.js` |
| Broker safety proof — atomic events, idempotency, **DB-enforced claim leases**, multi-process contention | #220 | ✅ `broker*.test.js`, `lease-enforcer.js` |
| JSONL portability projection (D16) | #218 | ✅ `projection-jsonl-writer.js` |
| Taxonomy read-model + validation (D18) | #219 | ✅ `taxonomy-validator.js`, `readiness-model.js` |
| Issue command contract (D22) | #212 | ✅ `issue-command-contract.js` |
| `forge prime`/`orient`/`recap` (D21) | #211 | ✅ `lib/commands/{prime,orient,recap}.js` |
| Hermes harness adapter | #217 | ✅ |
| Kernel CLI commands | — | ✅ `lib/commands/`: issue, claim, close, comment, create, ready, show, list, update, board, release, migrate, export |

## Are we done with Beads? **No.**

`forge release check --target 0.1.0` (the readiness gate, `test/release-readiness.test.js`) reports the D20 kill-list still open:

| Group | Call sites | Files |
|---|---:|---:|
| command | 117 | 11 |
| runtime | 343 | 47 |
| docs | 435 | 67 |
| skills | 22 | 9 |
| hooks | 0 | 0 ✅ |

Beads is still load-bearing in `beads-setup.js` (41), `beads-bootstrap.js`, `beads-health-check.js`, `beads-sync-scaffold.js`, setup/sync paths. The kernel runs **in parallel** to Beads; it has not replaced it. Retirement = burning down this list to zero (runtime first), gated by `release-readiness`.

## The flagged gap: no agent/skill surface for the kernel — **confirmed**

`.claude/skills/` is empty and `.claude/commands/` holds only the 7 stage commands. The Beads *plugin* gives agents ~17 skills (`beads:ready`, `beads:show`, `beads:create`, …) + `bd prime` hook. The Forge kernel's CLI commands exist in `lib/commands/` but are **not exposed to agents** as skills/commands. This is the unfinished half of D22 (agent-interface parity).

## Next phase — sequenced PRs

> ⚠️ **SUPERSEDED — do not follow.** This section's PR scheme (and PR-A's `.claude/commands/` + `sync-commands.js` approach) predates the locked no-command-surface decision and the `.skills`-canonical surface. The authoritative, reconciled ordering is in **[canonical-backlog.md](canonical-backlog.md)** (items K0–K13); the surface mechanics are in **[kernel-skill-surface-design.md](kernel-skill-surface-design.md)**. Original text removed to prevent an agent building the wrong surface.
