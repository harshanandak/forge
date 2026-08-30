# Slice 0 tasks

## Task 1: Freeze benchmark identity and comparison

Owner: bounded implementer subagent.

Files in scope:

- `scripts/benchmark.js`
- `test/benchmarks.test.js`

Requirements:

1. Add a failing test for exact SHA/runtime/platform identity and deterministic content hash in benchmark results.
2. Add a failing test for base-versus-candidate comparison, including identity mismatch and the existing 1.25 latency ratio / 1.20 token ratio caps.
3. Run the focused test and capture RED evidence.
4. Implement the smallest change using existing helpers and Node/Bun standard library only.
5. Run the focused test and capture GREEN evidence.
6. Do not write benchmark artifacts during unit tests outside their temporary directory.
7. Default production runs to at least 3 warmups and 30 recorded samples; record command arguments and report nearest-rank p95, min/max, median, and coefficient of variation from raw samples.
8. Reconcile every derived timing field from raw samples so rehashed forged summaries return `INCOMPLETE`.

## Task 2: Add focused benchmark groups

Owner: same implementer after Task 1 review.

Files in scope:

- `scripts/benchmark.js`
- `test/benchmarks.test.js`

Requirements:

1. Add failing tests that the runner exposes `kernel-core` and `memory-recall` groups.
2. Reuse existing deterministic tests for Kernel readiness/concurrency and memory recall/holdout behavior; do not duplicate corpora.
3. Run RED, implement, run GREEN.
4. Preserve existing groups and default output paths.

## Task 3: Integrate and verify

Owner: main integrator.

Requirements:

1. Spec review Task 1 and Task 2 against this file.
2. Quality review the complete diff.
3. Run focused benchmark tests and the new targeted benchmark groups with the frozen 3-warmup/30-sample contract.
4. Record the measured baseline artifact path without committing generated results.
5. Repair and verify the Kernel dependency edges approved by the final plan.
6. Record the dev-to-validate handoff on the active issue.
