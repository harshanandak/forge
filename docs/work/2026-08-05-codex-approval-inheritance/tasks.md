# Tasks

1. Add a failing test that rejects project-level Codex approval/sandbox policy.
2. Remove the tracked policy-only `.codex/config.toml` and make the test pass.
3. Run focused tests, lint, and validation.
4. Push and open one separate PR linked to `e377256c-c15b-49fc-ac0e-eb5d1f44344d`.
5. Verify a fresh worktree task inherits the explicit local policy; do not approve
   or mutate older pending tasks automatically.
