# Protected State Surfaces

Forge defines protected runtime state that agents must not hand-edit. When `scripts/protected-state-check.js` is wired into hooks or CI, the protected-state check blocks direct staged additions, copies, modifications, renames, and deletions, then prints a repair hint that points to the owning command or Forge API surface.

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
| `extension_manifests` | `.forge/extensions/*/manifest.json`, `plugins/*/{plugin,extension,manifest}.json`, `.github/PLUGIN_TEMPLATE.json` | Forge extension/plugin manager |
| `secrets` | `.env.local`, `secrets.json`, credential files | Secret manager or local env setup |
| `immutable` | `.git/` | Git or owning runtime tool |
| `append_only_logs` | `.forge/log.jsonl`, `.forge/audit.log`, `.beads/interactions.jsonl` | Append-only audit writer |

## Behavior

- Direct edits, additions, modifications, renames, and deletions of protected files are blocked by `scripts/protected-state-check.js`.
- Allowed Forge API writes must declare the matching required surface. For example, a Forge config writer must call the protected writer with `surface: "forge_config"` and `viaForgeApi: true`.
- Forge-owned commands that intentionally stage generated protected changes can set `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` to the comma-separated surfaces they own for that command invocation.
- Blocked decisions include actor, path, decision, required surface, reason, and repair hint.
- Audit-ready events use kind `protected_state_write` and are recorded through Beads audit when available.

## Repair Hint

Every blocked path prints a repair hint. A repair hint is specific guidance such as using `bd update` for `beads_state`, `forge setup` for generated harness files, or the package manager for `lockfiles`.

Example blocked output shape:

```text
Protected state write blocked
path: .forge/config.yaml
required surface: forge_config
repair: use the Forge config/setup API for generated config changes
```

Common support notes:

- If the check is not installed in hooks or CI, the model is documented but not enforced for that repository.
- If Beads metadata needs to change after a merge and branch protection rejects the push, use a follow-up PR or the configured sync workflow.
- Forge-owned commands may set `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` narrowly for the surfaces they own.

## Forge API Example

```js
const { writeProtectedFile } = require('./lib/protected-state-surfaces');

writeProtectedFile(projectRoot, '.forge/config.yaml', yaml, {
	actor: 'forge',
	viaForgeApi: true,
	surface: 'forge_config',
});
```
