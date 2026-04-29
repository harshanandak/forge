# Upstream Beads CLI Issues

**Date**: 2026-03-22
**Context**: Issues discovered while building Forge's `bunx forge setup` installer, which integrates Beads for git-backed issue tracking. Each bug required a workaround in Forge's `lib/beads-setup.js`.

**Action required**: File these as GitHub issues on the Beads repository with the reproduction steps below.

---

## Issue 1: Empty JSONL causes `bd create` to fail

**Severity**: High — blocks initial setup flow

**Reproduction**:
1. Initialize a git repository
2. Create `.beads/` directory with an empty `issues.jsonl` file (0 bytes)
3. Run `bd create --title="test" --type=task`

**Expected behavior**: Creates the issue successfully. Zero issues is a valid state for a fresh project.

**Actual behavior**: Error: `no valid issues found in JSONL file`

The Beads CLI treats an empty JSONL file as invalid rather than as a file with zero records. An empty file and a missing file are handled identically, but they represent different states — missing means "not initialized", empty means "initialized with no issues yet."

**Forge workaround**: The `preSeedJsonl()` function in `lib/beads-setup.js` writes a minimal valid JSONL entry into `issues.jsonl` before any `bd create` call, ensuring the file is never empty when the CLI reads it.

---

## Issue 2: `bd init` overwrites existing git hooks without asking

**Severity**: High — destroys existing CI/workflow tooling

**Reproduction**:
1. Set up a repository with Lefthook (or Husky) managing `.git/hooks/`
2. Verify hooks exist: `ls .git/hooks/pre-commit .git/hooks/pre-push`
3. Run `bd init`
4. Check `.git/hooks/` again

**Expected behavior**: Beads detects existing hooks and either:
- Chains its hooks with the existing ones (preferred), or
- Asks the user before overwriting, or
- Skips hook installation with a warning

**Actual behavior**: Beads renames existing hooks to `*.old` (e.g., `pre-commit.old`) and installs its own hooks. No prompt, no warning. This silently breaks Lefthook, Husky, or any other hook manager.

**Forge workaround**: The `safeBeadsInit()` function in `lib/beads-setup.js` snapshots all files in `.git/hooks/` before running `bd init`, then restores the original hooks after initialization completes.

---

## Issue 3: `bd init --prefix` flag doesn't persist to config.yaml

**Severity**: Medium — breaks subsequent `bd create` calls

**Reproduction**:
1. Run `bd init --prefix myproject`
2. Inspect `.beads/config.yaml`
3. Run `bd create --title="test" --type=task`

**Expected behavior**: `.beads/config.yaml` contains `issue-prefix: myproject`, and subsequent `bd create` calls use the prefix (e.g., `myproject-1`).

**Actual behavior**: `.beads/config.yaml` does not contain an `issue-prefix` key. The `--prefix` flag appears to be accepted by the CLI parser but is not written to the configuration file. Subsequent `bd create` calls fail or use a default prefix.

**Forge workaround**: The `writeBeadsConfig()` function in `lib/beads-setup.js` writes the `issue-prefix` key directly into `.beads/config.yaml` after `bd init` completes, bypassing the broken `--prefix` flag entirely.

---

## Issue 4: `bd sync` reports "Exported 0 issues" in no-db mode despite issues existing

**Severity**: Low — cosmetic/misleading output only

**Reproduction**:
1. Configure `.beads/config.yaml` with `no-db: true`
2. Create several issues: `bd create --title="issue N" --type=task` (repeat 8 times)
3. Verify issues exist: `bd list` (shows 8 issues)
4. Run `bd sync`

**Expected behavior**: Output reads "Exported 8 issues" (or an equivalent accurate count).

**Actual behavior**: Output reads "Exported 0 issues". The data IS persisted correctly to JSONL — the count in the status message is simply wrong when running in `no-db` mode. This is misleading because it suggests nothing was saved.

**Forge workaround**: None currently. This is a cosmetic issue. Users may be confused by the output, but no data is lost.

---

## Issue 5: Dolt binary files created even with `no-db: true`

**Severity**: Medium — pollutes repository with unwanted binary files

**Reproduction**:
1. Set `no-db: true` in `.beads/config.yaml`
2. Run `bd init`
3. Check for Dolt artifacts: `ls .beads/dolt/` or `find .beads -name "*.idx" -o -name "manifest" -o -name "LOCK"`

**Expected behavior**: With `no-db: true`, no Dolt database directories or files should be created. The entire point of `no-db` mode is to avoid the Dolt dependency.

**Actual behavior**: A `dolt/` directory is created inside `.beads/` containing `LOCK`, `journal.idx`, `manifest`, and other binary files. These files serve no purpose in `no-db` mode and will be picked up by `git add` unless explicitly ignored.

**Forge workaround**: Forge's setup writes a `.beads/.gitignore` file that blocks Dolt-related files and directories from being tracked by git:
```
dolt/
*.idx
LOCK
manifest
```

---

## Summary Table

| # | Issue | Severity | Forge Workaround |
|---|-------|----------|------------------|
| 1 | Empty JSONL fails `bd create` | High | `preSeedJsonl()` |
| 2 | `bd init` overwrites git hooks | High | `safeBeadsInit()` hook snapshot/restore |
| 3 | `--prefix` flag not persisted | Medium | `writeBeadsConfig()` direct write |
| 4 | `bd sync` reports wrong count | Low | None (cosmetic) |
| 5 | Dolt files created in no-db mode | Medium | `.beads/.gitignore` |
