# Declared-command execution

`createCheck(services)` is the check engine. Its consumer supplies the project's effective
`commands`, a positive `timeoutMs`, and `maxOutputBytes` (1–262144 per output stream).
Command strings describe one executable invocation. For shell composition, declare a
project-owned script and invoke it, or use `{ argv: [...] }`. The engine never chooses
a package manager, runner or lint command. Detection observations already populate
`/blocks/check/config/commands`; explicit project config can override them.

`run({ checks?, trigger? }, config)` executes declared checks in order and stops after
the first result that does not pass. Remaining requested checks are `NOT_EXECUTED`.
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
stored. A separate content digest covers the receipt. `verifyReceipt(receipt, digest)`
checks its schema, content integrity and expected input binding. Accepted state supplies
provenance; an unkeyed content digest alone is not an authenticity signature.

Recognized zero tests fail even on exit 0. Unknown output uses the exit code and reports
an unknown count. Malformed reports, killed processes and truncated output are incomplete.
Timeout results retain captured output. The process adapter owns termination and tree
cleanup. The runner-output adapter recognizes report formats and imports no runner package.

## Pending async integration

Async handlers for all blocks are owner-approved (tracking `51f33320`) and are being
implemented in PR #27. The handlers here prepare for that single value-or-Promise ABI,
including its signal and deadline, without editing the contract. Once it merges, merge
the fetched main branch normally, add one entry to the first-party registry introduced
by PR #23, and wire invocation-scoped services through the catalog for CLI/MCP parity.
No parallel registry, alternate execution profile, or special CLI path is introduced.

Node acceptance fixtures exercise the packed, installed engine and real state owner.
An embedding that already owns a fresh packed install can set `CHECK_PACKED_CONSUMER`
to that consumer directory; the check fixture reads its base package and mutates only
private copies. Shared CI wiring is tracked separately (`92574980`).
Run the normal pack smoke first when running the packed check fixture alone. The full
suite's earlier packed slice also seeds the package installer cache. This additional
install is offline so it verifies the artifact without repeating registry requests.
Optional ecosystem tools are checked before use and report an explicit skip reason when
missing. Their local installations are test-only and are never shipped as dependencies.
