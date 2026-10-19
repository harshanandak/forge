# Shared contracts

The shared contracts and pure verdict are owned here. Like the tracker convention, the host
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

## Pure evaluation

`pr.evaluate` consumes Evidence and returns Verdict without a host read or mutation.
The named consumer is the pull request guard (Kernel 70849576). CLI and MCP expose
this catalog operation. `verdict(evidence, policy, now)` is the pure API; its rules
live in the captured entry, which cannot import modules. Runtime conformance checks
its canonical digest against the shared contract. The host crypto slot supplies hashing.

All policy keys are required; there are no defaults:

- `minApprovals`: 0?10,000 current-head authorizing approvals.
- `settleMs`: 0?2,147,483,647 milliseconds since the latest change, including edits.
- `optionalChecks`: `ignore` or `safe-terminal` (success, neutral or skipped).
- `allowNoChecks`: allow zero checks when no checks are required.
- `blockingLabels`: up to 10,000 exact label names.
- `mergeMethod`: `squash`; repository availability is separate evidence.

Numeric ceilings bound policy representation. Reviews are selected across heads by
submission time (creation for pending); edits affect settling only. Current-head
approvals count; change requests and pending reviews block on any head. Stale and
superseded observations appear in `ignored`. Providers classify host rules, including
threads and host review requirements. Unsupported rules such as merge queues must
be unknown, yielding INCOMPLETE. Bypass credentials and host disagreement fail closed.
No provider, writes, leases or merge ship here. Forge-only policy is not atomic.
