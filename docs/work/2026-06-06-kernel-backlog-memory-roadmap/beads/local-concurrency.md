## Description
Add local multi-agent/worktree concurrency tests for the SQLite WAL broker.

## Scope
- Multiple processes write against one git common-dir Kernel DB.
- Exercise claims, comments, issue updates, dependencies, and stale revision conflicts.
- Validate busy timeout/retry, idempotency keys, and quarantine behavior.

## Acceptance Criteria
- Test fixture reproduces concurrent local writers.
- Duplicate idempotency key does not duplicate writes.
- Stale expected_revision quarantines instead of overwriting.
- Claim leases cannot be simultaneously active for conflicting owners.
