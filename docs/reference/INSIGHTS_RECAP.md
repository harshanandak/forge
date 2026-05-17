# Insights And Recap

`forge insights` and `forge recap` summarize recurring local workflow evidence from existing Forge and Beads state.

## Commands

```bash
forge insights
forge insights --review-feedback
forge insights --min-count 2 --limit 5
forge insights --json
forge insights accept <candidate-id> --note "why this is useful"
forge insights reject <candidate-id> --note "why this is noise"
forge recap
forge recap --json
```

`--review-feedback` is a compatibility alias. In this MVP it reads Beads interactions and issue evidence; it does not infer external review-provider comments.

## Evidence Sources

- `.beads/interactions.jsonl`: field changes and review/close outcome reasons.
- `.beads/issues.jsonl`: tokenized issue titles and descriptions for themes, plus statuses and timestamps for recap context.
- `.forge/log.jsonl` and `.forge/audit.log`: optional audit event counts when present.
- Beads-backed typed memory: accept/reject decisions are recorded through `lib/memory/typed-api.js`.

## What It Can Infer

- Repeated local workflow patterns.
- Candidate follow-ups based on frequency, source diversity, and evidence count.
- Recent issue activity and review outcome counts.
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
```

```text
Forge recap
Issues: 260 total, 94 open, 166 closed
Review outcomes found: 4
Recent work:
- forge-besw.12: forge insights --review-feedback PoC (Week 1 deliverable) [open]
Insight candidates:
- insight-interaction-status-closed-merged-and-verified: status changed to closed (merged-and-verified)
Limitations:
- Sparse Beads interactions or missing Forge audit logs reduce confidence.
```
