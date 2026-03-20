# Design: P2 Bug Fixes — Setup, Postinstall, Dead Config, Git Hooks

**Feature**: p2-bug-fixes
**Date**: 2026-03-20
**Status**: In Progress (Phase 2 complete)
**Branch**: feat/p2-bug-fixes
**Beads**: forge-cpnj, forge-iv1p, forge-8u6q, forge-zs2u

---

## Purpose

Fix 4 bugs across bin/forge.js, lefthook hooks, and package.json that cause setup divergence, surprising postinstall side effects, dead config noise, and lint version drift.

---

## Bugs Covered

### 1. forge-cpnj: Setup code paths diverge
**Problem**: `handleSetupCommand` (CLI flags path) skips `setupAgent('claude')` when claude is in the selected agents list (line 3734: `if (agentKey !== 'claude')`). Uses `loadClaudeCommands` which only reads from disk, while interactive path uses `loadAndSetupClaudeCommands` which seeds `.claude/commands/` first. Result: CLI and interactive flows produce different files.

**Fix**: Extract a shared setup helper. Both `handleSetupCommand` and interactive path normalize inputs to a config object, then call one `executeSetup(config)` function. The helper: (1) seeds .claude/commands if claude selected, (2) calls setupAgent for each selected agent. Pattern: normalize-to-config-then-execute (same as create-next-app, Nx).

### 2. forge-iv1p: Postinstall removal + first-run detection
**Problem**: `postinstall` in package.json runs `minimalInstall()` which writes multiple files (AGENTS.md, docs/) and prints banner on every `npm install`. Surprising for users, noisy in CI, recreates deleted files.

**Fix (UPDATED — was Option E, now full removal)**:
- **Remove postinstall from package.json entirely** — one line deleted
- **Add first-run detection**: when any forge command runs and project isn't set up (no AGENTS.md), print clear setup guidance and exit
- **Add `--auto` flag** to `npx forge setup` for non-interactive use by AI agents
- `minimalInstall()` stays as internal logic, refactored to back `setup --auto`

**Why changed from Option E**: Phase 2 research revealed:
- pnpm 10+ and Bun block postinstall by default — Option E wouldn't run
- OWASP 2025 A03 explicitly flags postinstall as supply chain attack vector
- No major CLI tool (Next.js, Vite, Astro, Biome) uses postinstall for file creation
- Removing postinstall is simpler AND more compatible

### 3. forge-8u6q: Dead config creates false expectations
**Problem**: `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` defined at bin/forge.js:275/295 but never wired to any behavior. Users see prompts for tools that do nothing.

**Fix**: Remove dead config objects entirely (YAGNI). Zero references in codebase besides definitions — confirmed by blast radius search.

### 4. forge-zs2u: Lefthook lint version drift
**Problem**: `scripts/lint.js` (pre-push hook) runs `npx --yes eslint .` which can fetch a different ESLint version from the network. `bun run lint` uses the locally installed eslint. Versions can diverge.

**Fix (UPDATED)**: Change `scripts/lint.js` to detect package manager and run `<pkg> run lint` — delegates to package.json scripts (single source of truth). Reuses the detection pattern from existing `scripts/test.js`. Eliminates `npx --yes` which is a documented security vulnerability (128 unclaimed package names, auto-exec without confirmation).

---

## Success Criteria

1. `forge setup --agents claude,cursor` and interactive setup produce identical file sets
2. `npm install forge-workflow` produces zero output and zero file writes (no postinstall)
3. Running any forge command without setup prints clear guidance message
4. `npx forge setup --auto` works non-interactively for AI agents
5. `_CODE_REVIEW_TOOLS` and `_CODE_QUALITY_TOOLS` removed — no references in codebase
6. `scripts/lint.js` uses detected package manager (`<pkg> run lint`), not npx
7. Pre-push lint and `bun run lint` use the same eslint binary and config
8. All existing tests pass
9. No `npx --yes` references remain in codebase

---

## Out of Scope

- Neutral canonical command source (tracked: forge-ny6j, P4)
- Forge uninstall/reinstall commands (tracked: forge-npza, P2)
- Global AGENTS.md for desktop agents
- Agent-agnostic project memory (tracked: forge-xdh7, P3)
- Workflow stage tracking gap (tracked: forge-mwxb, P2)
- Cross-platform validate.js alternative (covered by forge-twiw / PR #68)
- Auto-detect current AI agent from env signals (tracked: forge-15dj, P2)
- Incremental agent setup without overwriting (tracked: forge-fya1, P2)
- Lazy directory creation on first use (tracked: forge-oxcl, P3)
- Remove docs/WORKFLOW.md duplication (tracked: forge-4nty, P3)
- Clean setup summary output (tracked: forge-xq5b, P3)

---

## Approach Selected

- **forge-cpnj**: Normalize-to-config pattern. Both `handleSetupCommand` and interactive path produce a config object (`{ agents, flags, skipExternal }`). One `executeSetup(config)` function runs. Uses existing guarded `writeFile`/`ensureDir` helpers (lines 505-539) with `startsWith(resolvedProjectRoot)` traversal protection.
- **forge-iv1p**: Remove `"postinstall"` line from package.json. Add first-run detection in CLI entry point — check for AGENTS.md, print guidance if missing. Add `--auto` flag to setup command.
- **forge-8u6q**: Delete `_CODE_REVIEW_TOOLS` (line 275) and `_CODE_QUALITY_TOOLS` (line 295) objects from bin/forge.js. Remove any prompts referencing them.
- **forge-zs2u**: Rewrite `scripts/lint.js` to detect package manager (reuse pattern from `scripts/test.js`) and run `<pkg> run lint`. Fail with clear error if eslint not installed.

---

## Constraints

- bin/forge.js is ~3800 lines — changes must be surgical, not a refactor
- Pre-push hooks must work on Windows (CMD, PowerShell) and Unix
- No hook bypasses (LEFTHOOK=0, --no-verify) allowed for testing
- Must use existing guarded file helpers (writeFile/ensureDir) — not raw fs

---

## Edge Cases

1. **User runs forge command without setup**: first-run detection prints guidance, exits cleanly
2. **AI agent runs forge command without setup**: sees guidance message, runs `npx forge setup --auto`
3. **No node_modules/.bin/eslint** (or no local eslint): lint.js fails with clear error suggesting `bun install`
4. **User runs `forge setup --agents cursor` (no claude)**: shared helper skips claude seeding, only sets up cursor
5. **Existing project with customized AGENTS.md**: setup never overwrites existing files
6. **pnpm/Bun users**: postinstall removal means they get the same experience as npm users
7. **Offline push**: lint.js no longer needs network (was downloading via npx --yes)

---

## Technical Research (Phase 2)

### Sources
- OWASP Top 10:2025 A03 — Supply Chain Failures (postinstall attack vector)
- Aikido Research — 128 unclaimed npx package names (npx --yes vulnerability)
- npm CLI issue #2226 — npx --yes breaking change
- pnpm 10 — blocks lifecycle scripts by default
- ci-info — 40+ CI vendor detection
- create-next-app — normalize-to-config pattern
- Lefthook docs — recommends npm run lint delegation

### OWASP Analysis

| Change | Risk | OWASP Categories | Mitigation |
|--------|------|------------------|------------|
| forge-cpnj | LOW | A01 (Broken Access Control) — path traversal | Use existing guarded writeFile/ensureDir with startsWith checks |
| forge-iv1p | LOW (improved) | A08 (Software Integrity), A03 (Supply Chain) | Removing postinstall is a net security improvement |
| forge-8u6q | NEGLIGIBLE | None | Pure deletion |
| forge-zs2u | LOW (improved) | A03 (Supply Chain), A08 (Integrity) | Removing npx --yes eliminates auto-download attack vector |

### Key Research Decisions

1. **Postinstall removal over Option E**: pnpm/Bun block postinstall by default. First-run detection is more reliable across all package managers.
2. **`<pkg> run lint` over `node_modules/.bin/eslint`**: Delegates to package.json (single source of truth). scripts/test.js already has the detection pattern.
3. **Normalize-to-config over shared function**: Prevents future drift — both paths must produce the same config object format, making divergence structurally impossible.

---

## Ambiguity Policy

Use 7-dimension rubric scoring. If aggregate confidence >= 80% of max score, proceed and document the decision in the commit message. If < 80%, pause and ask for input. Applies project-wide (see memory: feedback_ambiguity_policy.md).
