# Delivery workflow decisions

## Decision 1
**Date**: 2026-09-18
**Task**: Deterministic full test workflow writer
**Gap**: The assigned files did not include the two targeted-test selector files required by CODING_STANDARDS.md section 5 for a new source and non-JavaScript canonical asset.
**Score**: 1/14
**Route**: PROCEED
**Choice made**: Add only the two path-to-test mappings offered by the lead; do not change runner behavior.
**Status**: RESOLVED

## Decision 2
**Date**: 2026-09-18
**Task**: PR #567 review corrections
**Gap**: Review found that unchanged Bun pins skipped canonical template/output validation, writer actor fallback differed from the consuming hook, and batch generation did not bind the preflight test workflow render across delayed writes.
**Score**: 4/14
**Route**: PROCEED
**Choice made**: Validate the staged template projection before the unchanged-version return, use the hook actor precedence in both writer entrypoints, and pass an immutable version/content binding that the test workflow writer checks after fresh staged-state resolution and before authority or writes.
**Evidence**: Actual hook regression reproduced the template-only bypass; sanitized-environment authority consumption reproduced the actor mismatch; injected package drift reproduced a mixed-version batch before the immutable binding was enforced.
**Status**: RESOLVED

## Decision 3
**Date**: 2026-09-19
**Task**: PR #567 SHA-256 and maintainability review
**Gap**: The shared workflow HEAD gate accepted only SHA-1 even though protected-state authority accepts SHA-1 and SHA-256, while static analysis flagged escaped regular-expression strings, nested templates, writer complexity, and missing public contract documentation.
**Score**: 3/14
**Route**: PROCEED
**Choice made**: Reuse the authority object-ID predicate in the shared workflow gate, preserve exact Git-entry matching with `String.raw`, extract immutable preflight comparison from the writer, and document the writer, authority, batch, and staged-validation contracts and their failure boundaries. Keep completion distinct from later commit-hook consumption. Address useful contract documentation rather than adding boilerplate to test callbacks for the review bot's aggregate coverage percentage.
**Evidence**: A real SHA-256 Git repository failed before the fix and then generated through production authorization and completion functions with an injected event store. The five focused caller suites passed 101 tests with 800 assertions, covering SHA-1/SHA-256, invalid/stale HEADs, and recovery without changing generated workflow bytes. Strict lint and independent source review passed; remote analysis remains a separate post-push check.
**Status**: RESOLVED
