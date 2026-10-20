# GitHub status and pinned merge

The thin block declares `pr.status` and `pr.merge` and runs `gh` (and only `gh`) through the process service.
It asks GitHub for status, defaults `requireResolvedThreads` to true, and only squash
merges the expected head. Supply a GitHub `owner/repository`; other hosts are unavailable.
Thread policy is checked before merging; GitHub enforces protection at merge time.

The earlier shared contracts below remain unchanged. Like the tracker convention, the host
uses `forge.interface/1`, identity `forge.pr-host`, provider `forge.pr-host@1.0.0`,
and consumer slot `{ slot: "host", interface: "forge.pr-host@1" }`. Schema references
resolve beside the interface document. It is owned by this block, never core.

The shipped assembly rejects block-to-block slots with `PROVIDER_MISSING`
(`test/tools/conformance/slot.test.ts`). Later wiring therefore uses the process-hook
fallback `forge --hook github.read/call`, JSON on stdin, with these contracts.
No assembly change or hook implementation is included.

The generic guard records real calls. Output schemas list refusal schema files in
`x-conformance-refusals`; each must be a `oneOf` alternative and be observed per operation.
Runtime `OUTPUT_INVALID` cannot hide output mismatches. The digest hashes key-sorted
JSON with SHA-256, preserving array order and all decision-bearing evidence. It excludes
only `observedAt`: re-reading unchanged state must not invalidate authorization.

Future invariants and their enforcing tests (not implemented in this slice):

- Evidence problems become gaps/INCOMPLETE, never exceptions (slice 2 read tests).
- Authority comes only from `authorizing` (slice 1 verdict table).
- Verdicts use fresh evidence (slice 1 verdict table).
- Merge requires exact head and matching digest (slice 6 preflight tests).
- Forge-only policy is not atomic (slice 6 preflight tests).
