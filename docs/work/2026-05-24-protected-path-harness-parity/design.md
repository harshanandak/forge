# Protected Path Harness Parity

Issue: `forge-5146`

## Scope

This PR ships the next harness parity foundation after the capability matrix:

- A machine-readable `.forge/protected-paths.yaml` default manifest.
- A validator and evidence builder for the protected path contract.
- A per-harness enforcement matrix for Claude, Cursor, and Codex.
- User documentation that later renderer/runtime work can link to.

## Non-Scope

- Do not install broad runtime hooks into every harness in this PR.
- Do not rewrite the existing protected-state write guard.
- Do not change Beads storage or synchronization behavior.

## Design

Forge owns a canonical protected path manifest and projects enforcement into harness-native surfaces:

- Claude: `PreToolUse` hook contract for write/edit tools.
- Cursor: file watcher or CLI/pre-commit fallback until a first-party hook surface is proven.
- Codex: lifecycle hook contract for write/edit tools.

The validator proves the manifest has the seven W1 categories from `forge-5146`: `forge_core`, `user_protocol`, `generated_artifacts`, `append_only_logs`, `secrets`, `beads_state`, and `immutable`.

## Technical Research (/plan)

### Goals

The plan phase scoped this as a machine-readable protected-path contract that can be projected into Claude, Cursor, and Codex harness enforcement without installing broad hooks in this PR. The contract must preserve the seven W1 categories from `forge-5146` while leaving later runtime work a stable manifest, validator, and evidence command.

### Alternatives Considered

- Full hook rollout now: rejected because the PR only needs a shared manifest and evidence boundary.
- Harness-only rules: rejected because Claude, Cursor, and Codex expose different enforcement surfaces and need one Forge-owned source of truth.
- Category-only manifest with no legacy surface record: rejected because the 0.0.19 protected-state docs/runtime still use named surfaces such as `forge_config`, `lockfiles`, `workflows`, and `memory_projection`.

### Tradeoffs

The canonical validator stays category-driven, using `forge_core`, `user_protocol`, `generated_artifacts`, `append_only_logs`, `secrets`, `beads_state`, and `immutable` as the durable W1 vocabulary. The legacy `surfaces` block remains as deprecated compatibility context, and its examples must be covered by the authoritative category path patterns so drift is visible in evidence.

### Risks

Cursor remains on fallback enforcement until a verified first-party hook surface is proven. Legacy surface names can also drift from the category contract unless the validator keeps checking coverage for the examples listed in `.forge/protected-paths.yaml`.

### Next Steps

Later runtime PRs should wire the protected-path manifest into harness-specific write gates, produce blocked-write repair hints per category, and remove or migrate the deprecated `surfaces` block after the protected-state docs no longer need it.

## Evidence

The evidence command should print JSON:

```bash
node scripts/spikes/protected-path-manifest.js
```
