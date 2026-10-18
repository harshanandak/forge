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

## Assembly prerequisite

The locked `trusted-action-sync/v1` ABI cannot await `ProcessPort.run()`. The first-party
directory registry alone does not change that. Catalog integration needs an approved
native asynchronous dispatch seam or execution profile. This engine does not widen the
outside-author ABI, add a parallel registry, or expose a special CLI-only path.

Node acceptance fixtures exercise the packed, installed engine and real state owner.
Optional ecosystem tools are checked before use and report an explicit skip reason when
missing. Their local installations are test-only and are never shipped as dependencies.
