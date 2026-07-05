# Feature: 0.0.20 Local Broker Contract

Date: 2026-06-01
Status: implemented
Issue: forge-2agy.2.2
Branch: codex/0.0.20-local-broker

## Purpose

Add the first local Forge Kernel broker API surface for command-facing issue operations. This slice binds local mode to the Git common-dir so linked worktrees share one authority location, and exposes SQLite-style WAL behavior as a small, testable storage contract without adding a SQLite runtime dependency.

## Scope

- Add `lib/kernel/broker.js` for Git common-dir broker lookup, local database path planning, WAL pragmas, and migration application through an injected driver.
- Add `KernelIssueAdapter` so commands can route through a Kernel broker interface.
- Add an opt-in Kernel path in `runIssueOperation` via `useKernelBroker`, `issueBackend: "kernel"`, or an injected `kernelBroker`.
- Keep the default Beads path intact until import/export compatibility work lands separately.
- Add a top-level `comment` alias and `forge issue comment` mapping because comment is part of the issue command API contract.

## Authority Answers

- Authoritative: local Kernel broker state under the Git common-dir.
- Cached: none added in this slice.
- Projected: Beads remains a legacy/default command backend, not Kernel authority for opt-in Kernel paths.
- Archived: none added.
- Local-only: broker database path and full worktree/common-dir paths.
- Server acceptance: not required in local mode.
- Projection failure: out of scope for this PR; no Beads import/export behavior is added.

## Storage Contract

The broker config plans a local SQLite database at:

```text
<git-common-dir>/forge/kernel.sqlite
```

Initialization applies these statements before schema migrations:

```sql
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;
```

The actual SQLite driver remains injected through the broker boundary. This keeps the API testable and avoids adding a heavy dependency before the storage runtime decision is locked.
