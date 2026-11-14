# Bound lane progress

Read before bound start, next or record. Claim, prepare the checkout and brief, then attach. Status lists this device's attachments; retained files are not ownership.

`lane.next {id,head}` requires the full Git head and reserves one numbered action. Repeats retain its number. Its `raw` JSON gives the reservation's generation and head. A changed head invalidates review.

For `lane.record`, set `context.leaseGeneration` to that reserved generation and `result.head` to that head. Results and merge-gate verdicts require the original generation. Keep rejected old output as a diagnostic; never relabel it for the current grant.

Counters survive reattachment and regrant on this device; pending actions, asks and verdicts do not cross generations. Existing autopilot limits apply, including elapsed time since the first reservation. Record completed review/CI rounds with `review:true`/`ci:true`.

Record scope questions as `ask:{reason,releaseTotal,default}`, including the total release size and smallest default. Record the owner's verbatim `answer` on that action; next stays paused. Answers never grant cloud resume approval.

Reservations grant no dispatch permission. Bound run/auto refuse until PR 2b reads typed `lane.control {id}` fresh before each spawn, capacity retry and detached child. Running work finishes normally. Push, PR creation, merge and each advancing cloud mutation remain separate guarded actions. Close stays refused until PR 3; local verdicts are not close authority.
