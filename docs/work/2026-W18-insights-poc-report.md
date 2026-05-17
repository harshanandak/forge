# 2026 W18 Insights PoC Report

## Issues Covered

- `forge-besw.12`: insights from review and evidence patterns
- `forge-1gry`: pattern detector plus skill suggestion UX
- `forge-5q7s`: recap / personal digest

## Result

The PoC adds `forge insights` and `forge recap` on top of existing Beads-backed evidence. It reads `.beads/interactions.jsonl`, `.beads/issues.jsonl`, and optional `.forge/log.jsonl` / `.forge/audit.log`.

## Example Commands

```bash
forge insights --review-feedback
forge insights --min-count 2 --limit 5
forge insights accept insight-interaction-status-closed-merged-and-verified --note "use as review checklist seed"
forge insights reject insight-issue-theme-noise --note "too broad"
forge recap
```

## Example Output

```text
Forge insights
Sources: interactions=16, issues=260, audit=0
Ranked candidates:
- insight-interaction-status-closed-merged-and-verified (55): status changed to closed (merged-and-verified)
  Next: Review interaction evidence and consider a local workflow skill only if the pattern is still useful.
Limitations:
- Compatibility note: --review-feedback now reads Beads interactions and issue evidence; external review-provider comments are not inferred.
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
- Insights are local workflow signals, not proof of correctness.
```

## Limitations

- Sparse interaction history may produce no candidate.
- Candidates are suggestions, not automated skill installs.
- Accept/reject records typed memory decisions; it does not mutate trust, lockfile, or patch-intent internals.
- External review-provider feedback is not mined in this MVP.

## Non-Scope

- upgrade safety
- lockfile/trust policy
- patch intent internals
- team dashboard / issue sync surfaces
