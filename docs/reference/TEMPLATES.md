# Adoption Templates

Forge templates are adoption scaffolds over runtime graph primitives. They are not the product surface: the generated `.forge/config.yaml` stays inspectable with `forge options`.

## Entry Point

```bash
forge init
forge init --yes
forge init --profile minimal --classification standard --harness codex --yes
```

`forge init` is the day-one entry door for fresh repositories. It creates the local `.forge/` skeleton without assuming a prior v2 install or running the `forge new` onboarding wizard.

Generated files:

- `.forge/config.yaml` records the adoption profile, default classification, Layer 1 rail confirmation, and harness targets.
- `.forge/patch.md` is an empty patch-intent placeholder for future local overrides.
- `.forge/protected-paths.yaml` records the protected path manifest scaffold. Currently, only the manifest structure is generated; protected-state enforcement is not yet implemented.

When run interactively, `forge init` asks for:

- default classification: `critical`, `standard`, or `refactor`.
- Layer 1 rail confirmation.
- harness targets: `claude`, `cursor`, and/or `codex`.

Harness defaults are detected from filesystem markers where supported:

- `.claude` selects `claude`.
- `.cursor` selects `cursor`.
- `.codex` selects `codex`.

`forge init --yes` is deterministic for automation: it uses the `standard` profile, `standard` classification, confirms Layer 1 rails, and selects detected harness targets or `codex` when none are detected.

`forge init` does not overwrite existing generated files. Re-run with `--force` only when replacing `.forge/config.yaml`, `.forge/patch.md`, and `.forge/protected-paths.yaml` is intentional.

Profile shortcuts remain available:

```bash
forge init --minimal
forge init --standard
forge init --full
```

`forge setup --minimal` remains a separate shortcut for repositories that want setup behavior rather than only the day-one `.forge/` skeleton.

Stage commands such as `/review`, `/premerge`, and `/verify` are agent workflow stages. Do not present them as standalone `forge review`, `forge premerge`, or `forge verify` CLI commands unless those commands exist in the current CLI registry.

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
| `minimal` | Smallest adoption skeleton for a clean repository. | Writes the day-one `.forge/` files with workflow gates and issue adapters disabled unless selected later. |
| `standard` | Default Forge command flow metadata. | Writes the day-one `.forge/` files with default gates enabled and Beads/GitHub issue adapter metadata. |
| `full` | Explicit full scaffold. | Writes the day-one `.forge/` files with rails, gates, adapters, and protected paths made explicit. |

## Inspect The Result

```bash
forge options lint
forge options diff
forge options stages --json
```

The generated config includes `template.kind`, `template.version`, `template.profile`, and `template.ancestry` so users can see which scaffold produced the current defaults.

## Non-Scope

This flow does not implement harness translation, adapter marketplace installation, upgrade or rollback, guaranteed protected-state enforcement in every repository, `forge new`, or patch intent execution.
