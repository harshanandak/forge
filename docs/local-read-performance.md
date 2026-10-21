Decisions needed: none.

# Local read performance

**The two-second target is not met in the final batch.** The code removes
repeated preparation, but the measured wall-clock results vary widely between
batches. This is not proof of a final latency improvement or a diagnosis of the
variation. Keep the performance issue open.

Measurements use the packed npm package installed into a scratch Git project
with the delivery template imported, a detected test script and one stored
issue. Each run starts a new process; the OS filesystem cache is not flushed.
The host is Windows, Node 24.18.0 and npm 11.16.0. Baseline: main (6cdcce0).
Times include process launch, module loading, command execution, output capture
and process close. Five runs per command and launcher; report the median.
Ambient machine load is not controlled.

## Cold process timings

Seconds, median of five, direct Node entry point:

| Command                     | Baseline | First optimized batch | Final artifact |
| --------------------------- | -------: | --------------------: | -------------: |
| help                        |    0.751 |                 0.962 |          2.504 |
| config show                 |    2.447 |                 1.206 |          5.124 |
| issue show                  |    2.187 |                 1.085 |          5.538 |
| issue list                  |    2.666 |                 0.674 |          3.955 |
| check list                  |    2.424 |                 2.434 |         10.320 |
| catalog describe issue.show |    3.286 |                 1.372 |          3.129 |

The final batch is authoritative for the final artifact. The intermediate batch
is retained to show the variation, rather than selecting its faster results as
the final verdict. An interrupted final batch was discarded; its completed help
median was 4.769 s. Every completed sample in a reported median exited zero.

## Launchers

For a local install, the direct path avoids npm's startup and package resolution:

```sh
node node_modules/forge-workflow/dist/bin/forge.js issue list
```

The comparison launches Node with npm's `npx-cli.js --no-install forge` entry
point, avoiding an extra shell. An `npx` command shim can add overhead. No
network fetch or package installation occurs inside a timed invocation.

Seconds, median of five through npx:

| Command     | Baseline | First optimized batch | Final artifact |
| ----------- | -------: | --------------------: | -------------: |
| config show |    4.590 |                 2.009 |         27.114 |
| issue show  |    4.263 |                 2.038 |         30.996 |

The npx and direct batches are sequential, not paired controls for machine load.
Their difference is not an exact measurement of npm's isolated CPU cost. The
direct path removes the npm launcher by construction; it does not by itself
establish the two-second budget.

## Profile

Run both `issue show <id>` and `config show` with Node's `--cpu-prof`. Keep
unprofiled timings separate from profiles. A `registerHooks` preload records
module load durations and wraps capture, config, runtime and store functions
with `performance.now()` spans. Inclusive spans overlap and must not be added.
CPU samples identify synchronous filesystem costs and compilation; idle samples
include waiting for the supervised Git subprocess.

In the baseline issue trace, six composition snapshots capture 21 blocks
(687 ms). Snapshots take 829 ms in total. Git id-prefix discovery takes 424 ms,
including 420 ms in the process adapter. The operation's runtime takes 23 ms,
including a 5 ms SQLite state acquisition. Output serialization takes 0.10 ms.
The matching config trace takes 767 ms in snapshots, 667 ms in block capture
and 1,377 ms in Git discovery. These are individual profiled runs, not medians.

The baseline loads 299 modules for issue show and 298 for config show, including
the unused MCP transport, its Zod schema machinery and locale modules. V8 module
compilation accounts for 91 ms and 84 ms of CPU samples. `lstat` accounts for
311 ms and 346 ms, respectively. Schema validators interpret schemas; the
repeated work includes registry construction and schema checks, not code
generation. Admission and captured-byte digests remain checked.

The optimized trace loads 192 and 191 modules, respectively. Each command takes
two snapshots and six block captures. Issue capture takes 202 ms; config capture
takes 199 ms. Config reading and resolution take 303 ms and 299 ms inclusive of
capture. Reading project YAML takes 45 ms in each command; resolving layers
takes 21 ms. Schema registry construction takes 24 ms across 14 registries for
issue show and 25 ms across 15 for config show. Digests take about 5 ms.

The optimized issue runtime takes 26 ms, including a 4 ms state acquisition.
The filesystem-class probe takes 0.3 ms. Config show checks for its trust store
in 0.4 ms; this fixture has no external admissions and no trust database.
Private ACL hardening is never called by these reads. Neither store security
nor supervised process cleanup is bypassed.

A final check-list trace takes 7,125 ms end to end. Two process-adapter calls
take 4,207 ms inclusive: id-prefix discovery takes 2,723 ms and runtime/provider
startup takes 1,551 ms. Block capture takes 190 ms, project YAML reads 480 ms,
and store acquisition 7.6 ms. This identifies remaining expensive preparation;
it does not justify bypassing process containment or changing derived config.

## Changes and guards

CLI reads reuse one discovery view for argument parsing, visibility and dispatch.
The view belongs to that call; the next call discovers declarations again.
Mutations continue to check current authority in the runtime. MCP exposure is
resolved when requested, and the transport dependency loads only when MCP opens.
Ordinary config show reuses the snapshot's resolved output; an invocation layer
still uses the config handler.

The unit guard counts discovery preparations and proves a subsequent read sees
changed declarations. The Node integration guard refuses any MCP or Zod import
during built CLI reads. The guards fail on the previous implementation.

## Verification limits

The three new guards pass. Type checking passes and all 107 structure checks
pass. Canary formatting passes. Canary lint remains nonzero with three
await-thenable warnings in unchanged files, tracked by forge-307.

The full unit run completes with 832 passes, two skips, eight failures and three
errors in 455.66 seconds. Seven tests time out; cleanup also reports EBUSY and
resumed assertions report UNKNOWN_COMMAND. These observations were added to
forge-308; causality against this change is not established.

The focused run has seven passes and one config-error integration timeout in
422.46 seconds. The new guards, trust-refusal checks and config counterfactuals
pass. No test timeout, lint rule or gate is weakened. The full integration lane,
full packed journey suite and hosted CI are not verified locally.
