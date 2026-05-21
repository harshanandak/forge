# forge init Day-One Entry Door Tasks

Issue: forge-fvh9
Branch: codex/forge-init-day-one-entry

## Task 1: Init command parsing and day-one helpers

Files: `lib/commands/init.js`, `test/init-command.test.js`

TDD:

1. Add failing tests for classification parsing, harness target parsing, harness filesystem detection, and Layer 1 rail confirmation defaults.
2. Implement pure helpers in `lib/commands/init.js`.
3. Re-run the focused test until it passes.

Acceptance:

- Classification accepts only `critical`, `standard`, and `refactor`.
- Harness targets accept only `claude`, `cursor`, and `codex`.
- Detection reads `.claude`, `.cursor`, and `.codex` directories from a target root.
- Non-interactive defaults are deterministic.

## Task 2: Scaffold generated files with no-clobber behavior

Files: `lib/commands/init.js`, `test/init-command.test.js`

TDD:

1. Add failing tests for clean-repo generation of `.forge/config.yaml`, `.forge/patch.md`, and `.forge/protected-paths.yaml`.
2. Add failing tests proving existing files are not overwritten without `--force`.
3. Implement atomic-ish generation and no-clobber repair messages.
4. Re-run the focused test until it passes.

Acceptance:

- Clean repo init writes all three files.
- Existing generated files remain unchanged when `--force` is absent.
- Error output tells users to re-run with `--force` or move the existing file.

## Task 3: First-time wizard flow

Files: `lib/commands/init.js`, `test/init-command.test.js`

TDD:

1. Add failing tests using an injected prompt function for classification, Layer 1 confirmation, and harness target selection.
2. Implement prompt sequencing with default choices.
3. Re-run the focused test until it passes.

Acceptance:

- Interactive flow asks classification first, Layer 1 confirmation second, and harness target selection third.
- Empty answers use the displayed defaults.
- Declining Layer 1 confirmation fails with a repair message.

## Task 4: Day-one setup docs

Files: `docs/reference/TEMPLATES.md`

TDD:

1. Add or update assertions if an existing docs test covers template docs.
2. Update docs with the day-one command, generated files, harness detection, and no-clobber behavior.
3. Run focused docs-related tests or the nearest relevant test set.

Acceptance:

- Docs explain `forge init` as the fresh-repo entry door.
- Docs distinguish `forge init` from `forge new`.
- Docs state that protected paths are scaffolded, not enforced by this PR.
