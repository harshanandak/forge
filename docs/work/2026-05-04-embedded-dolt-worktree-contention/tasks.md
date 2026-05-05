# Embedded Dolt Worktree Contention Tasks

Issue: `forge-besw.18`
Design: `docs/work/2026-05-04-embedded-dolt-worktree-contention/design.md`

## Task 1 - Baseline Current Beads State

Goal: prove the starting point before changing storage mode.

TDD/check steps:

1. Record current `.beads/metadata.json` mode and active Dolt/server files.
2. Run `forge show forge-besw.18` and one broad issue-list command successfully.
3. Capture issue count or stable representative issue IDs before the switch.
4. Confirm `.beads/backup` JSONL export status is usable, or create a fresh backup if needed.

Done when:

- Baseline issue data is recorded in command output.
- There is a clear rollback source before any metadata edit.

## Task 2 - Prove Embedded Mode Can Read Existing Data

Goal: avoid a metadata-only flip that points at empty data.

TDD/check steps:

1. Create a temporary copy or disposable worktree experiment.
2. Try embedded mode against the current data path.
3. If direct embedded open fails, try the JSONL backup/restore path into embedded storage.
4. Compare post-switch issue count and `forge-besw.18` details to baseline.

Done when:

- Embedded mode can read the same issue data as server mode, or the task stops with a documented blocker.

## Task 3 - Apply Minimal Config Change

Goal: make the repo use embedded mode only after Task 2 proves it is valid.

TDD/check steps:

1. Update `.beads/metadata.json` from `"dolt_mode": "server"` to `"dolt_mode": "embedded"`.
2. Do not delete server-mode files unless the validation proves they are stale and safe to leave untracked or ignore.
3. Run `forge show forge-besw.18` and issue-list checks again.

Done when:

- `.beads/metadata.json` is embedded.
- Existing issues remain visible.

## Task 4 - Document Troubleshooting

Goal: satisfy acceptance criteria without inventing unrelated docs.

TDD/check steps:

1. Add `TROUBLESHOOTING.md` if no repo troubleshooting document exists.
2. Document the trigger symptom: orphan `.beads/dolt-server.lock` / `.beads/dolt-server.pid` files and multi-worktree port contention.
3. Document the selected fix: use embedded mode for local/worktree automation; keep server mode for cross-machine sync workflows where needed.
4. Include rollback guidance from the verified backup/migration path.

Done when:

- Troubleshooting docs explain symptom, cause, fix, validation, and rollback in concise steps.

## Task 5 - Multi-Worktree Validation

Goal: prove the acceptance criterion around concurrent worktrees.

TDD/check steps:

1. From this worktree and another Forge worktree, run read-only `bd` or `forge show` operations close together.
2. Confirm no new port collision, stale lock, or pid contention blocks the operations.
3. Run `git status --short --branch` and verify only intended files changed.
4. Run `bash scripts/beads-context.sh validate forge-besw.18`.

Done when:

- Current worktree validation passes.
- Concurrent worktree read operations succeed without Dolt server port contention.

## Stop Conditions

Stop and report instead of patching if:

- The installed `bd` build cannot actually operate in embedded mode.
- Embedded mode opens an empty issue set.
- JSONL backup/restore cannot preserve `forge-besw.18`.
- Validation requires changing Beads internals beyond this issue's config/docs scope.
