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

## Edge Cases (identified, research will expand)

1. **Circular dependencies**: Utility modules extracted from bin/forge.js may cross-reference each other
2. **Setup flow**: Interactive prompts in setup depend on many utility functions — extraction order matters
3. **process.exit() calls**: Scripts and bin/forge.js use process.exit() — must be preserved at entry points but removed from library code
4. **Worktree compatibility**: forge commands run in worktrees — path resolution must work from both main repo and worktrees
5. **Registry load failures**: If a command module fails to load, registry must fail gracefully (not crash CLI)
6. **Flag parsing coupling**: parseFlags in bin/forge.js may be tightly coupled to command-specific logic

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
