# Tasks: optional repository-scoped GitHub account context

**Status:** Approved — execute in dev

**Issue:** `ee4869d5-77af-4959-909c-190e99b3ada0`

## Wave 1 — private context and explicit UX

### Task 1: Private GitHub context

**Owns:** `lib/github-context.js`, `test/github-context.test.js`

1. Write failing tests for clone-local `github.account`, safe-login validation, unbound behavior, named-token retrieval with `--hostname github.com --user`, case-insensitive live-login verification, missing/unsupported auth, and wrong ambient `GH_TOKEN`/`GITHUB_TOKEN`/`GH_HOST`.
2. Implement the minimum stdlib-only context. Unmarked callers do nothing; a marked unbound route performs one local Git-config lookup and no `gh`, network, or environment mutation.
3. Prove the credential is absent from public return values, diagnostics, stdout/stderr, serialization, and `process.env`, including thrown-error paths.

**Exit:** focused tests pass; the private context can run a `gh` child with a selected environment but exposes no credential-bearing public result.

### Task 2: `forge github` lifecycle and launcher

**Owns:** `lib/commands/github.js`, `bin/forge.js`, `lib/commands/test.js`, `scripts/test.js`, `test/commands/github.test.js`, `test/github-launcher.test.js`, `test/scripts/test-runner.test.js`, `skills/coverage.json`, `package.json`, `bun.lock`, generated `lib/commands/_manifest.js`

1. Write failing command tests for `use`, `status`, `status --json`, `run --`, and `unset`. Prove `use` prepares and verifies the supplied account before writing only clone-local `github.account`; failures leave any previous binding unchanged; missing accounts never trigger login/switch; status reports classified data only.
2. Add `cross-spawn` as a direct runtime dependency and test interactive launch on POSIX/direct executables, Windows `.exe`, Windows `.cmd`, missing programs, spaced arguments, metacharacter arguments, signals, and exit-code propagation without caller-built shell strings. Make the public parser stop interpreting options after `github run --`; prove child `--help`, `--version`, `-p`, and `--path=...` arguments arrive unchanged.
3. For `run`, set `GH_TOKEN`, `GITHUB_TOKEN`, and `GH_HOST=github.com` only on the explicit child. Add canaries for credential-bearing remotes, helper commands, subprocess errors, and JSON output.
4. Regenerate and drift-check the command manifest, map `github` to its normal owning skill in `skills/coverage.json`, and map both lifecycle and launcher suites into Forge's targeted-test selectors.

**Exit:** one-time clone binding and cross-harness launching work without changing native `gh` active-account state or leaking credentials.

## Wave 2 — central enforcement and foreground consumers

### Task 3: Registry metadata and guard

**Owns:** `lib/commands/_registry.js`, `test/commands/_registry-github-context.test.js`

1. Write failing tests for `githubAuth: true`, predicate true/false, invalid metadata, help bypass, unmarked commands, and context-preparation failure.
2. Validate metadata as absent, boolean, or function. After successful stage enforcement and before handler entry, resolve the private context and merge it into the handler-options seam without mutating `process.env`.
3. Prove local/unmarked commands perform no account lookup and marked unbound commands continue with existing behavior after one local Git-config lookup.

**Exit:** one registry path guards only declared GitHub routes and passes a private runner to handlers.

### Task 4: Foreground GitHub route matrix

**Owns:** `lib/commands/pr.js`, `lib/commands/ship.js`, `lib/commands/merge.js`, `lib/commands/shepherd.js`, `lib/commands/team.js`, `lib/commands/clean.js`, new secret-free `GH_CMD` bridge under `scripts/`, `test/commands/github-route-matrix.test.js`

1. Write failing routing tests for standalone and `pr` facade commands, clean's split Git/gh runner, and team predicates.
2. Mark `ship`, `merge`, and `shepherd`; mark `pr ship|merge|shepherd` but not `preflight`/help.
3. Guard team GitHub paths (`workload --me`, `add`, `verify`, `sync`, `claim`) while leaving bare/explicit-developer workload, `epic`, and help local.
4. Route only actual `gh` calls through the private runner. Use the existing `GH_CMD` executable seam with a checked-in, secret-free bridge that re-enters the same Forge runtime; never pass the selected credential to the mixed-purpose Bash dispatcher. Prove Git/test/helper children never receive the selected variables.

**Exit:** every supported foreground GitHub route is identity-checked and every unrelated child remains credential-free.

## Wave 3 — indirect consumers and concurrency

### Task 5: Background and indirect GitHub consumers

**Owns:** `lib/commands/push.js`, `lib/commands/hooks.js`, `lib/commands/serve.js`, `lib/commands/skill.js`, `lib/pr-monitor/reconcile-executor.js`, `web/dashboard/generate-snapshot.mjs`, `scripts/lib/behavioral-eval-runtime.js`, `test/commands/github-indirect-routes.test.js`

1. Write failing tests for push/session-start monitor wake, serve snapshot generation, and `skill eval --full` PR attribution.
2. Let detached monitor/watch children re-enter the public Forge CLI and prepare their own clone-local context; do not inherit a selected-token environment into the worker. Prepare once inside snapshot generation and route only its actual `gh` calls through the private runner; never expose the selected environment to Git/Forge descendants, browser openers, or unrelated children.
3. Keep static skill operations and non-session-start hook operations local. Prove every new background child is hidden/detached exactly as before and errors remain credential-clean.

**Exit:** indirect GitHub work honors the clone binding without broad process-environment mutation.

### Task 6: Concurrent isolation and public-surface boundary

**Owns:** `test/integration/github-account-context.test.js`, `test/structural/github-account-public-surface.test.js`

1. Create two temporary repositories and two fake named accounts; run bound GitHub children concurrently and assert each observes only its own login while neither credential appears in output.
2. Prove a wrong-account handler never starts, unbound behavior preserves the baseline, and wrong ambient token/host variables cannot redirect a bound route.
3. Lock the supported public entrypoints to package binaries that target `bin/forge.js`; record that direct `node bin/forge-cmd.js` is an internal legacy utility outside this feature's public guarantee.

**Exit:** deterministic integration evidence proves simultaneous isolation and the supported CLI boundary.

## Wave 4 — documentation and release evidence

### Task 7: User documentation and validation

**Owns:** one new guide under `docs/reference/`, minimal links from existing setup/support docs, `docs/work/2026-09-08-github-account-context/decisions.md`

1. Document the optional workflow, the separate API/commit/transport identities, the HTTPS-helper coupling, native SSH/HTTPS choices, Windows/macOS/Linux launch behavior, recovery, and CuraPod adoption examples.
2. Run focused tests, manifest drift, lint, the repository's resource-aware full-suite runner, and compiled-binary smoke tests on Windows. Require a POSIX CI launcher lane before merge.
3. Before release, record a redaction-safe manual acceptance receipt for two real stored accounts operating concurrently on the target Windows machine. Record labels and pass/fail only, never tokens.
4. Record exact commands/results in `decisions.md` and the Forge issue.

**Exit:** all required checks pass at the exact feature head and documentation matches the supported CLI.

## Delivery gate

After Tasks 1–7: run Forge validate, ship the linked PR, shepherd review/CI to green, merge under configured rules, verify the tracked remote merge, then begin CuraPod adoption. No CuraPod remote/auth migration is part of the Forge PR.
