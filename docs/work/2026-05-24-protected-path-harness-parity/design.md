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

## Evidence

The evidence command should print JSON:

```bash
node scripts/spikes/protected-path-manifest.js
```

