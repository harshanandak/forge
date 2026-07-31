# Tasks

## Task 1 — honest lazy activation defaults

**OWNS:** `lib/activation/ensure-forge-home.js`, `test/activation/ensure-forge-home.test.js`, `test/activation/registry-lazy-init.test.js`, `docs/work/2026-07-31-s0-enforcement-honesty/**`

**What to implement:** Change lazy initialization to create a config that does not weaken Forge's default enforcement posture. Preserve the config-file no-clobber behavior and explicit profile/disable choices. Keep failures safe for the originating command and retryable for a subsequent attempt. Cover helper behavior and the real `executeCommand` lazy-init path used by issue creation/activation.

**TDD steps:**
1. Write regression tests for default enabled enforcement, explicit minimal/existing config preservation, write failure safety, and registry issue-create lazy activation.
2. Run the focused tests and capture the expected RED failure before editing production code.
3. Make the smallest production change using the canonical default adoption configuration and existing safe boundaries.
4. Run focused tests and capture GREEN output.
5. Refactor only if needed without changing behavior.
6. Commit with a descriptive message.

**Expected output:** Focused activation tests pass; lazy issue creation no longer creates gates-disabled config.

## Review gates

- Fresh leaf spec reviewer after implementation; resolve all findings before quality review.
- Fresh leaf code-quality reviewer after spec approval; resolve all findings and re-review.
- No self-review substitution.

## Validation limits

Run only focused activation tests and relevant lint/type checks; do not run the full repository suite and do not repeat identical SHA tests.
