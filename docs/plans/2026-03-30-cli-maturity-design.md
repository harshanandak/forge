# CLI Maturity — Design Doc

**Feature**: cli-maturity
**Date**: 2026-03-30
**Status**: In Progress
**Epic**: forge-vi7v
**Children**: forge-6w1, forge-ezno, forge-he3s, forge-p01t

---

## Purpose

bin/forge.js is 4,766 lines — a monolith combining CLI dispatch, setup, rollback, utilities, and project detection. PR #106 established a command registry pattern and migrated 5/12 commands. This epic completes the migration: all commands route through the registry, utility functions live in dedicated modules, scripts are safely importable, and bin/forge.js becomes a thin ~300-line bootstrap.

## Success Criteria

1. All 12 commands dispatch through `_registry.js` (zero hard-coded command routing in bin/forge.js)
2. bin/forge.js reduced to ~300 lines (flag parsing + registry load + dispatch)
3. All scripts safely `require()`-able (no module-level `main()` calls without guard)
4. `forge lint` works as a standalone CLI command
5. Zero breaking changes to `forge <command>` user-facing behavior
6. All existing tests pass
7. Clean break architecture: utility functions in `lib/*-utils.js`, commands are thin `{name, description, handler}` wrappers

## Out of Scope

- New CLI commands beyond `lint` (no new features)
- Changing command behavior or output format
- ESM migration (forge-17rw handles that)
- Changes to the registry pattern itself (_registry.js)
- Agent configuration files (.claude/, .cursorrules, etc.)

## Approach Selected: Clean Break Architecture

**Decision**: Separate utility modules from command interfaces (not additive).

```
bin/forge.js                    → ~300 lines: flag parse + registry load + dispatch
lib/commands/<name>.js          → thin: {name, description, handler} + imports from utils
lib/<domain>-utils.js           → business logic, testable independently
scripts/<name>.js               → guarded main(), exports check functions
```

**Why not additive**: Additive creates "god modules" that serve two audiences (registry and internal imports). Clean break enables independent testing, easier future commands, and cleaner forge-p01t extraction.

**Migration path**:
1. Create `lib/<domain>-utils.js` files with extracted functions
2. Update command files to import from utils and export `{name, description, handler}`
3. Update all internal consumers to import from utils (not command files)
4. Remove hard-coded dispatch from bin/forge.js

## Constraints

- Single PR for the full epic (large effort, one cohesive change)
- Backward compat for `forge <cmd>` CLI surface — internal import paths may change
- Must preserve all existing test coverage
- TDD: tests written before each extraction

## Edge Cases (verified by research)

### P0 — Must fix before migration starts
1. **Bogus name exports**: `dev.js` exports `name: 'feature-a'`, `status.js` exports `name: 'Fresh Start'` — registry keys by name, so routing will fail
2. **Incompatible exports**: `recommend.js` and `team.js` export bare functions (`{handleRecommend}`, `{handleTeam}`) — no name/description/handler at all
3. **Unguarded main()**: `branch-protection.js` calls `main()` at line 183 with no `require.main` guard — any `require()` triggers execution + potential `process.exit(1)`

### P1 — Must address during refactoring
4. **Mutable globals**: bin/forge.js has 8 mutable globals (`projectRoot`, `FORCE_MODE`, `VERBOSE_MODE`, `NON_INTERACTIVE`, `SYMLINK_ONLY`, `SYNC_ENABLED`, `PKG_MANAGER`, `actionLog`) — extraction breaks closures. **Mitigation**: `ForgeContext` object passed as parameter
5. **Dual registry**: `forge-cmd.js` has hardcoded 5-command HANDLERS map, independent of auto-discovery registry. **Mitigation**: Migrate forge-cmd.js to use registry or deprecate
6. **process.exit() in lib/**: `team.js` line 33, 20+ calls in bin/forge.js functions that will move to lib/. **Mitigation**: `ExitError` class — library throws, main() catches and exits
7. **Test import paths**: 18 test files destructure named exports from command files — will break when utils extracted. **Mitigation**: Re-export from command files during transition, then update test imports
8. **__dirname resolution**: bin/forge.js uses `path.dirname(__dirname)` for packageDir — changes when code moves to lib/. **Mitigation**: Explicit `PACKAGE_ROOT` constant computed once and passed
9. **Circular reference**: `showRollbackMenu` calls `main()` for "return to menu". **Mitigation**: Callback pattern
10. **Structural tests**: `test/cli/forge.test.js` and `test/commands/team.test.js` check function names in source text — will fail after extraction. **Mitigation**: Update structural tests in same PR

### P2 — Address if encountered
11. **Worktree path resolution**: `team.js` constructs paths relative to `__dirname` — breaks if scripts/ not in worktree
12. **New lint command collision**: `push.js` and `validate.js` have own lint logic — `forge lint` should wrap shared function
13. **Registry silent skip**: Broken modules silently disappear from command map — no user feedback

## Security Analysis (OWASP Top 10)

| Category | Applies? | Risk | Mitigation |
|----------|----------|------|------------|
| A01 Broken Access Control | NO | — | — |
| A02 Cryptographic Failures | NO | — | — |
| A03 Injection | **YES** | 15+ raw `execSync` calls in rollback with `${target}` interpolation | Extract `secureExecFileSync` to shared `lib/shell-utils.js`, adopt in all extracted modules |
| A04 Insecure Design | LOW | Registry auto-loads all .js from hardcoded `lib/commands/` path | Path not user-controllable, acceptable |
| A05 Security Misconfiguration | LOW | Supply-chain file in `lib/commands/` auto-registers | Pre-existing risk, not introduced by refactor |
| A06-A10 | NO | — | — |

## Blast Radius

| Reference | File | Breaks? | Fix |
|-----------|------|---------|-----|
| `bin/forge.js` exports `{getWorkflowCommands, ensureDirWithNote}` | 3 test files | YES | Move to extracted lib/ modules, update imports |
| `bin/forge-cmd.js` hardcodes 5 command requires | forge-cmd.js L13-17 | YES | Migrate to use registry |
| `plan.js`/`validate.js` internal helpers used by tests | 6 test files | YES | Re-export from command files |
| `scripts/branch-protection.js` in lefthook hooks | lefthook.yml | NO | Script path unchanged, only internals change |
| `package.json` bin entry | package.json | NO | bin/forge.js path unchanged |

## Technical Research

### Registry migration (forge-6w1)
- **5 of 7 commands are LOW complexity**: dev, plan, ship, validate, recommend already have `execute*()` orchestrator functions — just wrap in handler
- **2 MEDIUM complexity**: status.js (needs `buildStatusContext` helper), team.js (process.exit → throw)
- **Zero cross-command dependencies** — all 7 are independent
- **Zero test breaks** for additive approach (but clean break needs re-exports)
- Source: `docs/plans/2026-03-30-registry-migration-plan.md`

### Extraction map (forge-p01t)
- **149 functions** in bin/forge.js, categorized into 8 extraction targets
- **5-wave extraction order**: (1) shell/validation/ui utils, (2) file-utils, (3) rollback, (4) setup, (5) slim bootstrap
- **Rollback cleanest**: 17 functions, self-contained, only needs projectRoot + AGENTS
- **Setup monolith**: ~95 functions, ~3400 lines — depends on waves 1-2 extracting its utilities first
- Source: `docs/plans/extraction-map-forge-p01t.md`

### TDD scenarios
- **18 test files** directly import from files being modified
- **Structural tests** (forge.test.js, team.test.js) check source text — must update
- **Registry tests**: 13 existing cases, excellent coverage — new commands auto-tested
- Source: `docs/research/test-inventory-tdd-scenarios.md`

### Risk inventory
- **14 risks identified**: 3 P0, 8 P1, 3 P2
- Source: `docs/plans/refactor-risk-inventory.md`

## Ambiguity Policy

Use 7-dimension rubric scoring per /dev decision gate:
- >= 80% confidence: proceed and document
- < 80% confidence: stop and ask user

## Dependency Chain

```
Wave 1 (parallel):
  forge-6w1  — Migrate 7 remaining commands to registry
  forge-ezno — Guard 2 scripts (branch-protection.js, dep-guard-analyze.js)

Wave 2 (after wave 1, parallel):
  forge-he3s — Create lib/commands/lint.js
  forge-p01t — Extract setup/rollback/utilities from bin/forge.js

forge-p01t depends on both forge-6w1 AND forge-ezno completing first.
forge-he3s depends on forge-6w1 (needs registry pattern established for all commands).
```
