# forge init Day-One Entry Door

Date: 2026-05-21
Issue: forge-fvh9
Branch: codex/forge-init-day-one-entry
Classification: Standard
Status: Plan locked

## Purpose

`forge init` should be the first command a fresh repository can run. It must create the minimum Forge skeleton without assuming a previous v2 install, while keeping the existing adoption-profile behavior compatible for scripted users.

## Success Criteria

- `forge init` scaffolds `.forge/config.yaml`, `.forge/patch.md`, and `.forge/protected-paths.yaml`.
- Running in a clean repository produces valid YAML config and protected-path manifests plus an empty patch file.
- Existing files are not overwritten unless `--force` is supplied, and the user-facing error names the safe repair command.
- Filesystem harness detection recognizes `.claude`, `.cursor`, and `.codex`.
- First-time interactive flow asks for classification, confirms Layer 1 rails, and lets the user select harness targets.
- Non-interactive defaults remain deterministic and testable.
- Docs describe day-one setup and generated files.

## Out Of Scope

- Protected state enforcement for 0.0.19.
- `forge new` onboarding wizard.
- Harness-specific command translation beyond recording selected targets.

## Design

Keep the command in `lib/commands/init.js` because registry dispatch already routes `forge init` through that module. Extend the module with small pure helpers so tests can exercise parsing, detection, generated content, and prompts without spawning the CLI.

The generated config will continue to use `renderAdoptionConfigYaml(profile)` as the base. Day-one selections then patch the parsed config before rendering:

- `workflow.classification.default`: `critical`, `standard`, or `refactor`.
- `layer1Rails.confirmed`: boolean confirmation recorded by the wizard or non-interactive default.
- `adapters.harness.targets`: selected harness targets.

Scaffold `.forge/protected-paths.yaml` as a manifest, not enforcement:

- version metadata.
- protected path entries for the generated Forge files and existing harness instruction files.
- selected harness targets.

Scaffold `.forge/patch.md` as an intentionally empty patch-intent file with a single heading and short comment. This is a placeholder, not the `forge patch` workflow.

## User-Facing Defaults

Non-interactive mode (`--yes`, profile shortcuts, or non-TTY stdin) uses:

- profile: `standard`.
- classification: `standard`.
- Layer 1 rails: confirmed.
- harness targets: explicit `--harness`, detected targets, explicit profile defaults, or `codex` when none are configured.

Interactive mode prompts only when no explicit flag is supplied.

## Validation

Focused validation first:

- `bun test test/init-command.test.js`
- `bun test test/adoption-profiles.test.js`

Full validation before ship:

- `/validate` freshness check against default branch.
- `bun run typecheck`
- `bun run lint`
- `bun test`
- security review: no command execution, path writes stay under `projectRoot/.forge`, no clobber by default.
