# Task List: forge-nlgg

- Design: `docs/plans/2026-04-24-forge-nlgg-design.md`
- Research: `docs/research/forge-nlgg.md`
- Issue: `forge-nlgg`
- Parent Epic: `forge-f3lx`
- Branch: `feat/f3lx`
- Worktree: `.worktrees/f3lx`

## Task 1: Define the normalized shared issue schema and authority matrix

File(s): `lib/issue-sync/schema.js`, `lib/issue-sync/authority.js`, `test/issue-sync/schema.test.js`, `test/issue-sync/authority.test.js`
OWNS: `lib/issue-sync/schema.js`, `lib/issue-sync/authority.js`, `test/issue-sync/schema.test.js`, `test/issue-sync/authority.test.js`
What to implement: Add the Forge-owned `SharedIssueRecord` shape plus helpers that classify each field as `github`, `forge`, or `cache`. The schema must include canonical identity, the shared-field set, sync bookkeeping, and explicit migration slots for legacy link hints.
TDD steps:
1. Write test: `test/issue-sync/schema.test.js` asserts a normalized record contains `github`, `shared`, `forge`, `cache`, and `sync` sections with stable defaults.
2. Run test: confirm it fails because the schema module does not exist.
3. Implement: `lib/issue-sync/schema.js` with record builders and default-value helpers.
4. Run test: confirm it passes.
5. Write test: `test/issue-sync/authority.test.js` asserts shared fields map to GitHub authority and workflow fields map to Forge authority.
6. Run test: confirm it fails on missing field-classification helpers.
7. Implement: `lib/issue-sync/authority.js` with field ownership lookups and guard helpers.
8. Run test: confirm it passes.
9. Commit: `feat: define normalized shared issue schema`
Expected output: Code can build a canonical shared record and answer "who owns this field?" deterministically.

## Task 2: Build canonical link resolution over current legacy sync markers

File(s): `lib/issue-sync/link-store.js`, `lib/issue-sync/legacy-link-bridge.js`, `test/issue-sync/link-store.test.js`, `test/issue-sync/legacy-link-bridge.test.js`
OWNS: `lib/issue-sync/link-store.js`, `lib/issue-sync/legacy-link-bridge.js`, `test/issue-sync/link-store.test.js`, `test/issue-sync/legacy-link-bridge.test.js`
What to implement: Create one canonical link store keyed by Forge issue ID and GitHub node/number, then add bridge code that can ingest existing `.github/beads-mapping.json`, `github_issue` state, sync comments, `externalRef`, and description URLs without creating duplicates.
TDD steps:
1. Write test: `test/issue-sync/link-store.test.js` asserts a link can be resolved by Forge issue ID, GitHub node ID, and GitHub number.
2. Run test: confirm it fails because the link store does not exist.
3. Implement: `lib/issue-sync/link-store.js` with canonical read/write helpers.
4. Run test: confirm it passes.
5. Write test: `test/issue-sync/legacy-link-bridge.test.js` seeds conflicting legacy link hints and expects one canonical record plus a drift diagnostic.
6. Run test: confirm it fails because there is no bridge layer.
7. Implement: `lib/issue-sync/legacy-link-bridge.js` with precedence rules and duplicate-collapsing logic.
8. Run test: confirm it passes.
9. Commit: `feat: add canonical GitHub link resolution`
Expected output: Any current legacy link source resolves to one stable Forge-owned mapping record.

## Task 3: Implement inbound GitHub pull and reconciliation primitives

File(s): `lib/issue-sync/github-pull.js`, `lib/issue-sync/reconcile.js`, `test/issue-sync/github-pull.test.js`, `test/issue-sync/reconcile.test.js`
OWNS: `lib/issue-sync/github-pull.js`, `lib/issue-sync/reconcile.js`, `test/issue-sync/github-pull.test.js`, `test/issue-sync/reconcile.test.js`
What to implement: Add pull-side primitives that normalize GitHub issue payloads into `SharedIssueRecord` inputs, reconcile GitHub-owned shared fields into the local cache, preserve Forge-owned fields, and emit drift diagnostics when stale local shared values differ from remote GitHub state.
TDD steps:
1. Write test: `test/issue-sync/github-pull.test.js` asserts a GitHub issue payload is normalized into the shared-field set used by Forge.
2. Run test: confirm it fails because no pull normalizer exists.
3. Implement: `lib/issue-sync/github-pull.js` with GitHub payload normalization helpers.
4. Run test: confirm it passes.
5. Write test: `test/issue-sync/reconcile.test.js` asserts GitHub-owned fields change on pull while Forge-owned workflow fields remain unchanged.
6. Run test: confirm it fails because there is no reconciler.
7. Implement: `lib/issue-sync/reconcile.js` with field-level authority enforcement and drift recording.
8. Run test: confirm it passes.
9. Commit: `feat: add inbound GitHub reconciliation primitives`
Expected output: Pulling a GitHub issue produces a reconciled local record without overwriting workflow-only state.

## Task 4: Project Forge write paths through the shared sync core

File(s): `lib/forge-issues.js`, `lib/commands/issues.js`, `lib/commands/_issue.js`, `lib/issue-sync/project-github.js`, `test/forge-issues-sync.test.js`, `test/commands/issues.test.js`, `test/commands/_issue.test.js`
OWNS: `lib/forge-issues.js`, `lib/commands/issues.js`, `lib/commands/_issue.js`, `lib/issue-sync/project-github.js`, `test/forge-issues-sync.test.js`
What to implement: Route shared-field mutations through the new sync core so Forge writes update the local backend first and queue outbound GitHub projections only when a shared field changes. Legacy wrappers such as `forge claim` must stop bypassing the shared authority layer for shared-field updates.
TDD steps:
1. Write test: `test/forge-issues-sync.test.js` asserts `runIssueOperation('create'|'update'|'close')` invokes the local backend and emits outbound GitHub projection only for shared-field changes.
2. Run test: confirm it fails because the sync projector does not exist.
3. Implement: `lib/issue-sync/project-github.js` and wire `lib/forge-issues.js` to use it.
4. Run test: confirm it passes.
5. Write test: extend `test/commands/_issue.test.js` so `forge claim` routes shared-field changes through the shared sync core instead of direct GitHub shell logic.
6. Run test: confirm it fails because the legacy wrapper still bypasses the new path.
7. Implement: the legacy wrapper bridge in `lib/commands/_issue.js`.
8. Run test: confirm command tests pass.
9. Commit: `feat: route Forge issue writes through shared sync core`
Expected output: Forge command writes have one local-first path and one outbound GitHub projection path for shared fields.

## Task 5: Collapse existing GitHub sync adapters onto the normalized core

File(s): `scripts/github-beads-sync/index.mjs`, `scripts/github-beads-sync/reverse-sync.mjs`, `scripts/github-beads-sync/mapping.mjs`, `scripts/forge-team/lib/sync-github.sh`, `test/scripts/github-beads-sync/index.test.js`, `test/scripts/github-beads-sync/reverse-sync.test.js`, `scripts/forge-team/tests/sync-github.test.sh`
OWNS: `scripts/github-beads-sync/index.mjs`, `scripts/github-beads-sync/reverse-sync.mjs`, `scripts/github-beads-sync/mapping.mjs`, `scripts/forge-team/lib/sync-github.sh`, `test/scripts/github-beads-sync/index.test.js`, `test/scripts/github-beads-sync/reverse-sync.test.js`, `scripts/forge-team/tests/sync-github.test.sh`
What to implement: Rework the current GitHub-facing scripts so they read and write through the canonical link store and reconciliation/projector helpers instead of directly depending on mapping files, description URLs, or `github_issue` state as primary identity.
TDD steps:
1. Write test: update `test/scripts/github-beads-sync/index.test.js` to assert opened/closed event handlers resolve links through the canonical link store instead of ad hoc mapping-only logic.
2. Run test: confirm it fails because the old script still depends on direct mapping/comment logic.
3. Implement: adapter wiring in `scripts/github-beads-sync/index.mjs` and `scripts/github-beads-sync/reverse-sync.mjs`.
4. Run test: confirm it passes.
5. Write test: extend `scripts/forge-team/tests/sync-github.test.sh` so shell-driven sync reads canonical shared records and stops assuming `github_issue` state is the source of truth.
6. Run test: confirm it fails because the shell adapter still reads direct state.
7. Implement: `scripts/forge-team/lib/sync-github.sh` as a thin adapter over the new normalized core.
8. Run test: confirm it passes.
9. Commit: `refactor: route GitHub sync adapters through normalized core`
Expected output: Existing automation uses the same shared link and reconciliation rules as Forge commands.

## Task 6: Expose import-ready pull/materialization primitives for forge-ij1

File(s): `lib/issue-sync/import-primitives.js`, `test/issue-sync/import-primitives.test.js`, `docs/BEADS_GITHUB_SYNC.md`
OWNS: `lib/issue-sync/import-primitives.js`, `test/issue-sync/import-primitives.test.js`, `docs/BEADS_GITHUB_SYNC.md`
What to implement: Publish a stable primitive layer for `forge-ij1` that can list remote GitHub issues, normalize them into shared records, resolve canonical links, and materialize local cache rows without a separate import-specific sync contract. Document the dependency explicitly.
TDD steps:
1. Write test: `test/issue-sync/import-primitives.test.js` asserts a remote GitHub issue page can be normalized and materialized into a local record using the same reconciliation path as steady-state pull.
2. Run test: confirm it fails because import primitives do not exist.
3. Implement: `lib/issue-sync/import-primitives.js` with `listRemoteIssues`, `normalizeRemoteIssue`, `resolveSharedLink`, and `materializeLocalIssue`.
4. Run test: confirm it passes.
5. Update docs: `docs/BEADS_GITHUB_SYNC.md` to describe the normalized core, field ownership, and the fact that `forge-ij1` depends on these primitives.
6. Commit: `docs: document import-ready sync primitives`
Expected output: `forge-ij1` can build initial GitHub backfill on the exact same normalize/reconcile/materialize flow used by ongoing sync.

## Ordering Notes

- Tasks 1-3 define the core contract and reconciliation behavior.
- Task 4 wires Forge command paths onto that contract.
- Task 5 migrates the existing GitHub-facing adapters.
- Task 6 intentionally lands last so `forge-ij1` builds on stable primitives instead of shaping them.

## Baseline Note

- Baseline validation in this worktree currently reports `719 pass / 36 skip / 1 fail` via `node scripts/test.js --validate`.
- The remaining pre-existing failure is `CLI Registry Integration > non-registry stage enforcement > forge verify still invokes stage enforcement outside the registry`.
- Because `/plan` is docs-only here, implementation can start with that baseline documented, but `/ship` should not ignore it.
