# Feature

- Slug: `beads-dolt-upgrade`
- Date: `2026-04-10`
- Status: `planned`
- Issue: `forge-iaae`
- Branch: `feat/beads-dolt-upgrade`

## Purpose

Upgrade Forge's Beads integration from the legacy `v0.49.x` SQLite/JSONL model to the current Dolt-backed model without losing any existing issue history, dependencies, comments, or workflow automation.

This is a prerequisite for Forge v2 because the current repository still embeds `v0.49.1` assumptions in CI, setup helpers, and docs even though upstream Beads is now Dolt-first and the local `bd` binary on this machine already reports `0.62.0 (dev)`.

## Success Criteria

1. A repo-local migration script upgrades a legacy `.beads/` directory to the current Dolt-backed layout and keeps a rollback snapshot.
2. The migration verifies parity for issue IDs plus issue, dependency, and comment counts before declaring success.
3. CI workflows under `.github/workflows/` stop pinning `v0.49.1` and stop depending on direct diffs of `.beads/issues.jsonl`.
4. Forge setup/scaffold code stops requiring or pre-seeding `.beads/issues.jsonl` as an initialization invariant.
5. `docs/TOOLCHAIN.md` documents the current install/init/migration path for Beads latest, including rollback guidance.
6. Post-upgrade smoke coverage proves `bd create`, `bd list`, `bd show`, `bd close`, `bd dep`, and `bd sync` work in the upgraded repo.

## Out Of Scope

- Rewriting archived planning docs, research notes, or historical design documents that mention SQLite/JSONL.
- Updating duplicate docs outside `docs/TOOLCHAIN.md` unless a failing test or direct runtime dependency forces it.
- Replacing Beads with a Forge-owned tracker.
- Designing multi-project Dolt server orchestration beyond what is needed for this repo migration.

## Approach Selected

Use the official JSONL-to-Dolt migration path as the core import mechanism, then wrap it in a repo-specific migration script that adds snapshotting, verification, and rollback safety.

Why this approach:

- Upstream Beads docs explicitly state that legacy SQLite users should migrate via `scripts/migrate-jsonl-to-dolt.sh`.
- Upstream Beads docs also state that `bd migrate --to-dolt` was removed in `v0.58.0`, so we should not build around a deprecated command.
- The upstream migration script already knows how to import `issues`, `labels`, `dependencies`, `events`, `comments`, and `config` JSONL into Dolt in referential order.
- A thin Forge wrapper is safer than inventing a custom SQLite parser because this repo already contains export-style JSONL in `.beads/backup/`.

Planned migration flow:

1. Snapshot the entire existing `.beads/` directory to a timestamped rollback location.
2. Build a normalized migration input directory from the legacy `.beads/backup/*.jsonl` files, with fallback to live `.beads/*.jsonl` files where needed.
3. Initialize the latest Beads/Dolt layout in an isolated target directory or temp worktree.
4. Import data with the official JSONL-to-Dolt flow.
5. Verify parity by comparing exported counts and sampled issue IDs before swapping the migrated state into place.
6. Abort and restore the snapshot on any failed verification step.

## Constraints

- This is a high-risk data migration. No destructive in-place rewrite is allowed before a full snapshot exists.
- The repo must preserve all existing issues, not just open issues.
- CI cannot assume direct access to `.beads/issues.jsonl` after migration.
- The repo currently has mixed-state Beads artifacts: legacy SQLite files, live JSONL files, and Dolt metadata all exist under `.beads/`.
- `/plan` baseline testing is not green today: `bun test` did not finish within a 300s planning timeout, so `/dev` should not start until you explicitly accept that baseline risk or we investigate it.

## Edge Cases

- Missing or stale `.beads/backup/*.jsonl`: the wrapper must fail clearly or rebuild migration inputs from the live repo data before import.
- Partial import success: the wrapper must not leave the repo pointing at a half-migrated database.
- Mixed legacy/current state: the wrapper must prefer one canonical migration source and log which source it used.
- Re-running the migration: the script must be idempotent or fail safely with a clear “already migrated / rollback required” message.
- Workflow reverse sync: closed-issue detection must work even if `.beads/issues.jsonl` is no longer committed as the primary state file.
- Windows path and shell differences: the migration and smoke scripts must avoid fragile POSIX-only assumptions where possible.

## Ambiguity Policy

Use the repo’s `/dev` decision-gate rubric.

- If confidence is `>= 80%`, proceed with the conservative option and document it in `docs/plans/2026-04-10-beads-dolt-upgrade-decisions.md` during implementation.
- If confidence is `< 80%`, stop and ask before changing data flow or storage semantics.

## Technical Research

### Verified Upstream Facts

- Official latest Beads release is `v1.0.0`, published on `2026-04-03`.
- Official Beads README describes Beads as “powered by Dolt” and documents embedded mode as the default storage mode.
- Official Beads `docs/DOLT.md` says:
  - “Migrate from SQLite (Legacy)” should use `scripts/migrate-jsonl-to-dolt.sh`.
  - `bd migrate --to-dolt` was removed in `v0.58.0`.
  - migration creates automatic backups and preserves the original SQLite database.

Primary sources:

- `https://github.com/gastownhall/beads/releases`
- `https://github.com/gastownhall/beads`
- `https://github.com/gastownhall/beads/blob/main/docs/DOLT.md`
- `https://raw.githubusercontent.com/gastownhall/beads/main/scripts/migrate-jsonl-to-dolt.sh`

### Current Repo Findings

Verified local state:

- `bd --version` returns `bd version 0.62.0 (dev)` on this machine.
- `.github/workflows/github-to-beads.yml` still pins `BD_VERSION="0.49.1"` and comments “Initialize SQLite DB from JSONL on fresh checkout”.
- `.github/workflows/beads-to-github.yml` still diffs `.beads/issues.jsonl` directly.
- `docs/TOOLCHAIN.md` still documents a “dual-database architecture” with `issues.jsonl` plus `beads.db`.
- `lib/beads-setup.js` still treats `.beads/issues.jsonl` as a required initialization artifact and pre-seeds it.
- `scripts/github-beads-sync/reverse-sync.mjs` still assumes old/new `.beads/issues.jsonl` snapshots as its input contract.

Observed data volume in the current repo:

- `.beads/issues.jsonl` contains `209` JSONL records.
- `bd list --json --limit=0` returns `64` currently listed issues.

Implication:

Issue preservation must verify the full historical dataset, not only the default `bd list` view.

### Blast Radius Search

In-scope matches that must be accounted for in implementation:

- `.github/workflows/github-to-beads.yml`
- `.github/workflows/beads-to-github.yml`
- `docs/TOOLCHAIN.md`
- `lib/beads-setup.js`
- `lib/beads-sync-scaffold.js`
- `scripts/github-beads-sync/reverse-sync.mjs`
- `scripts/github-beads-sync/reverse-sync-cli.mjs`
- `scripts/sync-utils.sh`
- `scripts/smart-status.sh`
- `test/beads-setup.test.js`
- `test/beads-init-wrapper.test.js`
- `test/beads-sync-detect.test.js`
- `test/beads-sync-scaffold.test.js`
- `test/scripts/github-beads-sync/workflow-validation.test.js`

Noted but intentionally out of scope for this wave:

- Historical docs under `docs/plans/`
- Secondary duplicated docs such as `docs/forge/TOOLCHAIN.md`

## OWASP Top 10 Analysis

### A01 Broken Access Control

Risk: a migration script that reads or overwrites the wrong `.beads/` directory could corrupt unrelated state.

Mitigation:

- Require explicit project-root resolution.
- Refuse to run outside a git root or when `.beads/` is missing.
- Snapshot before mutation.

### A08 Software And Data Integrity Failures

Risk: malformed JSONL or partial imports silently drop issues, comments, or dependencies.

Mitigation:

- Validate every JSONL file before import.
- Verify parity counts and sampled IDs after import.
- Fail closed and restore snapshot on mismatch.

### A09 Security Logging And Monitoring Failures

Risk: migration outcome is unclear and rollback evidence is lost.

Mitigation:

- Emit a machine-readable manifest describing snapshot path, import source, verification counts, and final status.
- Keep rollback metadata inside the snapshot directory.

## TDD Scenarios

1. Legacy fixture with issues, labels, dependencies, comments, and config migrates into Dolt with matching counts and stable issue IDs.
2. Migration failure after import but before verification restores the original `.beads/` snapshot and reports the failure reason.
3. Re-running the migration against an already migrated target is safe and does not duplicate data.
4. CI reverse-sync logic can detect closed issues using exported snapshots instead of directly diffing committed `.beads/issues.jsonl`.
5. Forge setup/scaffold no longer requires `.beads/issues.jsonl` or a fallback pin of `0.49.1`.

## Baseline

- Worktree: `.worktrees/beads-dolt-upgrade`
- Branch: `feat/beads-dolt-upgrade`
- Issue status: `in_progress`
- Baseline test run: `bun test` attempted twice and did not complete within the planning timeout window (`300s`)
