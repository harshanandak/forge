# Design Doc: Fix All 10 Forge Installation Issues

- **Feature**: install-fixes
- **Date**: 2026-03-22
- **Status**: approved
- **Epic**: forge-on7a

## Purpose

Forge's npm package distribution is incomplete — critical scripts, flags, and UX flows are broken or missing. Users who run `bun install forge-workflow && bunx forge setup` don't get a working setup without manual intervention. This PR fixes all 10 reported installation issues in a single unified refactor.

## Success Criteria

1. `bunx forge setup` works end-to-end in both interactive (TTY) and non-interactive (CI/piped) environments
2. `--agents=claude,cursor` selectively installs only specified agents (verified working)
3. `--dry-run` shows a simple list of files that would be created/modified/skipped
4. `--non-interactive` and `CI=true` auto-detection skip all prompts with sensible defaults
5. Lefthook scripts (`commitlint.js`, `branch-protection.js`, `lint.js`, `test.js`) are reachable after `npm install`
6. Multi-dev scripts (`sync-utils.sh`, `file-index.sh`, `conflict-detect.sh`) are reachable after `npm install`
7. Existing `CLAUDE.md` is preserved via smart merge (USER sections kept, FORGE sections updated)
8. `--symlink` flag creates `CLAUDE.md` as a symlink to `AGENTS.md` when requested
9. Husky detected → auto-migration offered: removes `.husky/`, unsets `core.hooksPath`, maps hook scripts to `lefthook.yml`
10. `install.sh` is a thin bootstrapper (~20 lines) that installs the package and delegates to `bunx forge setup`
11. README recommends `bun add -D forge-workflow` (dev dependency)

## Out of Scope

- Rewriting `bin/forge.js` internals beyond what's needed for these 10 fixes
- Adding new agents or modifying agent plugin schemas
- Changing the lefthook.yml hook structure itself
- Beads integration changes
- Workflow stage changes (plan/dev/validate/ship/review/premerge/verify)

## Approach Selected: Unified Refactor (Approach A)

**Deprecate `install.sh` to a thin bootstrapper. Consolidate all logic in `bin/forge.js`.**

Rationale:
- Industry standard: zero of 7 researched tools (Husky, ESLint, Turborepo, Vite, Changesets, Prettier, lint-staged) use a separate bash installer
- Eliminates duplication between `install.sh` (1,056 lines) and `bin/forge.js`
- Single source of truth for all setup logic
- `install.sh` becomes a ~20-line script: detect package manager, install package, call `bunx forge setup $@`

Research: See `docs/plans/2026-03-22-bootstrap-installer-research.md`

## Constraints

- Must not break existing `bunx forge setup` users (no flag renames, no removed defaults)
- `install.sh` must still work as a curl-pipe bootstrap (it just delegates now)
- Smart merge must preserve `<!-- USER:START -->` / `<!-- USER:END -->` sections
- All interactive prompts must have sensible defaults for non-interactive mode
- Husky migration must be opt-in (prompt), never forced
- `--dry-run` must exit 0 without modifying any files

## Edge Cases

1. **CLAUDE.md exists without USER markers**: Treat entire file as user content, append Forge section
2. **CLAUDE.md exists with USER markers but no FORGE markers**: Insert Forge section, preserve user sections
3. **Husky + Lefthook both present**: Warn, offer to remove Husky, don't double-install Lefthook
4. **Husky with custom hooks not mappable to Lefthook**: Warn which hooks couldn't be auto-migrated, list them for manual migration
5. **`--agents` flag with invalid agent name**: Error with list of valid agents, exit 1
6. **`--dry-run` + `--agents`**: Show what the selected agents would produce
7. **No TTY + no `--non-interactive` + no `CI` env**: Default to non-interactive behavior (safe default)
8. **`install.sh` called without bun/npm**: Error with install instructions for bun
9. **Lefthook not installed when setup runs**: Warn clearly, don't create `lefthook.yml` without the binary, suggest `bun add -D lefthook`
10. **Symlink on Windows**: Use junction or warn that symlinks require admin/developer mode

## Ambiguity Policy

7-dimension rubric scoring on spec gaps. >= 80% confidence: proceed and document. < 80%: stop and ask user.

## 10 Issues Mapped to Implementation

| # | Issue | Severity | Fix |
|---|-------|----------|-----|
| 1 | No selective agent install | Medium | Verify `--agents` flag works in `bin/forge.js`, add to `install.sh` bootstrapper passthrough |
| 2 | Lefthook install fails silently | High | Add prerequisite check before creating `lefthook.yml`, clear error message, suggest install command |
| 3 | Hook scripts not distributed | Critical | Verify `scripts/` in `files` array actually works post-publish, add integration test |
| 4 | Prod dependency in docs | Low | Update README: `bun add -D forge-workflow` |
| 5 | CLAUDE.md overwritten | High | Verify `context-merge.js` smart merge works, fix if broken, handle missing USER markers |
| 6 | No symlink option | Low | Add `--symlink` flag to create `CLAUDE.md -> AGENTS.md` symlink |
| 7 | No Husky migration | Medium | Add Husky detection, migration prompt, hook script mapping |
| 8 | Interactive blocks CI | Medium | Add `CI` env detection, `--non-interactive` flag, TTY fallback |
| 9 | No dry-run | Low | Add `--dry-run` flag, collect planned actions, print list, exit 0 |
| 10 | Multi-dev scripts not in package | High | Verify `scripts/` distribution, add package verification test |
