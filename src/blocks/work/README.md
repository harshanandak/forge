# Work block

`forge/work` is an opt-in implementation of `forge.tracker@1`. Register the built-in source in composition and bind its `state` slot to `core`. Registration does not grant admission or effects. The same declared operations are available from CLI and MCP. Operations are experimental; select `issue` in `mcp.expose` to expose them to MCP.

Project operations require an actor and project. Claims also require a session and supply no generation. Renewal, release, update, close, dependency edits and links require the current lease generation. No context is invented by the work block.

The CLI and MCP surfaces supply both, so `forge issue claim <id>`, `forge issue link ...` and `forge issue close <id>` are plain commands:

- **Session.** The caller's session is `FORGE_SESSION` when set. Otherwise every CLI command uses one fixed session (`local-cli`), so separate commands share a claim, and each MCP server uses its own random session for its lifetime. Two agents that use the CLI in one checkout set different `FORGE_SESSION` values so they never share a claim.
- **Generation.** A held operation that names an item `id` and no generation takes the generation of that item's live lease, read through `issue.show`. Only the number is filled in. The state owner still checks that the lease belongs to the caller's actor and session, so another session's link or close is refused with `LEASE_NOT_HELD`, and an item with no live lease is refused with `CONTEXT_MISSING`.

`catalog.call` (CLI: `forge catalog call --input <JSON>`, MCP: `catalog_call`) still takes a full context and request ID; a context it supplies replaces the surface's.

The provider knows four optional kinds: `task`, `bug`, `feature`, and `epic`. Omitted kinds stay omitted; unknown kinds are refused. A claim without an explicit duration lasts 3600 seconds; `ttlSeconds` may select 1 through 604800 seconds.

Issues, comments and links use records in the `forge/work` namespace. Leases and events remain owned by the generic state owner; this block opens no SQL and adds no parallel claim table. All record writes are read back before returning. Comments are plain text and carry the state owner's actor and timestamp. Comments and links are read in numeric append order, including after the ninth entry. `issue.comments`, `issue.links`, and `issue.events` expose that accepted history. Close reasons are retained in the accepted event data without extending the tracker item contract.

`issue.list`, `issue.ready`, `issue.blocked` and `issue.stale` accept `labels`; an item matches when it carries every given label. Priority is a label, not a field. Set `labelOrder` in the block config (for example `["p0","p1","p2","p3","p4"]`) and `issue.ready` sorts each item by the first listed label it carries, then by stored order; items with none of them come last. The default is an empty list, which leaves the order unchanged.

`ready` means open, every dependency closed, and no live lease. `blocked` means open with a missing or open dependency. `stale` means open with an expired, unreleased lease. Reads never clear leases or change records. Claims recheck open status after acquisition and revoke the just-acquired grant if a concurrent close won. Reacquisition retains the expired lease's generation and increments it; stale holders are fenced inside the write transaction. Acquisition request replay returns the original grant while it still denotes current live authority.

Dependency edits validate references and refuse cycles. Traversal uses an explicit active stack and completed-node results, so shared subgraphs are expanded once per invocation. Lint shares those results across all issues; ready and blocked reuse the listed records when checking dependencies. Graph work is bounded by nodes plus edges, with no recursive call stack. The state owner checks the revisions read during validation inside the write transaction; a changed graph is refused with `REVISION_CONFLICT` before accepting the write. Updates use the caller's expected revision. Concurrent creates or comment appends can return `REVISION_CONFLICT`; callers reconcile rather than silently retry. Link writes use the issue as their fenced subject.

Operation declarations budget 5000 ms for reads and 15000 ms for durable writes, including lease changes. The embedding host can supply a tighter ceiling. These explicit budgets allow filesystem durability work on loaded hosts; an exhausted budget fails and any accepted effect requires reconciliation.
