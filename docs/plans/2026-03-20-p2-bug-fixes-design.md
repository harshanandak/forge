# Design: P2 Bug Fixes — Setup, Postinstall, Dead Config, Git Hooks

**Feature**: p2-bug-fixes
**Date**: 2026-03-20
**Status**: In Progress
**Branch**: feat/p2-bug-fixes
**Beads**: forge-cpnj, forge-iv1p, forge-8u6q, forge-zs2u

---

## Purpose

Fix 4 bugs across bin/forge.js, lefthook hooks, and package.json that cause setup divergence, surprising postinstall side effects, dead config noise, and lint version drift.

---

## Bugs Covered

### 1. forge-cpnj: Setup code paths diverge
**Problem**: `handleSetupCommand` (CLI flags path) skips `setupAgent('claude')` when claude is in the selected agents list. Uses `loadClaudeCommands` which only reads from disk, while interactive path uses `loadAndSetupClaudeCommands` which seeds `.claude/commands/` first. Result: CLI and interactive flows produce different files.

**Fix**: Extract a shared helper used by both paths. Always seed `.claude/commands/` when needed, then fan out to other agents.

### 2. forge-iv1p: Postinstall side effects
**Problem**: `postinstall` in package.json runs `minimalInstall()` which writes multiple files (AGENTS.md, docs) and prints banner on every `npm install`. Surprising for users, noisy in CI, recreates deleted files.

**Fix (Option E)**: Postinstall seeds only AGENTS.md (the bootstrap file that makes AI agents aware of Forge). Skip entirely in CI (`CI=true`). No-op if AGENTS.md already exists. Print one-line setup guidance. Full setup via explicit `npx forge setup`.

### 3. forge-8u6q: Dead config creates false expectations
**Problem**: `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` defined at bin/forge.js:275/295 but never wired to any behavior. Users see prompts for tools that do nothing.

**Fix**: Remove dead config objects entirely (YAGNI). Re-add when the feature is actually built.

### 4. forge-zs2u: Lefthook lint version drift
**Problem**: `scripts/lint.js` (pre-push hook) runs `npx --yes eslint .` which can fetch a different ESLint version from the network. `bun run lint` uses the locally installed eslint. Versions can diverge.

**Fix**: Change `scripts/lint.js` to use `node_modules/.bin/eslint` directly instead of `npx --yes`. No network dependency, always uses project-installed version.

---

## Success Criteria

1. `forge setup --agents claude,cursor` and interactive setup produce identical file sets
2. `npm install forge-workflow` in CI (`CI=true`) produces zero output and zero file writes
3. `npm install forge-workflow` in fresh project creates only AGENTS.md + prints setup guidance
4. `npm install forge-workflow` in existing project (AGENTS.md exists) is silent no-op
5. `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` removed — no references in codebase
6. `scripts/lint.js` uses local eslint, not npx
7. Pre-push lint and `bun run lint` use the same eslint binary
8. All existing tests pass

---

## Out of Scope

- Neutral canonical command source (tracked: forge-ny6j, P4)
- Forge uninstall/reinstall commands (tracked: forge-npza, P2)
- Global AGENTS.md for desktop agents
- Agent-agnostic project memory (tracked: forge-xdh7, P3)
- Workflow stage tracking gap (tracked: forge-mwxb, P2)
- Cross-platform validate.js alternative (covered by forge-twiw / PR #68)

---

## Approach Selected

- **forge-cpnj**: Extract `setupAllAgents(selectedAgents)` shared helper. Both `handleSetupCommand` and interactive path call it. Helper: (1) seeds .claude/commands if claude selected, (2) calls setupAgent for each agent.
- **forge-iv1p**: Rewrite `minimalInstall()` to: check CI env var → check AGENTS.md exists → if fresh, copy only AGENTS.md + print guidance → else silent.
- **forge-8u6q**: Delete `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` objects. Grep for any references and remove.
- **forge-zs2u**: Replace `npx --yes eslint` with `./node_modules/.bin/eslint` in scripts/lint.js, with Windows .cmd detection.

---

## Constraints

- bin/forge.js is ~3800 lines — changes must be surgical, not a refactor
- Pre-push hooks must work on Windows (CMD, PowerShell) and Unix
- Postinstall must work with npm, bun, pnpm, yarn
- No hook bypasses (LEFTHOOK=0, --no-verify) allowed for testing

---

## Edge Cases

1. **User has AGENTS.md but no .claude/**: postinstall skips (AGENTS.md exists). Setup would create .claude/ on explicit `npx forge setup`.
2. **CI without CI=true env var**: Some CI systems don't set it. We also check for common CI vars (GITHUB_ACTIONS, JENKINS, GITLAB_CI, etc.)
3. **No node_modules/.bin/eslint**: lint.js should fail with clear error message, not silent pass.
4. **User runs `forge setup --agents cursor` (no claude)**: shared helper should still work — skip claude seeding, only set up cursor.
5. **Existing project with customized AGENTS.md**: postinstall never overwrites.

---

## Ambiguity Policy

Use 7-dimension rubric scoring. If aggregate confidence >= 80% of max score, proceed and document the decision in the commit message. If < 80%, pause and ask for input.
