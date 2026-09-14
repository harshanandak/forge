# Tasks: transparent GitHub account routing

## Task 1: fail-closed clone state and fast credential routing

OWNS: `lib/github-context.js`, `lib/github-credential.js`, `test/github-context.test.js`, `test/github-credential.test.js`

1. Add failing tests for malformed or duplicate auto values and for credential
   resolution without a per-request live identity API call.
2. Make auto state tri-state and fail closed when present but invalid. Resolve a
   credential directly from the named native account while preserving secret-clean
   failures and environment scrubbing.
3. Run the focused tests and lint for owned files.

## Task 2: lightweight selected-account gh proxy

OWNS: `lib/gh-proxy.js`, `lib/native-gh.js`, `bin/forge.js`, `test/gh-proxy.test.js`, `test/native-gh.test.js`

1. Add failing tests for zero-argument/local-only bypass, malformed state,
   selected aliases/extensions, public-host refusal, and the latency-critical call
   graph.
2. Delete per-command live identity, help, alias, and extension discovery from the
   common path. Use the smallest dedicated entrypoint that preserves recursion
   prevention, child-only credentials, argv, exit code, and error behavior.
3. Run focused tests and the warm latency probes.

## Task 3: Windows-safe router and multi-clone lifecycle

OWNS: `lib/github-router.js`, `lib/commands/github.js`, `test/github-router.test.js`, `test/commands/github.test.js`

1. Add failing Windows tests for percent/caret/quote preservation and failing
   lifecycle tests for uninstall while another clone remains enabled.
2. Remove the second batch expansion, add the machine-local enabled-clone registry
   under the existing lock, and surface retryable lock errors and cleanup warnings.
3. Run the focused router and command tests on Windows-compatible fixtures.

## Task 4: installed-product and test-selection coverage

OWNS: `test/integration/github-account-context.test.js`, `lib/commands/test.js`, `scripts/test.js`

1. Add an installed PATH test that uses generated launchers and the real Forge
   routing chain across two concurrent clone-local identities.
2. Add every directly tested production module to both focused-test mappings.
3. Run the integration, mapping, compiled-parity, and package tests.

## Task 5: user contract, scope cleanup, and validation

OWNS: `docs/reference/github-accounts.md`, `CHANGELOG.md`, `docs/research/github-account-auto-routing.md`, `docs/work/2026-09-14-github-account-auto-routing/**`, `docs/work/2026-06-06-kernel-backlog-memory-roadmap/bd-call-site-kill-list.md`

1. Document opt-in, performance, supported hosts, aliases/extensions, safe global
   uninstall, normal launch behavior, rollback, and the embedded-auth limit.
2. Remove maintainer-specific examples and regenerate the required call-site
   census only for actual line shifts.
3. Run targeted tests, lint, manifest checks, and full validation exactly once
   after the focused lanes pass.
4. Record stage evidence, commit, update the existing PR, and settle all review
   threads at the exact head.
