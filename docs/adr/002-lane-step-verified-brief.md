# ADR-002 Verified brief consumption for lane steps

## Context

An inspect result names a lane, checkout, revision and brief digest. The
workflow's lead-approved input supplies the trust decision. The context carries
neither a signature nor a reservation.

## Decision

Consumption resolves the brief from the unique lane registry entry. It reads
the file once through the bounded reader, checks SHA-256 over the original
bytes and uses those bytes for all later processing. The consumer rechecks the
workspace, branch, head, cleanliness, lease and local stop state. Cloud-bound
contexts are refused.

The step contract admits a closed set of operations. The initial operation
verifies the brief and reports its status. Forge remains the state authority.
Evidence writes and dispatch require their own steps. Merge, pushes to main
and lane close stay outside the workflow.
