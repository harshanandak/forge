# Protected State Surfaces

Forge protects runtime state that agents must not hand-edit. The protected-state check blocks direct staged edits and prints a repair hint that points to the owning command or Forge API surface.

The committed manifest is `.forge/protected-paths.yaml`. Runtime enforcement is implemented in `lib/protected-state-surfaces.js`; the manifest keeps the protected surface contract visible to agents and reviewers.

## Protected Categories

| Surface | Examples | Required write surface |
| --- | --- | --- |
| `beads_state` | `.beads/issues.jsonl`, `.beads/config.yaml` | `bd` or Forge issue commands |
| `forge_config` | `.forge/config.yaml`, `.forge/protected-paths.yaml` | Forge config/setup API |
| `generated_harness` | `AGENTS.md`, `.claude/skills/`, `.codex/skills/`, `.cursor/rules/` | `forge setup` or harness generator |
| `memory_projection` | `docs/sessions/`, `docs/memory/`, `.forge/memory/` | Forge memory projection writer |
| `workflows` | `.github/workflows/`, `.claude/commands/`, `.forge/hooks/`, `lefthook.yml` | Forge workflow/setup commands |
| `lockfiles` | `bun.lock`, `package-lock.json`, `.forge/extensions.lock` | Package manager or extension installer |
| `extension_manifests` | `.forge/extensions/*/manifest.json`, plugin manifests | Forge extension/plugin manager |
| `secrets` | `.env.local`, `secrets.json`, credential files | Secret manager or local env setup |
| `immutable` | `.git/` | Git or owning runtime tool |
| `append_only_logs` | `.forge/log.jsonl`, `.forge/audit.log`, `.beads/interactions.jsonl` | Append-only audit writer |

## Behavior

- Direct edits to protected files are blocked by `scripts/protected-state-check.js`.
- Allowed Forge API writes must declare the matching required surface. For example, a Forge config writer must call the protected writer with `surface: "forge_config"` and `viaForgeApi: true`.
- Blocked decisions include actor, path, decision, required surface, reason, and repair hint.
- Audit-ready events use kind `protected_state_write` and are recorded through Beads audit when available.

## Repair Hint

Every blocked path prints a repair hint. A repair hint is specific guidance such as using `bd update` for `beads_state`, `forge setup` for generated harness files, or the package manager for `lockfiles`.

## Forge API Example

```js
const { writeProtectedFile } = require('./lib/protected-state-surfaces');

writeProtectedFile(projectRoot, '.forge/config.yaml', yaml, {
	actor: 'forge',
	viaForgeApi: true,
	surface: 'forge_config',
});
```
