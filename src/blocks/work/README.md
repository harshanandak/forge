# Work block

`forge/work` is an opt-in implementation of `forge.tracker@1`. Register the built-in source in composition and bind its `state` slot to `core`. Registration does not grant admission or effects. The same declared operations are available from CLI and MCP. Operations are experimental; select `issue` in `mcp.expose` to expose them to MCP.

Use `catalog.call` (CLI: `forge catalog call --input <JSON>`, MCP: `catalog_call`) to supply the canonical context and request ID. Project operations require an actor and project. Claims also require a session and supply no generation. Renewal, release, update, close, dependency edits and links require the current lease generation. No context is invented by the work block.

The provider knows four optional kinds: `task`, `bug`, `feature`, and `epic`. Omitted kinds stay omitted; unknown kinds are refused. A claim without an explicit duration lasts 3600 seconds; `ttlSeconds` may select 1 through 604800 seconds.

Issues, comments and links use records in the `forge/work` namespace. Leases and events remain owned by the generic state owner; this block opens no SQL and adds no parallel claim table. All record writes are read back before returning. Comments are plain text and carry the state owner's actor and timestamp. `issue.comments`, `issue.links`, and `issue.events` expose that accepted history. Close reasons are retained in the accepted event data without extending the tracker item contract.

`ready` means open, every dependency closed, and no live lease. `blocked` means open with a missing or open dependency. `stale` means open with an expired, unreleased lease. Reads never clear leases or change records. Claims recheck open status after acquisition and revoke the just-acquired grant if a concurrent close won. Reacquisition retains the expired lease's generation and increments it; stale holders are fenced inside the write transaction. Acquisition request replay returns the original grant while it still denotes current live authority.

Dependency edits validate references and refuse cycles. Updates use the caller's expected revision. Concurrent creates or comment appends can return `REVISION_CONFLICT`; callers reconcile rather than silently retry. Link writes use the issue as their fenced subject.
