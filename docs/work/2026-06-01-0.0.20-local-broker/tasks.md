# Tasks: 0.0.20 Local Broker Contract

## Task 1: Local broker common-dir contract

TDD:
- RED: Add tests proving the broker resolves `git rev-parse --git-common-dir`, stores under the common-dir, and does not use `.beads`.
- GREEN: Implement `lib/kernel/broker.js` with common-dir lookup and deterministic local config.
- REFACTOR: Keep path planning separate from storage driver execution.

## Task 2: WAL-style initialization contract

TDD:
- RED: Add tests proving WAL, synchronous, foreign key, and busy-timeout pragmas are applied before Kernel migrations.
- GREEN: Add broker initialization through an injected driver.
- REFACTOR: Leave SQLite dependency selection outside this PR.

## Task 3: Kernel issue adapter and command routing

TDD:
- RED: Add tests proving Kernel issue operations route through a broker boundary and command aliases can opt into that path.
- GREEN: Add `KernelIssueAdapter`, Kernel backend creation, and opt-in dispatch in `runIssueOperation`.
- REFACTOR: Preserve existing Beads defaults for compatibility.

## Task 4: Comment command API surface

TDD:
- RED: Add tests for `comment` argument mapping.
- GREEN: Add the `comment` issue subcommand and top-level alias.
- REFACTOR: Keep legacy Beads mapping as `bd comments add` while Kernel paths pass `comment` through the broker interface.
