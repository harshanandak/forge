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
