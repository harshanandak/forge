# Registry-safe Bun package repair

Issue: `351118da-5d87-404d-bb18-bdd3c784f93d`

## Task 1 — Prove and implement registry-safe internal runtime loading

Write failing focused tests first that prove the packed root manifest has no `@forge/*` name in `dependencies`, `devDependencies`, `bundledDependencies`, `optionalDependencies`, or `peerDependencies`, while repository runtime imports still resolve the workspace implementations. Then:

- replace root runtime `@forge/*` imports with private `#forge/contracts`, `#forge/memory`, and `#forge/flow` imports;
- map those private imports to workspace-first loaders under `lib/_internal/`;
- add a prepack generator that copies only allowlisted runtime files from the three workspaces into `lib/_internal/vendor/`, omits nested manifests/tests, rewrites vendor Flow/Memory Contracts imports to `#forge/contracts`, and cleans generated output after pack;
- remove root `@forge/*` dependency declarations and bundled dependency declarations without changing the standalone workspace package boundaries;
- preserve exact module-init errors and fall back only when the workspace target itself is absent.

Commit after RED, GREEN, focused regression, and self-review evidence.

## Task 2 — Close the registry-normalization smoke gap

Extend `test/integration/standalone-package-smoke.test.js` test-first so it runs real `npm pack` lifecycle scripts, extracts the resulting tarball, reads the packed `package/package.json`, and fails if any dependency field names an `@forge/*` package. Install that same tarball into separate clean npm and Bun projects. In both projects run:

- `forge --version`;
- `forge setup --quick --yes` in a fresh Git repository;
- a Node import of `forge-workflow/lib/pr-monitor/flow-monitor.js`.

Remove beta.8 assertions that expect bundled `node_modules/@forge/*` packages. The test and PR explanation must state that inspecting the packed manifest covers npm publish normalization, which the beta.8 source-manifest/local-tarball assertion missed.

Commit after RED, GREEN, focused smoke, and self-review evidence.

## Task 3 — Prepare beta.9 release metadata

Bump the root package to `0.1.0-beta.9`; update the structural version assertion, `CHANGELOG.md`, `docs/reference/RELEASE.md`, and `docs/guides/MIGRATION.md`. Correct the beta.8 claim without rewriting unrelated history. Run the focused release/package assertions and commit.

