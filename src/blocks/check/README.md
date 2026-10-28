# Declared-command execution

`forge pr merge <n>` runs the same private merge gate, then calls `gh` with
`pr merge <n> --squash --match-head-commit <head>` pinned to the gate's head.
It reserves time for the merge, readback, process cleanup and finalization. Only readback showing MERGED
at that head with a valid merge commit proves success, even if the write timed out.
The result keeps `gate`, `head`, `receipt` and, on success, `mergeCommit`.
Gate refusal exits 1. A nonzero merge exit with a complete OPEN/CLOSED readback
returns `HEAD_MOVED` at another head or `MERGE_REFUSED` at the pinned head (exit 1).
A zero exit without a verified MERGED readback at the pin, or an interrupted write,
returns `MERGE_UNVERIFIED` (exit 2). Read `gh pr view <n> --json state,mergeCommit`
to reconcile before further action. No automatic retry,
admin override, merge queue or branch deletion is requested. This destructive,
non-idempotent operation declares external process, network and write effects;
a path or package copy needs a human grant for those bytes and effects.

`forge pr state <n> [--since <token>]` reads GitHub through `gh`: PR metadata,
all and required checks, paged threads, projected remarks, then a final head/state check.
It prints one JSON line with `ready`, `waiting`, `blocked` or `gone`, reasons, news,
`end` and an opaque repository/PR-scoped `next` token. Unchanged reads with `--since`
print nothing. Read failures exit nonzero. The caller carries the token; no state is stored.
Readiness requires CLEAN or HAS_HOOKS and complete nonempty check evidence; BLOCKED
cannot distinguish missing checks from missing approvals. The receipt-based gate still decides merge.

`createCheck(services)` is the check engine. Its consumer supplies the project's effective
`commands`, a positive `timeoutMs`, and `maxOutputBytes` (1–262144 per output stream).
Command strings describe one executable invocation. For shell composition, declare a
project-owned script and invoke it, or use `{ argv: [...] }`. The engine never chooses
a package manager, runner or lint command. Detection observations already populate
`/blocks/check/config/commands`; explicit project config can override them.

`run({ checks?, trigger? }, config)` executes declared checks in order. When the declared
`stopOnFailure` is true, the first non-passing result leaves later checks `NOT_EXECUTED`.
`list(config)` lists declarations; `show(id)` reads and verifies a stored receipt.
Reads do not start commands or create state. State writes use the bound `StateClient`.

`forge check gate --input '{"pr":123}'` reads merge evidence with the GitHub CLI (`gh`)
through the process port. It requires an OPEN, CLEAN pull request, the newest verified
PASS receipt for its head covering `gate.receiptChecks`, successful required CI checks,
zero unresolved review threads across every page, and no changed `gate.doorPaths`.
CI comes from the captured head commit's paginated status-check rollup (check runs and
commit statuses). Changed files come from the paginated compare API pinned to the captured
base and head SHAs, including rename sources and destinations. Compare returns files on
its first page only. The unique file count must equal the PR's `changedFiles`; PRs above
the compare API's 300-file ceiling refuse. All API reads use the PR URL's hostname.
It reads the base and head again after collecting evidence and refuses if either moved. PASS exits 0;
REFUSED exits 1 with the complete result and refusal reasons retained. Missing, malformed,
truncated or failed CLI evidence refuses. The operation writes no state.

`gate.requiredChecks` defaults to `"github-required"`, resolved by each commit context's
`isRequired(pullRequestNumber: ...)` field.
An explicit list requires every named check; an empty resolved list refuses.
`gate.receiptChecks` and `gate.doorPaths` default to `[]`. An empty receipt check list
still requires a PASS receipt with at least one run. `check.list` returns `receiptChecks`
alongside command names. Door patterns use repository-relative `/` paths: `*` and `?`
match within a segment, and `**` spans segments (`**/release.yml` also matches the root).
Leading `/` or `./`, braces, backslashes and control characters are rejected by the config schema.
The gate selects the configured environment plus `GH_TOKEN`, `GH_HOST` and
`GH_ENTERPRISE_TOKEN` for `gh`; values are never included in the result.

`forge check run` derives its envelope from the accepted receipt: PASS is `ok:true`
and exit 0; FAIL is `ok:false` and exit 1; INCOMPLETE and NOT_EXECUTED are `ok:false`
and exit 2. These use the shared surface exit policy (`src/surface/result.ts`), never
the child exit code. All outcomes keep the full receipt in `result`; MCP carries
the same envelope and sets `isError` for non-PASS. Read failures from `result.runs`,
repair the declared command/environment or timeout, and rerun. `check.show` reports
read success independently of the stored verdict. A fresh repository needs a first
commit: `git add -A && git commit -m "initial commit"`.

`operations["check.run"]` is an async handler that awaits this engine. It forwards the
invocation's `AbortSignal` to the process service and caps each command at the remaining
invocation deadline. Cancellation or expiry prevents later commands and receipt writes.
The engine creates no timer or controller of its own; the runtime owns that lifetime.

The embedding supplies `ProcessPort`, `ClockPort`, `RunnerOutputPort`, an explicit
child environment and a `snapshot()` provider. Each snapshot must cover the exact
head and input file bytes, including uncommitted content. The engine checks snapshots
before and after execution. Changed inputs make the receipt `INCOMPLETE`. The embedding
must exclude check-generated output and Forge's own state from input files, and enforce
the operation's declared effects before opening these services.

Receipts hash the input snapshot, working directory, commands and their resolved paths,
report selection, budgets, trigger and environment digest. Environment values are not
stored. Invocation deadlines control execution but do not change the input binding.
A separate content digest covers the receipt. `verifyReceipt(receipt, digest)`
checks its schema, content integrity and expected input binding. Accepted state supplies
provenance; an unkeyed content digest alone is not an authenticity signature.

Recognized zero tests fail even on exit 0. Unknown output uses the exit code and reports
an unknown count. Malformed reports and killed processes are incomplete. The verdict comes
from the exit code and a report recognized while every output byte streams past; the
retained head and tail are for display, and `truncated` only records that they were cut.
Timeout results retain captured output. The process adapter owns termination and tree
cleanup. The runner-output adapter recognizes report formats and imports no runner package.

## Catalog services and configuration

The first-party registration makes `pr.merge`, `check.run`, `check.list`, `check.show`, and `check.gate` discoverable
through the generated CLI and MCP. The captured `entry.cjs` contains the engine, command
parser and receipt checks. It imports no runtime code. The host supplies the declared
`process`, `files`, `environment`, `crypto`, `output` and `state` slots. The same pure
engine is available to native embeddings through `createCheck`; it is not a second surface.

The shared process service enforces `external:process`. The run declaration also names
`external:write`, `process:write`, `files:read`, `environment:read`, and `check:write`.
Loaded from its built-in source, the block needs no admission or grants (installing Forge
is the trust step); a path or package copy needs human admission and grants. The runtime scopes and revokes
services, owns cancellation, and drains the process tree before returning. The block
starts no timer, supervisor, cache or persistent process.

Every team choice is visible configuration. Only `commands` must be set, and detection can
supply it. `commands` is declared as a whole: once the project sets any command, those are the
commands and detection adds none; `forge config explain` shows each detected command it replaced.
Every other key has a `default` in `schemas/config.json`, and `forge config explain`
shows which value is in effect and where it came from. The keys: `commands`, `timeoutMs`, `maxOutputBytes`,
`outputHeadBytes`, `outputTailBytes`, `maxMetadataBytes`, `maxReceiptBytes`,
`report`, `stopOnFailure`, `inputs`, `maxInputBytes`, and `environment`. A command can
select its own `report`; otherwise it uses the declared block report. `exit-code` disables
report interpretation, `json` requires a structured report, and `auto` delegates recognition
to the replaceable output adapter. No particular command, parser mode or stop policy is
selected by the engine. For the built-in `check.run`, assembly uses the existing instance
`operationTimeouts` mechanism to default the deadline, in milliseconds, to
`N × (T + C) + 2S + F`: selected commands at their own timeout plus process cleanup,
two independently bounded snapshots, and receipt finalization. Assembly derives `C`
from the process service's supervision config: two sequential cleanup waits plus pipe
drain (default `2 × 5000 + 250 = 10250` ms). The snapshot provider enforces
`S = 2 × (10000 + C_default) = 40500` ms, reserving a ten-second startup window and
cleanup for each of the two HEAD lookups. `SNAPSHOT_TIMEOUT_MS`
in assembly is the shared cap for provider enforcement, check sizing and snapshot
callers. The provider fixture declares its operation deadline from
`SNAPSHOT_OPERATION_TIMEOUT_MS` (the cap plus 1000 ms to return the result).
Idle Windows snapshots took 228–1029 ms, but under load a HEAD lookup exceeded
the old 4.75-second startup window. The engine and sizing share
`finalizationTimeoutMs` in `entry.cts`:
`F = 1000 + ceil(maxReceiptBytes × 1000 / 131072)` ms (5000 ms at 512 KiB).
The fixed second covers overhead; the 128 KiB/s floor reserves durable storage time
in the overall operation budget. A scoped run uses the runtime's one invocation
deadline for finalization, including its durable commit and verified readback.
It does not start a second, shorter clock after the final snapshot: Windows lock
waits and commit latency can consume that clock even when the operation has time
left. Native embeddings without an invocation scope retain the finite F deadline.
Five Windows Node 24 samples sealing, writing and reading back a 512 KiB payload
through an open native-ACL SQLite state owner took 421.30–1199.21 ms (median
562.43 ms) under load. Store opening and directory preparation precede this
finalization window. The five-second reservation exceeds four times that maximum,
but is not a separate deadline on scoped runs. A later four-process Windows sample
measured encoding at 62–82 ms, write at 615–1018 ms and readback at 2–48 ms.
ACL reads totaled 0.12–0.21 ms per invocation, outside finalization. Commit contention
dominates; the reserved rate is not a bound on a durable commit under load.
The existing 1 MiB receipt ceiling bounds F at 9000 ms.
Snapshot and finalization allowances do not grow with command timeouts.
Selection and receipt preflight reuse the block's selected-run budget resolver.
A total above the finite timer ceiling is rejected before execution. Explicit instance
overrides and host ceilings remain authoritative; when shorter than the selected run's
budget they are rejected before execution. Command timeouts remain bounded by that
invocation deadline.

Safety ceilings: 256 named checks (names 1–200 characters), 1024 arguments per command,
1–2147483647 ms per command, and 1–262144 bytes per output stream. Input configuration
selects at most 1024 paths, a 1–67108864 byte aggregate snapshot budget, and at most
256 explicit environment names. Missing selected variables are omitted. The child inherits
nothing else. The default `environment` names only what finding and running the project's own
toolchain needs (`PATH`, and on Windows `PATHEXT`, `SystemRoot`, `ComSpec` and the temp and
profile folders); see `schemas/config.json`. The snapshot provider reads exact selected file bytes (including dirty and
untracked selected inputs) and HEAD. It refuses escapes, unsafe file types and over-budget
snapshots rather than returning partial evidence. Select inputs deliberately: command
outputs and Forge state should not be inputs unless a changed-input result is intended.
Internal HEAD lookups reserve 66 output bytes for a complete 64-character object id and
CRLF, independently of the declared command output cap.

Packed fixtures run the installed engine and generated surfaces on Node, against the one
install `bun run test:pack` makes; all counterfactuals mutate only private copies. `CHECK_ECOSYSTEM_TOOLS` and `CHECK_PYTHON_PACKAGES` optionally select
external test-only tool installations. Missing ecosystem executables are explicit skips,
never simulated passes. The Make fixture requires actual recipe output.

The pure `validateBudgets(config)` preflight runs at the start of both the captured handler
and engine, before snapshots or process calls, over the checks selected for that run (all
commands when `checks` is omitted): a command the run does not select reserves nothing. Head and tail byte caps must sum to at most
`maxOutputBytes`. `maxMetadataBytes` reserves room for all declared arguments, identifiers,
stream commitments and other receipt fields. It must cover the measured declaration metadata.
`maxReceiptBytes` caps the whole encoded receipt and cannot exceed the host crypto ceiling
of 1,048,576 bytes. The validator requires metadata plus two streams per declared command
to fit that total. Each retained raw byte reserves ten encoded bytes: at most six for its
JSON text preview and four for base64 evidence. The defaults (1024-byte head and tail, 32768
metadata, 524288 receipt) reserve 40960 bytes per command and so fit 12 selected commands
however large their output, since only the head and tail are kept. Conflicts name the budgets and the maximum
retention that fits. Resolved paths and the actual subject must fit the metadata reservation
before the first command starts. Config application remains JSON Schema only; the reusable
pure validator supplies the cross-field check at invocation time.

The process adapter hashes every raw byte as it arrives, retaining only the configured head
and tail. Receipt stream evidence contains lossless base64 previews, full observed byte count,
SHA-256 digest and whether the pipes drained completely. Text previews remain readable in
`stdout` and `stderr`. Streams that did not drain, or that the recognizer did not see byte for
byte, have unknown test counts and make the run incomplete. Large input bindings use ordered, domain-separated chunk commitments;
every host hash call fits the same 1 MiB ceiling, without splitting Unicode surrogate pairs.
