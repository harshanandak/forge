# Decisions

## Decision 1

**Date**: 2026-09-19
**Task**: Exact version fast path
**Gap**: The initial test-only scope could diagnose but not remove eager production startup work.
**Score**: 2/14
**Route**: PROCEED
**Choice made**: Root extended ownership to the minimal `bin/forge.js` fast path. Exact standalone version aliases may bypass `../lib/*`; every other invocation keeps the existing path.
**Status**: RESOLVED

## Validation evidence

- Exact alias regression: RED 0/1, then GREEN 1/1.
- Existing packed root CLI journey: 1/1 in 50,762.81 ms under its unchanged 60-second deadline.
- Compiled Bun timing was not measured and is not claimed.
