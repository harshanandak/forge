# Protected Path Manifest

Forge uses `.forge/protected-paths.yaml` as the canonical protected-path contract for the schema and integrity rail.

The manifest defines seven W1 categories:

- `forge_core`: checksum-verified Forge runtime files.
- `user_protocol`: user-facing protocol files that should be changed through Forge CLI surfaces.
- `generated_artifacts`: generated harness files that should come from renderers.
- `append_only_logs`: audit logs that must not be rewritten.
- `secrets`: env and secret-bearing files.
- `beads_state`: Beads state owned by `bd` or Forge issue adapters.
- `immutable`: VCS/runtime internals owned by their tools.

## Harness Enforcement

Claude and Codex use native hook contracts for write/edit enforcement. Cursor fallback remains Forge CLI/pre-commit or file-watcher enforcement until a native Cursor hook surface is proven by fixture evidence.

## Evidence Command

```bash
node scripts/spikes/protected-path-manifest.js
```

The command emits machine-readable JSON containing the manifest categories, per-harness enforcement mapping, validation result, and known issue for Cursor fallback.
