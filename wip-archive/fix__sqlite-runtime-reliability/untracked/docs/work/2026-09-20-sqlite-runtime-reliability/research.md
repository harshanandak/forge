# SQLite runtime reliability investigation

Issue: `077901a3-c4e0-4173-a4e0-373ee2adbe73`.
Source baseline: `origin/master` at `13268a58d1261e00e0c8e79e0441e529c973decc`.

## Decision and scope

The user requires a causal repair for recurring failures, not another isolated timeout patch. Compare previous incidents, but do not assume that similar symptoms share a cause. Keep existing deadlines and quality gates. Measure representative behavior under ordinary supported load; a successful retry is not a root-cause explanation.

## Verified incident

PR #572's merged tree equals its validated head. Exact-merge Windows Node 22 job `106038823736`, Tests run `35495960425`, failed after 23m13s. Its retained artifact `10600611922` independently confirms two failures in `test/kernel/sqlite-driver-memory.test.js`:

| Test | JUnit duration | Deadline |
| --- | ---: | ---: |
| recentMemories and countMemories scope to a source_agent allow-list | 18.469573s | 15s |
| searchMemoriesRanked finds a row by its tag | 16.355104s | 15s |

The full suite reported 8,780 tests: 8,745 passed, 2 failed, 33 skipped, 0 errors. The failed shard reported 740 tests, 2 failures, 10 skips. This is live CI evidence; the cause remains unproven.

## Source findings

- Each test creates a separate file-backed database. The affected path uses in-process `bun:sqlite`; the driver subprocess imports used for runner classification do not mean these operations spawn Node children.
- Driver allocation is lazy. The first memory operation opens the database and calls shared `ensureMemorySchema()` in `lib/kernel/sqlite-driver.js`.
- Fresh initialization creates the memory table, source-agent index, FTS table and three triggers, then backfills the new FTS index. These statements are not grouped into one transaction. Later driver instances skip backfill if the FTS table already exists.
- The affected tests subsequently make three and two individual writes, respectively. Their reads search only those few rows. Schema and write costs must be measured separately from query cost.
- Existing helpers `test/helpers/seed-memory.js` and `test/helpers/recall-memory-fixture.js` already batch setup writes. Some other SQLite fixtures use the Windows-aware cleanup helper. These are candidate mechanisms to reuse, not proof that either explains this failure.
- CI forwards `--timeout 15000` to Bun as a per-test deadline. It is distinct from push's full-suite wall-clock timeout. Runner subprocess weighting is a scheduling heuristic; source classification alone does not prove an actual bound on descendant processes or explain the timeout.

## Discriminating experiment

One temporary Bun probe, one process, at most three fresh databases per affected case. Record allocation, native open/schema work, each seed write, exact reads/assertions, close and removal separately. Capture runtime and SQLite durability settings. Then compare a transaction around real schema/seed operations without modifying production code. Preserve raw results and distinguish that comparison from an implemented fix.

At 09:29:48 UTC the local machine reported 100% CPU, about 3.96 GB free memory, 65 Node/Bun processes, no Forge full-suite/validate process and no Vite process. This is a point observation, not peak resource telemetry or proof about the GitHub runner. Other user workloads remain untouched.

## Investigation ownership

Sol: SQLite lifecycle and the bounded phase probe. Luna: runner/incident comparison and successful-versus-failed CI timing. Root: issue authority, experiment sequencing, causal assessment, plan and review. No production implementation has been selected yet.

## Completed checks

One local Bun 1.4.2 phase probe used six fresh databases, exited successfully in 1.21s, and left the source unchanged. SQLite used `journal_mode=delete` and `synchronous=2` (FULL). Raw probe and results are retained at `C:/Users/harsha_befach/AppData/Local/Temp/forge-sqlite-phase-probe-20260920-150833/`.

| Case | Exact lifecycle | Isolated schema | Each seed write | Reads | Transaction comparison |
| --- | ---: | ---: | ---: | ---: | ---: |
| Source-agent filter | 57.56ms | 36.94ms | 5.09–5.52ms | 1.33ms | 11.58ms |
| Tag-ranked search | 49.49ms | 36.83ms | 5.08–5.48ms | 0.92ms | 11.02ms |

The transaction comparison grouped both schema creation and fixture writes. It is not a measurement of a schema-only patch. Durability-boundary counts in the results are source-derived estimates, not traced commits.

The unchanged real test file then ran once with `bun test --timeout 15000 test/kernel/sqlite-driver-memory.test.js`: 33 passed, 0 failed, 173 assertions, 3.05s aggregate (3.366s command wall time). The two CI failures took 63.83ms and 58.68ms locally. Sampled CPU was 100% at start and 76% at end, with 3.40–4.11GB free RAM. No competing test suite was launched or stopped.

The same CI run's Windows Node 24 artifact (`10601210793`) profiles this file at 4,666ms, versus 52,337ms in the failed Windows Node 22 artifact. Both matrix jobs use Bun 1.4.2; Node matrix labels do not identify the SQLite engine. Successful Node 24 XML is incomplete, so only its profile supports the file-duration comparison.

Independent Sol review agrees that these results demonstrate normal-cost overhead but do not explain the 16–18s CI spikes. Many passing tests use the same fresh-schema path. Do not present schema batching as the incident's root repair without discriminating evidence. Any selected transaction change must preserve existing caller-owned transactions; a blind `BEGIN` would be incorrect.

## CI scheduling evidence and bounded replay

The retained CI scheduler log declares subprocess concurrency **1**. Intended overlap with sibling subprocess shards therefore does not explain the failure. This does not prove the absence of leaked descendants or operating-system contention. Both Windows jobs report Bun 1.4.2 revision `744846f84`.

The failed shard contains 62 test files and 740 tests, with aggregate duration 144.2463696s. SQLite memory follows `test/kernel/sqlite-driver-children.test.js` and precedes `test/kernel/trace.test.js`. Inferred shard timing is approximately 07:11:16–07:13:40 UTC; the final log line at 07:13:40.38 UTC agrees, but explicit shard start markers are absent.

One replay is authorized from the retained XML file list, with the original 15-second per-test deadline and a six-minute overall diagnostic bound. A temporary Bun preload records opaque database ordinals, fixed operation labels, wall/CPU duration, slow calls and maximum RSS. It does not record SQL, row data, parameters or database paths. The local Node runtime is 24.18.0, unlike the failing Node 22 CI job; Bun matches. This replay is diagnostic evidence, not a canonical validation receipt.

Retained inputs: `C:/Users/harsha_befach/AppData/Local/Temp/forge-ci-10600611922/full-suite-apXtKQ/full-matrix-windows-latest-node22-shard-4.xml` and the adjacent profile. Observer: `C:/Users/harsha_befach/AppData/Local/Temp/forge-sqlite-preload-20260920-151950/sqlite-phase-preload.js`.

### Replay result and instrumentation failure

The single 62-file replay exited 0 in 87.815s: 740 tests, 2,478 assertions, 730 passed, 10 skipped, no failures/errors. The SQLite memory file took 2.140741s; the two CI-failed cases took 70.682ms and 53.850ms. Host CPU samples were 100% then 88%, with about 6.15GB free RAM. This shows the shard contents/order alone did not reproduce the failure on this host. It does not prove that CI is healthy.

**The observer did not emit its trace artifact.** The diagnostic command used `bun --preload <file> test ...`, which launched the package's `test` script. That script's child `bun test` did not inherit the preload. Its stderr confirms `bun test --timeout 15000 --timeout "15000" ...`, so the deadline remained unchanged, but the invocation was not identical to CI's direct child command. SQL, close and removal phase data are unavailable. The initial suspicion about an exit-flush failure was superseded by this command-routing diagnosis. Preserve this failed diagnostic rather than claiming phase evidence from it. Raw JUnit, runner summary and logs remain in `C:/Users/harsha_befach/AppData/Local/Temp/forge-sqlite-shard-replay-20260920-152348/`.

The next bounded check repairs only the temporary observer lifecycle and proves emission under an actual tiny Bun test, then the existing 33-test file. A further full-shard run is not authorized yet. Node 24 versus Node 22 remains an explicit environmental difference to resolve before deciding whether another replay would discriminate anything.

The corrected command places options after the subcommand: `bun test --preload <file> ...`. A real temporary test passed and emitted the expected trace. Prefer the existing runner's `buildShardTestArgs()` when constructing another diagnostic command rather than recreating its argument order.

CI's exact Node version is 22.23.2, from `C:/hostedtoolcache/windows/node/22.23.2/x64`; the checked local version-manager locations contain no installed Node 22. The system Node installation remains unchanged at 24.18.0.

### Verified observer result and handoff

The corrected observer ran the original file once: 33 passed, 0 failed, 173 assertions, 3.177s. The trace recorded 34 database opens and 33 fixture directories with zero dropped events. Maximum RSS was 100.5MB. Native opens totalled 20.95ms (maximum 1.32ms); closes 7.32ms (maximum 0.35ms); fixture creation 20.14ms (maximum 1.68ms); removal 22.61ms (maximum 1.17ms). The source-agent and tag cases took 55.24ms and 50.28ms. Neither showed slow reads or cleanup.

Fresh memory/FTS schema operations account for the recurring local setup cost. An intentional locked-reader negative test contributed a 348ms failed schema call and must be excluded from ordinary setup latency. Local evidence still does not locate the 16–18s CI stall; low process CPU cannot distinguish I/O waiting from host scheduling.

Complete phase artifacts: `sqlite-memory-33-trace.json` and `sqlite-memory-33-junit.xml` in the observer directory above. No production code, timeout, quality gate or machine setting changed.

The user explicitly selected finishing the separately confirmed resource-budget patch next (`e0cb0671-735c-4980-944b-286d6f78fe48`). This CI incident and PR #572's post-merge verification remain open. Do not close their issues or remove their worktrees. A future causal replay should use the verified command construction, exact Node 22.23.2/Bun 1.4.2, retained shard list and phase capture; a plain successful rerun is not root-cause proof.
