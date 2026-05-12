# Decisions Log: 0.0.13 Config Rails And Graph Introspection

## Decision 1

**Date**: 2026-05-12
**Task**: Task 1 - Config Resolution And Locked Rails
**Gap**: Whether to bump the runtime graph schema version for additive config fields.
**Score**: 2/14
**Route**: PROCEED
**Choice made**: Keep `RUNTIME_GRAPH_SCHEMA_VERSION` at `0.0.12` because this PR builds on the landed contract and adds resolved graph fields without replacing the envelope contract.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-05-12
**Task**: Task 2 - Options Introspection Command
**Gap**: Whether `forge explain` should be included.
**Score**: 1/14
**Route**: PROCEED
**Choice made**: Add `forge explain <id>` only as a thin alias over `forge options why <id>`, with no separate explanation semantics.
**Status**: RESOLVED
