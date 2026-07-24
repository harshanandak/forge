# Insights And Recap

`forge insights` summarizes recurring local workflow evidence from Kernel and Forge state. `forge recap <issue>` renders a bounded, issue-scoped orientation envelope from the same Kernel issue record.

## Commands

```bash
forge insights
forge insights --review-feedback
forge insights --min-count 2 --limit 5
forge insights --json
forge insights accept <candidate-id> --note "why this is useful"
forge insights reject <candidate-id> --note "why this is noise"
forge recap <issue>
forge recap <issue> --json
```

`--review-feedback` is a compatibility alias. It reads kernel events and issue evidence; it does not infer external review-provider comments.

## Evidence Sources

- Kernel events (`kernel_events`, newest first): field changes and review/close outcome reasons. Interactions imported from a legacy Beads store are read here too, as `beads.interaction.<kind>` events.
- Kernel issues (`forge issue list`): tokenized issue titles and descriptions for themes, plus statuses and timestamps.
- `.forge/log.jsonl` and `.forge/audit.log`: optional audit event counts when present.
- Typed memory: accept/reject decisions are recorded through `lib/memory/typed-api.js`.

## What It Can Infer

- Repeated local workflow patterns.
- Candidate follow-ups based on frequency, source diversity, and evidence count.
- Recent issue activity counts.
- Whether history is too sparse for a useful suggestion.

## What It Cannot Infer

- Does not prove a workflow is correct.
- Reviewer intent is not inferred from provider-specific systems.
- Trusted executable skills are not installed.
- It does not modify upgrade safety, lockfile/trust policy, patch intent internals, team dashboards, or issue sync surfaces.

## Example Output

```text
Forge insights
Sources: interactions=16, issues=260, audit=0
Ranked candidates:
- insight-interaction-status-closed-merged-and-verified (55): status changed to closed (merged-and-verified)
  Next: Review interaction evidence and consider a local workflow skill only if the pattern is still useful.
Limitations:
- Insights are local workflow signals, not proof of correctness.
- Sparse kernel events or missing Forge audit logs reduce confidence.
```
