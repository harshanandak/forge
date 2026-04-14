## Feature

- **Slug:** `wave1-worktree-beads-fixes`
- **Date:** `2026-04-13`
- **Status:** `implementation complete - ready for validation`

## Purpose

Wave 1 needs to remove three blockers to safe parallel development in worktrees:

1. External worktrees can miss usable Beads state because only `forge worktree create` wires `.beads`.
2. Worktrees can miss `lefthook`, which removes pre-push quality gates for raw `git push`.
3. Beads auto-recovery still infers recovery state from the directory basename instead of the configured metadata.

The goal is to harden the existing internal bootstrap and recovery logic without creating a new Beads wrapper layer and without touching the Forge CLI registry surface.

## Verified Current State

- `lib/commands/worktree.js:118-149` still owns a local `setupBeads()` helper that links or copies `.beads`, but it only runs during `forge worktree create`.
- `lib/commands/worktree.js:158-162` already runs package-manager install inside the created worktree, so the missing-`lefthook` gap is not just the happy-path create flow.
- `lib/commands/setup.js:2843-2908` calls `safeBeadsInit()` and restores `lefthook`, but the path is setup-oriented and not a general worktree bootstrap path.
- `lib/beads-setup.js:272-340` preserves hooks and writes config for `bd init`, but it does not currently provide metadata-driven recovery helpers.
- `lib/beads-health-check.js:63-140` is only a smoke test today; it does not attempt Beads recovery.
- `scripts/smart-status.sh:129-156` auto-recovers from `database not found`, but it derives the recovery prefix from the repo basename.
- The actual repo metadata file at `.beads/metadata.json` contains:
  - `database: "dolt"`
  - `backend: "dolt"`
  - `dolt_mode: "server"`
  - `dolt_database: "forge"`

## Success Criteria

1. A worktree created outside Forge can be repaired by Forge-owned bootstrap/recovery logic without manual `.beads` surgery.
2. Worktree bootstrap prefers shared live Beads state, falls back to backup restore when necessary, and only fresh-inits as a last resort with an explicit warning.
3. Recovery logic reads the configured database identity from `.beads/metadata.json` and stops depending on the worktree directory basename.
4. Forge-owned repair/setup paths detect a declared-but-missing `lefthook` binary in worktrees and restore quality gates or emit a hard, actionable warning.
5. The change set stays internal:
  - no new Beads wrapper/API surface
  - no edits to `bin/forge.js`
  - no edits to `lib/commands/_registry.js`
6. The three fixes land as separate commits on one feature branch.

## Out Of Scope

- Building or reshaping the parallel Beads wrapper layer tracked in `forge-f3lx`
- Changing upstream `bd` command behavior directly
- Introducing new top-level Forge commands
- Shared Dolt launcher work from the larger WS3 track
- Broad setup refactors unrelated to worktree/bootstrap/recovery behavior

## Approach Selected

Use one new internal helper module and three sequential fix tasks.

### 1. External worktree bootstrap

Add `lib/beads-bootstrap.js` as an internal helper, not a wrapper abstraction. It should centralize Forge-owned recovery decisions for missing or broken `.beads` state in a worktree:

1. Detect whether the current directory is a worktree lacking usable Beads state.
2. Prefer redirect/symlink/junction to the main repo `.beads`.
3. Fall back to restoring from backup if the shared link path is not viable.
4. Fresh-init only as a last resort, and return a warning instead of silently masking the failure mode.

The first consumers should be the existing worktree/bootstrap code and the existing health/recovery flow, not any new public command surface.

### 2. Worktree-local `lefthook` recovery

Treat missing `lefthook` in a worktree as a safety failure, not cosmetic drift. The setup/health path should:

- detect when the project declares `lefthook` but the worktree-local binary is missing
- repair the binary using the worktree-local package-manager context when possible
- preserve existing hook snapshot/restore semantics
- emit a clear warning when repair cannot be completed automatically

This keeps raw `git push` in worktrees behind the same quality-gate assumptions as the main checkout.

### 3. Metadata-driven auto-recovery

Replace basename-driven inference with metadata-driven recovery. The verified metadata source in this repo is `.beads/metadata.json`, and the recovery logic should prefer `dolt_database` when present. If metadata is missing or malformed, fallback order should be explicit and conservative rather than implicit basename guessing.

For Wave 1, this includes the existing shell recovery path in `scripts/smart-status.sh` because that is a real current caller of the bad inference logic.

## Constraints

- Do not create a new Beads wrapper abstraction layer.
- Do not modify `bin/forge.js` or `lib/commands/_registry.js`.
- Keep new code internal and testable with dependency injection where the surrounding modules already use DI.
- Preserve existing user-facing command names and return-shape expectations.
- Prefer minimal cross-file overlap with the parallel wrapper track.
- Separate commits by bug/fix:
  - `forge-epkw`
  - `forge-ujq.2`
  - `forge-9ats`

## Edge Cases

- External worktree has no `.beads` directory at all.
- Worktree `.beads` exists but points at stale or unreadable state.
- Windows symlink/junction creation fails with `EPERM`.
- Main repo `.beads/backup` is missing, empty, or restore fails.
- `.beads/metadata.json` exists but is malformed JSON.
- `.beads/metadata.json` exists without `dolt_database`.
- Worktree has `package.json` with `lefthook` declared but no local binary.
- Worktree has no detectable package manager, so `lefthook` cannot be auto-restored.
- Repair succeeds for Beads but should not clobber existing git hooks.

## OWASP Notes

- **A01 Broken Access Control:** not directly in scope; no privilege or auth boundary changes.
- **A03 Injection:** relevant because recovery code shells out to `bd`, package managers, and shell scripts. Keep commands argumentized and avoid interpolating metadata into unquoted shell fragments.
- **A05 Security Misconfiguration:** relevant because missing `lefthook` removes enforcement. Treat missing worktree hooks as a configuration failure and surface it explicitly.
- **A09 Security Logging and Monitoring Failures:** relevant for silent bootstrap fallback. Recovery helpers should return structured warnings so failures are visible in tests and CLI output.

## Baseline Before Implementation

Verified from the isolated worktree `C:\Users\harsha_befach\Downloads\forge\.worktrees\wave1-worktree-beads-fixes`:

- `bun test test/beads-setup.test.js` — passed
- `bun test test/beads-init-wrapper.test.js` — passed
- `bun test test/beads-health-check.test.js` — passed
- `bun test test/scripts/smart-status.test.js` — passed

## Ambiguity Policy

Use the `/dev` decision-gate rule:

- `>= 80%` confidence: proceed conservatively and document the decision
- `< 80%` confidence: stop and ask before implementing

Current clarifications resolved in-session:

- `forge-9ats` remains in scope for this branch, including `scripts/smart-status.sh`.
