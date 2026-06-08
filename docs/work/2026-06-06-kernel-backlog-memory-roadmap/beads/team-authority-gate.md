## Description
Define the gate before Forge allows multi-machine/team issue writes.

## Scope
- Team writes require server-side serialized project authority.
- Cloudflare Durable Object per project remains the planned primitive.
- D1/read models, queues, and projections are downstream of authority, not authority themselves.
- Local SQLite mode remains single-machine/many-worktree.

## Acceptance Criteria
- Docs and future commands refuse unsupported multi-machine local-write assumptions.
- Server sequence/entity revision model is documented before implementation.
- Projection outbox/dead-letter behavior is tied to team authority plan.
