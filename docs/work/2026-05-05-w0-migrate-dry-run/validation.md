# Validation

## Commands Run

```bash
bun test ./test/migrate-dry-run.test.js
```

Result: PASS, 6 tests passed.

```bash
npm run lint -- --quiet
```

Result: PASS. ESLint completed with only the existing Node `MODULE_TYPELESS_PACKAGE_JSON` warning for `eslint.config.js`.

```bash
node bin/forge.js migrate --dry-run
```

Result: PASS. The report validated branch `codex/w0-migrate-dry-run`, parsed 260 Beads issues from `.beads/issues.jsonl`, found `forge-0uo0` with `status=open`, validated 6 workflow classifications from `lib/workflow/stages.js`, projected the Beads adapter as `dolt`, and rendered planned diffs for `.forge/config.yaml`, `.forge/patch.md`, and `forge.lock`.

```bash
node bin/forge.js migrate --dry-run --fixture-corpus
```

Result: PASS for the repo dry-run. Fixture corpus execution reported 4 passing fixtures and 1 intentional failure:

- `clean-v2-install`: PASS
- `no-lefthook-installed`: PASS
- `non-master-default-branch`: PASS
- `stale-worktrees`: PASS
- `broken-beads-state`: FAIL, malformed `.beads/issues.jsonl:2`

```bash
git status --short
```

Result after dry-run commands: only intended source/test/doc changes were present. No dry-run output files were written to the repo.

## Full Suite Attempt

```bash
bun test --timeout 15000
```

Result: NOT PASS. The run exceeded the 120 second command timeout after surfacing an existing failure in `test/scripts/beads-upgrade-smoke.test.js` (`summary.json` missing in the mocked unparseable-create rollback test). The run also generated `.beads` test side effects, which were removed before committing.

## Notes

- Non-dry-run migration intentionally fails with: `Only forge migrate --dry-run is implemented in the Wave 0 PoC.`
- The fixture corpus is source-tree-only. Packaged installs that do not include `test/fixtures/v2-corpus` report a TODO/blocker note while keeping the default dry-run available.
- Harness parity and skill auto-invoke behavior were not implemented in this PR.
