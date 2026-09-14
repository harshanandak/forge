# Tasks: transparent GitHub account routing

## Task 1: clone-local auto state and credential routing

OWNS: `lib/github-context.js`, `lib/commands/github.js`, `test/github-context.test.js`, `test/commands/github.test.js`

1. Add failing tests for explicit enable/disable, helper ownership, protocol
   filtering, selected account output, and secret-clean failures.
2. Add the smallest Git config and credential-protocol implementation.
3. Run the focused tests and lint for owned files.

## Task 2: opt-in gh proxy

OWNS: `lib/github-router.js`, `lib/gh-proxy.js`, `bin/forge.js`, `package.json`, `lib/commands/test.js`, `scripts/test.js`, `test/github-router.test.js`, `test/gh-proxy.test.js`

1. Add failing tests for unbound pass-through, bound selection, `gh auth`
   bypass, recursion prevention, argv/exit propagation, and package opt-in.
2. Implement the proxy and explicit router install by reusing the existing Forge
   entrypoint and account resolver.
3. Run focused tests, compiled parity, and package manifest checks.

## Task 3: user contract and validation

OWNS: `docs/reference/github-accounts.md`, `CHANGELOG.md`, `docs/research/github-account-auto-routing.md`, `docs/work/2026-09-14-github-account-auto-routing/**`

1. Document opt-in, normal launch behavior, rollback, and embedded-auth limit.
2. Run targeted tests, lint, manifest checks, and full validation.
3. Record stage evidence, commit, and ship one PR linked to the issue.
