# Tasks: 0.0.16 Upgrade Safety Foundation

## Task 1: Lockfile And Trust Policy (`forge-besw.8`)

TDD red:
- Add tests for trusted local sources, refused untrusted sources, `--allow-untrusted`, lockfile SRI metadata, and audit JSONL entries.
- Add tests for tampered local content causing `forge audit verify` failure.

Implementation:
- Add `lib/forge-lock.js`.
- Add `lib/commands/add.js`.
- Add `lib/commands/audit.js`.
- Keep remote/package sources opt-in only and document unsupported verification.

Done when:
- Targeted lock/add/audit tests pass.
- `forge add` and `forge audit verify` operate through the existing registry.

## Task 2: Upgrade Dry-Run Plan (`forge-besw.11`)

TDD red:
- Add tests proving `forge upgrade --dry-run` reports config state, patch intent state, lock/trust state, non-scope limitations, and planned self-heal candidates without mutation.

Implementation:
- Add `lib/upgrade-safety.js`.
- Add `lib/commands/upgrade.js`.
- Consume runtime graph config lint/diff, patch intent records, and lock verification.

Done when:
- Targeted upgrade dry-run tests pass.
- Dry-run output is deterministic and reviewable.

## Task 3: Safe Self-Heal Flow (`forge-besw.11`)

TDD red:
- Add tests for a recoverable missing `.forge/log.jsonl` path repaired by `forge upgrade --self-heal`.
- Add tests that unrecoverable integrity failures are reported but not repaired.
- Add idempotency test for running self-heal twice.

Implementation:
- Restrict self-heal to metadata scaffolding that does not overwrite user files.
- Refuse rollback/snapshot behavior in this PR.

Done when:
- Targeted self-heal tests pass.
- No rollback snapshot or restore files/commands are introduced.

## Task 4: Docs And Validation

TDD red:
- Add docs consistency coverage if an existing docs test requires it.

Implementation:
- Add docs/reference/upgrade-safety.md.
- Link from docs/INDEX.md if appropriate.
- Run targeted and full validation commands.

Done when:
- Docs explain trust policy, dry-run behavior, self-heal limits, and non-scope.
- Full validation passes before `/ship`.

