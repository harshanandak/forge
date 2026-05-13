# Adoption Templates

Forge templates are adoption scaffolds over runtime graph primitives. They are not the product surface: the generated `.forge/config.yaml` stays inspectable with `forge options`.

## Entry Point

```bash
forge init --profile minimal --yes
forge init --profile standard --yes
forge init --profile full --yes
```

`forge init --yes` uses `standard`. `forge setup --minimal` is a shortcut for clean repositories that only need the minimal adoption config and do not want Beads or agent files installed yet.

## Profiles

| Profile | Purpose | Output |
|---------|---------|--------|
| `minimal` | Config-only adoption for a clean repository. | Writes `.forge/config.yaml`, disables workflow gates and adapters, and records template ancestry. |
| `standard` | Default Forge command flow metadata. | Writes `.forge/config.yaml` with default gates enabled and Beads/GitHub issue adapter metadata. |
| `full` | Explicit full scaffold. | Writes `.forge/config.yaml` with rails, gates, adapters, and protected paths made explicit. |

## Inspect The Result

```bash
forge options lint
forge options diff
forge options stages --json
```

The generated config includes `template.kind`, `template.version`, `template.profile`, and `template.ancestry` so users can see which scaffold produced the current defaults.

## Non-Scope

This flow does not implement harness translation, adapter marketplace installation, upgrade or rollback, or patch intent.
