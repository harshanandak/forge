# Dispatch a worker

Before dispatch, run `forge route get <role> --text` and use its line to select the route; run `forge issue call <slice> --role <role>`. Retry REVISION_CONFLICT. Pass returned timeboxMinutes and stopBy. Then dispatch the subagent.

## Worker brief

Fill every field before delegating; an empty field blocks the call:

```
Goal: <slice id and end state; read forge issue show for the spec>
Scope: <Owns and done boundary>
Context: <Touches / Needs, adopted decision titles and checkpoint>
Acceptance: <observable pass predicates>
Verify: <named red/green check, risk band, scenario and final-head checks>
Timebox: <returned timeboxMinutes (at most 45 minutes) and stopBy; apply the router's hard stop>
Forbidden: pass named environment variables only, never the whole environment or secret values; include the router's hard stops; never merge base unless asked.
Report: <head, receipts, saved output and not checked>
Standing rules: <adopted rules; layer 1 passes the memory packet>
```

## Lanes and capabilities

At most 3 workers at once, and 1 full-suite run at a time. A worker silent for 10 minutes is stalled: read its state and steer it.

Capabilities: orchestrator strong, implementer fast, reviewer other-family, housekeeping cheapest. The harness picks the model.
