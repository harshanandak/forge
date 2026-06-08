# PR Update: Kernel Storage, Backlog, and Knowledge Roadmap

## Correction

The first roadmap pass was too high-level. This update breaks the roadmap into implementation-sized Beads backlog stories so the team/frontend/agents can see what must be built, what remains only a decision, and what must wait for team authority.

## PR Intent

This PR is a planning and tracker-structure PR, not a runtime storage rewrite. It should create enough structure that later PRs can safely implement the Kernel storage and knowledge system without accidentally removing Dolt/Beads capabilities before Forge has replacements.

## What This PR Adds

1. A storage authority decision matrix.
2. A backlog/sprint/story/task taxonomy.
3. A Project Knowledge Layer MVP plan.
4. Multi-worktree and multi-agent concurrency risk mapping.
5. Beads child issues under `forge-2agy.9.*` that are small enough to become real implementation backlog items.
6. A clear gate: SQLite local mode is not team/multi-machine authority.

## Core Storage Answer

SQLite is good for local single-machine authority when all writers go through Kernel transactions. It is not a Dolt replacement for multi-machine distributed merge.

Forge should preserve this split:

- **Local authority:** SQLite WAL broker, keyed by git common-dir.
- **Team authority:** server-side serialized project authority before multi-machine writes.
- **Projection:** Beads, GitHub, Linear.
- **Knowledge/read models:** rebuildable FTS/vector indexes over Kernel events and docs.
- **Archive:** local/R2 evidence bundles.

## What We Must Not Do Yet

- Do not delete Beads runtime compatibility.
- Do not claim SQLite+git can safely merge multiple machines.
- Do not make extracted memories/facts authoritative.
- Do not build frontend boards over ambiguous issue/status/stage concepts.
- Do not let Hermes integration compete with Hermes native memory.

## Implementation Principle

Every later implementation PR should map to a Beads story/task and include:

- exact authority/read-model/projection classification;
- expected concurrency behavior;
- migration/fidelity boundary;
- frontend/agent output shape when relevant;
- validation fixture.
