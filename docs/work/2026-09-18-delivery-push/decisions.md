# Delivery push decisions

## Decision 1

**Date**: 2026-09-18
**Task**: Task 3 — Recover push-runner parity without losing newer receipt work
**Gap**: The approved task assumed `scripts/test.js` exposes an explicit full selector, but its CLI only distinguishes `--validate` from the default diff-selected pre-push plan.
**Score**: 0 / 14
**Route**: PROCEED
**Choice made**: Reuse the existing `node scripts/test-full-suite.js` supervised full-runner route already used by `validate`. It inherits the checkout cwd/environment, returns nonzero for FAIL or INCOMPLETE aggregates, and leaves full-receipt creation exclusively with `validate`.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-09-19
**Task**: Invocation proof lifetime and revocation
**Gap**: A shared marker cannot compare-and-delete atomically if another push replaces it between the read and unlink operations.
**Score**: 5 / 14
**Route**: BLOCKED — resolved by the spec owner
**Choice made**: Store one signed proof per nonce under worktree-private Git metadata. The Git child receives only its nonce, each push deletes only its own file, and exact process identity invalidates crash residue without a lock or registry.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-09-19
**Task**: Existing unparameterized hook predicates
**Gap**: `lefthook.yml` is protected and has no sanctioned active-root-config writer in scope.
**Score**: 2 / 14
**Route**: PROCEED after spec-owner review
**Choice made**: Leave all three hook calls unchanged. A full proof signs exactly branch protection, lint, and tests; a quick proof signs exactly branch protection and lint and also requires the existing quick child lane. Any other shape runs ordinary hooks.
**Status**: RESOLVED

## Decision 4

**Date**: 2026-09-20
**Task**: Preserve Git argument ownership across the push delimiter
**Gap**: The refreshed handler removed every argument before the first `--`, and the global flag parser still reported a literal `--quick` after that delimiter as a Forge flag.
**Score**: 0 / 14
**Route**: PROCEED after root quality review
**Choice made**: Consume only the first delimiter in place. Preserve the relative order of arguments on both sides, recognize and remove Forge's `--quick` or `-q` only before the boundary, and leave every post-boundary argument Git-owned. Calls without a delimiter retain the existing parsed-flag behavior.
**Status**: RESOLVED

**RED**: The two injected handler cases failed as expected: `origin` disappeared from `['origin', '--', 'feat/slug']`, and post-boundary `--quick` incorrectly produced `quickMode: true` (0 passed, 2 failed, 606 ms).
**GREEN**: `bun test --timeout 15000 test/commands/push.test.js` passed 55 tests, failed 0, with 125 expectations in 736 ms.

## Refresh and focused validation evidence

**Date**: 2026-09-20
**Base**: Rebased the two reviewed delivery-push commits onto healthy merge `460dc14b`. The only manual conflict was `CHANGELOG.md`; all upstream reliability entries and both delivery-push entries were retained. The automatic `test/validation-receipt.test.js` merge retains the failed-full-suite stale-receipt negative alongside the push-proof state, mutation, and receipt-separation negatives.
**Focused result**: `bun test --timeout 15000 test/commands/push.test.js test/validation-receipt.test.js test/check-forge-token.test.js test/commands/github-indirect-routes.test.js test/pr-monitor/auto-trigger-wiring.test.js test/push-backing-issue.test.js` passed 112 tests, failed 0, with 392 expectations in 18.77 seconds.
**Publication baseline**: The prior normal push at `ada0c8ee` explicitly reused its validation receipt but still launched the pre-push test runner, reran 371 tests, and took 110,543 ms. Final publication acceptance requires an exact valid receipt, signed hook acceptance, and zero duplicate hook tests without quick mode, retries, timeout changes, or hook bypass.

## Decision 5

**Date**: 2026-09-20
**Task**: PR review corrections for push execution and quality findings
**Gap**: A synchronous full-suite timeout killed only its direct supervisor; a detached descendant could survive after `forge push` returned. Sonar also reported handler/test-runner complexity, a default parameter before a required parameter, a nested receipt-identity ternary, and an oversized parameter list. CodeRabbit found the quick-lane literals duplicated in receipt verification.
**Score**: 0 / 14
**Route**: PROCEED within the existing delivery-push issue
**Choice made**: Reuse the existing asynchronous `runCommand` and process-tree manifest for both Forge and consumer test commands. Each push test run gets a fresh token and manifest detached from inherited process-tree markers; `allInstances` is therefore limited to that run while still reaching nested shards. Adapt synchronous unit-test fakes at the spawn boundary so production and tests use the same execution path. Preserve gate order, consumer command, delimiter semantics, proof creation, and per-nonce revocation. Reuse the exported quick-lane constants in receipt verification and extract only the cohesive argument, authorization, supervised-runner, and Git-push boundaries required by the reported quality rules.
**Status**: RESOLVED IN SOURCE; COMPILED VERIFICATION PENDING

**RED**: The same real fixture under the old synchronous timeout registered a detached descendant, then failed the expected-dead assertion because the supervisor exited while the descendant remained alive (0 passed, 1 failed, 6 expectations, 9.23 seconds). The fixture's `finally` cleanup targeted only its registered test processes.
**GREEN**: The isolated asynchronous path passed the named regression in 3.53 seconds: supervisor and detached descendant were gone, while a live process registered in the inherited outer manifest remained alive. Intermediate focused evidence before async mock unification and the fixture-finally correction: `bun test --timeout 15000 test/commands/push.test.js test/validation-receipt.test.js` passed 64 tests with 166 expectations in 31.57 seconds. Focused standard ESLint passed for all five source/test files, and the Sonar preflight reported zero findings for `lib/commands/push.js` after confirming both changed functions are within the complexity limit. A current affected-file runtime recheck is pending host capacity.

**Current focused result**: After async mock unification and fixture-finally cleanup, `bun test --timeout 15000 test/commands/push.test.js test/embedded-assets-drift.test.js test/validation-receipt.test.js test/check-forge-token.test.js test/scripts/test-runner.test.js` passed 147 tests with 854 expectations and 0 failures in 35.32 seconds. The real timeout regression passed in 2.605 seconds. The run started at 100% host CPU with 3.42 GB free RAM, so its elapsed time is correctness evidence only. Focused ESLint passed the seven changed JavaScript files with zero errors or warnings from project rules.

## Decision 6

**Date**: 2026-09-20
**Task**: Restore compiled push-proof parity
**Gap**: The compiled command graph imported JavaScript source paths both as embedded raw files and executable modules. The collision made `scripts/check-forge-token.js`, `scripts/test.js`, and `scripts/process-tree.js` strings in the static graph instead of their executable APIs, while a separate disk-loaded probe exposed the expected module shapes. A nonce-only correction would still leave the static proof and process-tree APIs unusable. This is tracked by compiled-parity issue `04d63900`.
**Score**: 0 / 14
**Route**: PROCEED under the existing delivery-push and compiled-parity issues
**Choice made**: Keep source modules and public hook behavior unchanged. The embedded-asset generator copies every raw asset byte-for-byte to deterministic generator-owned `.asset` paths, then imports those staged paths while retaining the original source paths as the runtime map keys and fingerprint inputs. This separates raw-file identity from executable-module identity for every embedded script, rather than moving one API and leaving the other collisions intact. The staging directory is guarded to the exact repository-owned location, removed on each generation, and ignored by Git. Both the staging directory and its generated manifest are excluded from the npm package allowlist so a source package never contains a dangling manifest.
**Status**: RESOLVED AND COMPILED-VERIFIED

**Source evidence**: Generation produced 186 staged assets and 186 staged imports. All 186 staged files matched their source bytes, and the manifest contained zero raw imports from original source paths. `npm pack --dry-run --json --ignore-scripts` listed 665 package files with zero staged assets and zero generated-manifest entries.

**Compiled evidence**: The compiled module/raw-asset coexistence smoke generated and compiled successfully with 186 staged files/imports and zero original-path raw imports. Its executable returned true for raw-asset presence and byte identity; callable proof write/verify/consume, timeout, runner, and process-tree APIs; a valid signed proof before consumption; and proof removal plus invalidity after consumption. The actual compiled CLI listed `push`, emitted no static-manifest fallback, did not skip the command, and wrote zero stderr bytes. `bun scripts/parity-check.mjs` passed in 14.152 seconds with all 356 npm files byte-identical to all 356 binary files. This smoke used injected state and local proof files; it did not perform a remote push.

## Decision 7

**Date**: 2026-09-20
**Task**: Restore external push-handler fixture parity after async execution unification
**Gap**: The canonical run at `266f8e47518d6060522e0e10b35b3c681160fcb9` exposed one stale full-mode fixture. `test/pr-monitor/auto-trigger-wiring.test.js` injected only the former synchronous spawn seam, so the handler used its real asynchronous child boundary and the synthetic checkout failed before the successful-push trigger assertion. The earlier six-file refresh included this test before the async correction; the final five-file correction check omitted it.
**Score**: 0 / 14
**Route**: PROCEED within the existing delivery-push review correction
**Choice made**: Keep the single asynchronous production path. Update the external fixture to provide a successful EventEmitter child and isolated process-tree seam, while retaining full-mode execution, no receipt reuse, and the exact success and singleton-trigger assertions. Explicit proof-state fakes keep the fixture independent of native Git metadata. The other direct external handler callers use quick mode and do not enter the asynchronous test boundary, but remain in the expanded focused regression set.
**Status**: RESOLVED IN FIXTURE; CANONICAL RECHECK PENDING

**Canonical RED**: `node bin/forge.js validate` exited 1 after 771,201 ms. The retained root-attribute aggregate contains 31 reports, 8,774 tests, 8,740 passes, 1 failure, 0 errors, and 33 skips. The only failure was `automatic singleton trigger wiring > successful push triggers once` in `local-full-shard-5.xml`: expected `true`, received `false`, in 1.0756 seconds. The run used the changed-files-only JUnit retainer; elapsed time remains observational because the host workload and instrumentation differ from prior runs.

**Focused GREEN**: `bun test --timeout 15000 test/commands/push.test.js test/embedded-assets-drift.test.js test/validation-receipt.test.js test/check-forge-token.test.js test/scripts/test-runner.test.js test/pr-monitor/auto-trigger-wiring.test.js test/commands/github-indirect-routes.test.js test/push-backing-issue.test.js` passed 187 tests with 1,062 expectations and 0 failures in 15.54 seconds. The corrected `successful push triggers once` case passed in 0.60 ms through the asynchronous spawn seam.

## Decision 8

**Date**: 2026-09-20
**Task**: Make signed push authorization portable across the issuer and hook runtimes
**Gap**: Push proofs reused the validation receipt's runtime-strict state comparison. A proof issued by Forge under Bun therefore failed the unchanged Node hook checker even when its repository state, test-runtime identity, runner, gates, owner, and signature still matched.
**Score**: 0 / 14
**Route**: PROCEED within the existing signed-proof issue
**Choice made**: Exclude only the issuing runtime from push-proof state. Keep validation receipts runtime-strict, and keep push proofs bound to a clean worktree, exact HEAD, resolved Bun and Node test runtimes, runner identity, symbolic branch, gate set, live owner, and HMAC signature.
**Status**: RESOLVED IN SOURCE; CANONICAL RECHECK PENDING

**RED**: The real Bun issuer wrote a signed full proof without a runtime-identity seam, then the unchanged Node `scripts/check-forge-token.js` exited 1 for that proof (0 passed, 1 failed in 2.08 seconds).
**GREEN**: The same named regression passed after the push-only state correction (1 passed in 3.38 seconds). The three-file focused run passed 78 tests with 206 expectations and 0 failures in 18.18 seconds; it retained strict validation-receipt runtime rejection and push-proof rejection for changed HEAD, test runtime, runner, tracked or untracked state, branch, worktree, gates, signature, and owner identity.
**Compiled boundary**: An independent disposable compiled issuer captured a real clean Git state, wrote the proof, and invoked the unchanged Node checker while its owner process remained live. Compilation exited 0 in 586 ms; execution exited 0 in 2.393 seconds with Node status 0 and no spawn error, then consumed the proof. The reviewer made no repository edits.

## Decision 9

**Date**: 2026-09-20
**Task**: Fail closed when push test supervision cannot publish its manifest
**Gap**: The isolated process tree deliberately degrades to inert ownership methods when its initial manifest cannot be written, but push still spawned the test supervisor. A timeout could then kill only that supervisor and leave detached shards alive; installed signal handlers could also suppress default termination while waiting for an unsupervised child.
**Score**: 0 / 14
**Route**: PROCEED within the existing push-runner issue
**Choice made**: Resolve the isolated child environment before installing signal handlers or spawning. Require a nonempty string process-tree marker, and abort with cleanup if environment publication fails or throws. Pass the captured environment unchanged to the existing supervised runner. This decision covers initial manifest publication; it does not claim that later manifest persistence failures are solved here.
**Status**: RESOLVED IN SOURCE; CANONICAL RECHECK PENDING

**RED**: With the old path, a missing marker completed the push and an `envFor` exception installed the signal handler before failing (0 passed, 2 failed). A truthy non-string marker was then shown to pass the first guard incorrectly (2 passed, 1 failed). The external full-mode auto-trigger fixture also failed its success assertion because its synthetic tree did not publish a marker.
**GREEN**: Missing, non-string, and throwing marker cases all abort before handler installation, spawn, proof writing, or Git push (3 passed, 18 expectations). The corrected auto-trigger fixture passed its named full-mode case. The eight-file affected set passed 191 tests with 1,082 expectations and 0 failures in 19.59 seconds, including the real detached-descendant timeout, cancellation, proof, receipt, runner-selection, backing-issue, GitHub-route, and singleton-trigger coverage.
