# Bound lane progress

Claim the issue, prepare its checkout and brief, then attach. `lane.next {id,head}` requires a full Git head and reserves one numbered action; repeats retain its number. Its `raw` JSON identifies the generation and head. Changed heads invalidate review. Status lists device attachments; retained files do not prove ownership.

For `lane.record`, set `context.leaseGeneration` to that reserved generation and `result.head` to that head. Results and merge-gate verdicts require the original generation. Keep rejected old output as a diagnostic; never relabel it for the current grant.

To resume a stopped cloud lane, call `lane.resume` for the exact scope, show
`result.ask` in chat and wait for a clear affirmative reply within 10 minutes.
Retry the same scope with a new command id and
`approval: {request: result.request, quote, source: {harness, thread, message?, link?}}`.
Copy the reply verbatim. Progress replies, refusal, ambiguity and silence leave the stop set.

Counters survive reattachment and regrant on this device; pending actions, asks and verdicts do not cross generations. Existing autopilot limits apply, including elapsed time since the first reservation. Record completed review/CI rounds with `review:true`/`ci:true`.

Record scope questions as `ask:{reason,releaseTotal,default}`, including the total release size and smallest default. Record the owner's verbatim `answer` on that action; next stays paused. Answers never grant cloud resume approval.

Reservations grant no dispatch permission. Bound attached runs read typed `lane.control {id}` fresh with the canonical lane ID before each spawn. Lease renewal is serialized; a failed renewal blocks later dispatch in that runner. Running work finishes without control polling; normal result records still require the current grant. Bound auto/detach and capacity retries stay refused until PR 2b-2. Push, PR creation, merge and each advancing cloud mutation remain separate guarded actions. Close stays refused until PR 3; local verdicts are not close authority.
