# Adoption Templates

Forge templates are adoption scaffolds over runtime graph primitives. They are not the product surface: the generated `.forge/config.yaml` stays inspectable with `forge options`.

## Entry Point

```bash
forge init --profile minimal --yes
forge init --profile standard --yes
forge init --profile full --yes
```

`forge init --yes` uses `standard`. `forge setup --minimal` is a shortcut for clean repositories that only need the minimal adoption config and do not want Beads or agent files installed yet.

## Planning Template

`/plan` is represented as a configurable planning template in the runtime graph. The default template runs the full planning loop:

- `plan.intent_capture`
- `plan.parallel_research`
- `plan.parallel_critics`
- `plan.synthesis`
- `plan.final_lock`

Projects can tune planning depth in `.forge/config.yaml` without introducing another planner-specific config file:

```yaml
planning:
  template:
    mode: partial
    convergenceThreshold: 0.8
    criticSet:
      - spec
      - security
    partialInvocation:
      only:
        - plan.parallel_critics
      skip:
        - plan.parallel_research
```

Inspect the resolved behavior with:

```bash
forge options why plan.parallel_critics
forge options diff
forge options lint
```

Invalid planning modes, thresholds outside `0..1`, blank critics, and unknown planning sub-skills fail through `forge options lint`.

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
