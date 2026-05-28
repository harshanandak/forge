# Tasks

## Task 1: RED Tests

- Add protected path manifest tests for the default manifest, validator, YAML file, harness enforcement matrix, evidence JSON, and docs link.
- Run the focused test and confirm it fails before implementation.

## Task 2: Manifest Contract

- Add `.forge/protected-paths.yaml`.
- Add `lib/protected-path-manifest.js` with validator and evidence helpers.
- Add `scripts/spikes/protected-path-manifest.js`.

## Task 3: Documentation

- Add `docs/reference/PROTECTED_PATH_MANIFEST.md`.
- Link it from `docs/INDEX.md`.

## Task 4: Validation and Ship

- Run focused tests.
- Run `bun run check`.
- Commit, push, and open the PR.
