# 0.0.15 adoption entrypoint tasks

## Task 1: Profile config scaffolds

TDD:
- Add tests that assert `minimal`, `standard`, and `full` profiles produce distinct `.forge/config.yaml` objects with ancestry metadata.
- Implement a small profile module that serializes config using runtime graph primitive ids already accepted by `lib/core/runtime-graph.js`.

Acceptance:
- Unknown profiles fail with a clear profile list.
- Generated YAML parses and passes runtime graph config lint.

## Task 2: `forge init` command

TDD:
- Add command tests that initialize a temp clean repo with `--profile minimal --yes`.
- Assert `.forge/config.yaml` exists, no Beads directory is required, and `forge options lint --json` succeeds against that repo.

Acceptance:
- `forge init --profile minimal|standard|full --yes` is non-interactive.
- Existing config is preserved unless `--force` is supplied.
- Command output tells users how to inspect the config without adding another inspection system.

## Task 3: Thin onboarding and setup alias

TDD:
- Add tests for `forge init --yes` defaulting to `standard`.
- Add tests for `forge setup --minimal` delegating to the minimal init profile without requiring Beads.

Acceptance:
- Interactive mode only selects a profile and then calls the same init path.
- `setup --minimal` remains an adoption shortcut, not a full setup replacement.

## Task 4: Docs refresh

TDD:
- Add docs checks or command tests proving documented profile names match exported profiles.

Acceptance:
- Add a template/profile reference doc for the shipped `forge init` flow.
- Cross-link it from `docs/INDEX.md` and setup docs.
- Explicitly list non-scope.
