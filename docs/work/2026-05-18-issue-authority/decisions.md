# 0.0.18 Issue Authority Decisions

## D1: Stack on PR #168

PR #168 is open, but this branch consumes the adapter foundation by stacking on `codex/0.0.18-adapter-foundation` at `a03f8cf`. The PR #168 SPI shape is stable enough for this slice because the review adapter foundation files and docs are present, tests exist, and IssueAdapter is explicitly documented there as non-scope.

## D2: Beads is the reference adapter, not the authority model

The Beads adapter delegates local issue operations, but authority decisions live in Forge and reuse `lib/issue-sync/authority.js`. This keeps Beads replaceable behind the SPI.

## D3: No separate GitHub import stack

Existing import primitives already normalize and reconcile GitHub issue payloads. This slice documents and tests the boundary instead of introducing a new `forge team sync --pull` implementation path.
