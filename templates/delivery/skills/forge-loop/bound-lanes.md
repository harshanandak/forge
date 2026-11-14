# Bound lane device progress

Bound lane journals belong to this device and project, fenced by the cloud issue grant.
Claim the issue first, prepare its checkout and brief, then attach with `lane.start`.
`lane.status` enumerates this device's attachments. Retained files do not prove ownership.

`lane.next {id,head}` reserves one numbered local action; repeated calls return that number.
Supply the actual full Git head. A changed head invalidates the stored review verdict.
A reservation is never a permit. Bound `run` and `auto` refuse dispatch until PR 2b.
Do not spawn an agent from a reservation or cache it as permission.
The complete dispatch boundary must read typed `lane.control {id}` fresh before every spawn,
including capacity retries and detached children; it must let an already running action finish.

Record only the current action with `lane.record {id,action,result}`; result is a JSON object.
Its `head` must match the reserved head. Old heads or generations cannot advance progress.
Use `review:true` or `ci:true` for completed review/CI rounds. Call and round budgets persist
across restarts on this device; the time budget measures elapsed time since its first reservation.
Limits come from the existing autopilot configuration. A budget pause never clears counters.
Record a review with `mergeGate:{head,verdict,reviewer}` for the current reserved head only.

For a scope question record `ask:{reason,releaseTotal,default}` in the action result.
Include the total release size and the smallest default; next returns that local ask.
Record the owner's verbatim `answer` on the same action; next stays paused for inspection.
An answer grants no cloud resume approval. Record completion only after handling the decision.
Push, PR creation, merge and each advancing cloud mutation are separate guarded actions.
`lane.close` remains refused until PR 3; never use a local verdict as close authority.
