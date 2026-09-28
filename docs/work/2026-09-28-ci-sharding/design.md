# CI sharding with staged fail-fast gates — design (2026-09-28)

Issue: 580e7f11. Design review: Astra (gpt-6-astra, read-only), adjusted for GitHub plan limits. Evidence: per-file CI timings in `docs/work/2026-09-28-windows-test-perf/data/ci-run-36401362381/per-file-os-compare.csv` (622 files; summed Ubuntu 139s, macOS 159s, Windows 792s).

## Goals
1. Cut wall time by running the suite across parallel runners. The repo is public, so standard runners are free.
2. Fail fast: cheap checks run first, and expensive stages never start when a prerequisite fails.
3. Never hide a failure. `CI Gate` stays the single required aggregate. A job skipped because a prerequisite failed counts as **FAIL**, never pass.

## Constraints (GitHub Pro plan, verified from docs.github.com 2026-09-28)
- 40 concurrent jobs in total and **5 concurrent macOS jobs**.
- 256 jobs per matrix, 50 re-runs per run, 10 GB cache per repo.
- Larger runners are always billed, so use standard runners only.

## Stages

| Job | Stage | `needs` | Work |
|---|---|---|---|
| `changes` | 0 | — | Classifier, partition validation, install, strict ESLint, planner/gate contract tests. Docs-only gets doc assertions only. |
| `core` | 1 | changes | Full-suite inventory minus the expensive group, sharded across runners |
| `smoke` | 1 | changes | Existing Windows/macOS Node 24 smokes on non-OS-sensitive PRs |
| `stage1-gate` | 1 | changes, core, smoke | `if: always()`: evaluates stage results and core receipts |
| `expensive` | 2 | changes, stage1-gate | Package/install and e2e files, sharded |
| `coverage` | 2 | changes, stage1-gate | Existing Ubuntu/Node 24 coverage |
| `ci-gate` | final | all of the above | `if: always()`: complete assignment and execution evidence |

- `fail-fast: true` for core and expensive matrices on PRs; `false` for smokes and for scheduled or manual diagnostic runs. Never use `continue-on-error` for required execution.
- Gate messages name the stage that stopped the run, for example `FAIL stage 0: ESLint failed; stages 1–2 blocked`, or `PASS docs-only: stages 1–2 intentionally omitted`.
- Missing or invalid classifier outputs, missing receipts, cancellation, and skips caused by a failed prerequisite all fail the gate.

## Cross-runner partition (PR 1)
- **CLI:** `scripts/test-full-suite.js --shard-index i --shard-total n --suite all|core|expensive`.
  - Indices are zero-based. The two flags must be given together, `n ≥ 1`, and `0 ≤ i < n`.
  - Omitting them keeps today's full local run unchanged.
  - `--shards N` stays the per-runner worker budget; it is not the cross-runner count.
- **Assignment:** deterministic greedy longest-processing-time over a committed per-OS weight table.
  - Order files by descending weight, with the normalized path as a locale-independent tie-breaker, and put each file on the least-loaded shard (deterministic ties).
  - Unknown or new files get **1,000 ms**. Every discovered file lands in exactly one shard, so timing data is never an allowlist.
- **Within a runner:** the existing lane scheduling applies unchanged (unit → subprocess/exclusive, `laneWorkerCost`, Windows unit deferral, fixture preparation, exclusive serialization).
- **Expensive group (initial):** `test/e2e/**`, `test/integration/standalone-package-smoke.test.js`, `test/integration/github-account-context.test.js`, `test/integration/package-distribution.test.js`, `test/package-distribution.test.js`. Everything else is core.
- **Coverage proof:** for each OS/Node tuple, the core and expensive partitions together equal the discovered inventory exactly: no duplicates, no missing files, no foreign paths. Each shard records a receipt: the files assigned and completed, commit SHA, partition digest, OS/Node, index/total and status.
- **Weights:** `scripts/test-weights.json`, keyed by normalized path, holding Linux/macOS/Windows milliseconds plus source-run metadata. The first version is seeded from the CI run above. Later it is regenerated from the median of the last 5 successful CI runs (PR 2).

## Shard counts (planning estimates, not measurements)

| OS | Core shards (heaviest shard) | Expensive shards (heaviest shard) | Estimated core job |
|---|---|---|---|
| Ubuntu | 2 (57s) | 1 (25s) | 1.7–2.5 min |
| macOS | 2 (69s), or **1 per Node in full mode** (5-job macOS cap) | 1 (21s) | 1.9–3 min |
| Windows | 8 (85s) | 2 (57s) | 2.2–2.9 min |

Estimated end-to-end run: about 6–9 minutes, against roughly 17 today. Windows' largest single file (65.5s) limits how far more shards can help.

## Risks
- **Windows contention (#547):** keep the heavy-worker cost of 2. Cross-runner sharding does not require raising per-runner concurrency. #590's budget change applies only if its A/B evidence passes.
- **Per-shard setup cost** (30–60s each): measure queue delay before adding shards.
- **Concurrency groups:** cancel superseded PR runs, but manual or scheduled runs must never cancel master validation. Artifact names include OS, Node, phase and shard.
- **Duplicate `CI Gate` producer** (`required-checks-bypass.yml`): retire it through tracked follow-up 9616bf7a.

## PR sequence

| PR | Scope | Lands |
|---|---|---|
| 1 | Outer partition and suite selection, initial weight table (`scripts/`, `test/scripts/`) | Before #581 (no workflow change) |
| 2 | Weight refresh from CI JUnit and durable shard receipts | Before #581 |
| 3 | Staged jobs plus a gate evaluator in the workflow template and rendered copy, `scripts/ci-gate.js` | After #581 |
| 4 | Enable the measured counts and refresh weights | After PR 3's validation; #590's budget depends on its A/B |
