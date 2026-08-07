# Critical merge-flow reliability decisions

## Locked decisions

1. The measured regression is treated as a control-plane reliability problem; no model winner is claimed.
2. Forge remains the coordination control plane, not a mandatory reasoning ladder.
3. The universal floor is exact-head, live authority, required checks, actionable-thread resolution, conflict safety, privacy, and non-destructive cleanup.
4. Shepherd is the only canonical PR observer. Harness integrations wake and subscribe; they do not create another monitor.
5. Monitoring streams to an explicit owner task and terminates on success, terminal failure, owner completion/cancellation, lease expiry, TTL, or no open PRs.
6. Implementation may run in parallel after collision checks; merges are sequential through one next-at-bat slot.
7. Feedback is classified and batched; full CI runs once on the intended final head unless that head changes.
8. Missing or non-reconstructable evidence is INCOMPLETE, never PASS.
9. Existing issues and design documents are reused. Unrelated defects receive separate deduplicated issues and PRs.
10. Policy guides outcomes and safety, not model thought process, tool order, or implementation creativity.

## Promotion gates

- zero critical, stale-head, unauthorized, or destructive actions;
- false blockers below 5%;
- median correction batches at most 1 and P90 at most 2;
- no severity-weighted post-merge escape regression;
- zero model polling in monitored cases;
- no orphan watcher or owner subscription;
- model time and tokens remain within the agreed quality-adjusted margin.

## Revisit triggers

Reopen the design only if the safety floor cannot be expressed by one deterministic control plane, GitHub authority changes materially, a supported harness cannot implement bounded wake/delivery, or the controlled corpus shows a statistically and operationally material regression.
