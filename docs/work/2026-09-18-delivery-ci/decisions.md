# Delivery CI decisions

## D1: Preserve the affected-test boundary and propagate its result

- Replace the masked Node test command with the repository's established Bun command: `bun test --timeout 15000 test-env/`.
- Keep the existing `run_test_env` condition and whole-directory selection so all edge-case tests remain covered.
- Prove the failure chain at both executable boundaries: a failing Bun child returns nonzero, and the aggregate gate rejects `followup-tests=failure`.
- Edit the canonical workflow template and generate `.github/workflows/test.yml` only through the protected test-workflow writer.

## D2: Keep an unrelated planner-test timeout out of this lane

- A broader focused run passed 87 tests before the existing `.claude/commands/` planner case exceeded its 5-second test limit. Preserve that limit and track the independent diagnosis in issue `c64c2eaa-f4c7-4393-85b5-59be6e4aee7e`.
