# Declared-command execution

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

The first-party registration makes `check.run`, `check.list`, and `check.show` discoverable
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
supply it; every other key has a `default` in `schemas/config.json`, and `forge config explain`
shows which value is in effect and where it came from. The keys: `commands`, `timeoutMs`, `maxOutputBytes`,
`outputHeadBytes`, `outputTailBytes`, `maxMetadataBytes`, `maxReceiptBytes`,
`report`, `stopOnFailure`, `inputs`, `maxInputBytes`, and `environment`. A command can
select its own `report`; otherwise it uses the declared block report. `exit-code` disables
report interpretation, `json` requires a structured report, and `auto` delegates recognition
to the replaceable output adapter. No particular command, parser mode or stop policy is
selected by the engine. The ordinary instance `operationTimeouts` map overrides the
manifest's operation budgets; command timeouts remain bounded by that invocation deadline.

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
and engine, before snapshots or process calls. Head and tail byte caps must sum to at most
`maxOutputBytes`. `maxMetadataBytes` reserves room for all declared arguments, identifiers,
stream commitments and other receipt fields. It must cover the measured declaration metadata.
`maxReceiptBytes` caps the whole encoded receipt and cannot exceed the host crypto ceiling
of 1,048,576 bytes. The validator requires metadata plus two streams per declared command
to fit that total. Each retained raw byte reserves ten encoded bytes: at most six for its
JSON text preview and four for base64 evidence. Conflicts name the budgets and the maximum
retention that fits. Resolved paths and the actual subject must fit the metadata reservation
before the first command starts. Config application remains JSON Schema only; the reusable
pure validator supplies the cross-field check at invocation time.

The process adapter hashes every raw byte as it arrives, retaining only the configured head
and tail. Receipt stream evidence contains lossless base64 previews, full observed byte count,
SHA-256 digest and whether the pipes drained completely. Text previews remain readable in
`stdout` and `stderr`. Streams that did not drain, or that the recognizer did not see byte for
byte, have unknown test counts and make the run incomplete. Large input bindings use ordered, domain-separated chunk commitments;
every host hash call fits the same 1 MiB ceiling, without splitting Unicode surrogate pairs.
