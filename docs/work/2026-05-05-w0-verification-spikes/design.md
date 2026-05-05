# Wave 0 Verification Spikes

Issue: `forge-ymff`
Branch/worktree: `codex/w0-verification-spikes`
Scope: research notes, spike scripts/tests, and evidence docs only. No Wave 1 runtime features.

## Design Intent

Wave 0 needs evidence before Forge v3 commits to the six-harness surface in D11 and the Wave 1+ translator plan. The best implementation shape for this spike is:

1. Verify Cursor and Codex conventions from primary sources where possible.
2. Keep harness-specific conclusions in docs, not runtime code.
3. Add deterministic executable benches for the two numeric risk gates.
4. Make the benches cheap and repeatable so they can become Wave 1 regression tests when real translator output exists.

## Quality Bar

- Primary-source evidence is preferred over community posts.
- If a source does not prove a stable file format, the conclusion must say so.
- Numeric gates are executable and fail non-zero when thresholds are missed.
- Bench algorithms should be linear in changed artifacts and avoid hidden global scans.
- Any feasibility change for `forge-2si5` must be explicit in `evidence.md`.

## Implementation

- `scripts/spikes/patch-anchor-stability-bench.js` models `patch.md` anchor rename recovery through an `anchor_aliases` map. Default run: 50 patches, 50 renamed anchors, 2 intentionally unmapped aliases, target orphan rate `<10%`.
- `scripts/spikes/config-race-bench.js` models two-machine effective-config resolution. Machine-local keys are namespaced; same-value shared global changes auto-merge; same-key different global changes require manual resolution. Default run: 50 trials, target manual resolve rate `<5%`.
- `test/spikes/w0-verification-spikes.test.js` verifies both executable thresholds.

## Efficiency Notes

- Anchor bench uses `Set` and `Map`, so lookup is `O(patches + anchors + aliases)`. This matches the v3 budget direction of pre-building an anchor index instead of repeatedly scanning files.
- Race bench uses per-trial changed-key maps, so resolution is `O(trials * changed keys)`. The implementation quality implication is that Wave 1 should keep machine-local state in namespaced files/keys and reserve shared global keys for intentional team policy.
