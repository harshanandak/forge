# Smart-status CRLF fixture decisions

## Decision 1

**Date**: 2026-09-19
**Task**: Task 1 — Preserve CRLF coverage with fewer Windows processes
**Gap**: None. The approved scope requires native Windows jq only after genuine CRLF byte proof, with a wrapper fallback elsewhere.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Probe the resolved jq with fixed `-n 1` arguments. Select it directly only on Windows when it exits zero, emits nonempty output, and ends in `0D0A`; otherwise create the CRLF wrapper. Pass the returned command via `JQ_CMD`.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-09-19
**Task**: Task 1 — Preserve CRLF coverage with fewer Windows processes
**Gap**: None. The wrapper's `jq | awk` pipeline was observed returning success after jq failed.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Enable Bash `pipefail` inside the generated wrapper so the existing pipeline preserves the upstream jq failure without changing production scripts.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-09-19
**Task**: Task 1 — Preserve CRLF coverage with fewer Windows processes
**Gap**: A Windows executable named jq is not guaranteed to emit CRLF; the first regression incorrectly equated Windows with direct selection.
**Score**: 0/14
**Route**: PROCEED
**Choice made**: Compare selection with the resolved command's actual nonempty trailing bytes and add an LF-only injected jq case. The helper must choose the wrapper whenever the direct probe does not end in `0D0A`, including on Windows.
**Status**: RESOLVED

## Evidence

- RED — wrapper failure propagation: expected exit `7`, received `0`; 0/1 passed, 445 ms case and 822 ms file.
- RED — native selection: expected proven Windows direct selection, received no selection metadata; 0/1 passed, 571.8 ms case and 970 ms file.
- Focused GREEN — LF-only fallback: 1/1 passed in 696 ms; emitted exact bytes `31 0D 0A` through the wrapper.
- Focused GREEN — actual-byte selection: 1/1 passed in 901 ms; nonempty output ended in `0D0A` before direct Windows selection.
- Focused GREEN — wrapper failure propagation: 1/1 passed in 471 ms; jq exit `7` remained exit `7`.
- Focused GREEN — full arithmetic behavior: 1/1 passed in 2.58 seconds with the unchanged 20-second deadline and existing assertions.
- Affected file: 7/7 tests and 20 assertions passed in 4.13 seconds.
- Focused ESLint: both changed JavaScript files passed with zero lint errors or warnings; Node emitted the repository's module-type performance warning for `eslint.config.js`.
