# Decisions and evidence

## 2026-09-24: parallel diagnosis, single ownership

The user explicitly requested multiple Claude agents. Two actual Opus 5.5
read-only jobs inspect separate mechanisms. Each launch has only four
repository-reading tools and no optional MCP integrations; hooks and permission
checks remain enabled. This reuses the successful invocation from the prior
review and avoids its oversized tool-context failure.

Root holds the issue lease as `delivery-reliability-root-20260924`, owns the
new `fix/delivery-runner-reliability` worktree, and preserves the separate
Shepherd commit. No repeated full suite is authorized by the diagnostic plan.
The exact implementation scope depends on the bounded reproduction findings.

## Selected first fix: reuse the issue snapshot in ripple fallback

Claude found duplicated sanitize/show/title work when `cmd_check_ripple` falls
back to `cmd_check_ripple_keyword_v1`. A single implementer owns only
`scripts/dep-guard.sh` and its existing basic ripple test file. The regression
counts backend show calls, making the waste reproducible without a timing
threshold. Preserve existing direct callers and all validation/failure paths.
This removes proven repeated work; it does not establish the cause of every
canonical timing failure. The proposed additional broad diagnostic run is
rejected in favor of this bounded check.

## Focused evidence: incomplete reliability proof

The backend-call regression failed with two calls before the change and passed
with one afterward (1 pass, 0 fail). Strict JS lint and shell syntax passed.
The two-file focused suite was unstable: an after-change run had 6 pass and
2 timeouts; a later run had 8 pass in 56.16 seconds. Preserve both results;
the retry does not establish stable validation or explain the earlier failures.
Raw evidence is in ignored `test-results/dep-guard-ripple-dedupe/`.

The initial baseline copy was invalid and is excluded from performance claims.
A replacement interleaved benchmark has only one observed pair so far; this
is not enough to claim a repeatable wall-clock improvement. Removing a backend
call is proven; total delivery-cycle improvement remains unmeasured.

## Independent review

Separate Claude Opus 5.5 specification and quality reviewers approved the diff
with no blockers. Both verified the two callers pass an already-sanitized id
and nonempty title; the command dispatcher cannot expose the optional title
argument directly. The single call-count regression covers the no-task-file
route; existing sibling tests exercise analyzer fallback without counting its
calls. That additional assertion is optional, not claimed coverage.

Canonical validation is still pending. At 13:47:34-37 UTC, three Windows CIM
samples reported 100 percent CPU and 1.32-1.41 GiB free physical memory. This is
a brief host observation, not proof of the cause of any earlier timeout. No
task-owned fixture process matched the current worktrees in the follow-up
process inventory. Do not stop unrelated processes or retry broad validation
from this result alone.
