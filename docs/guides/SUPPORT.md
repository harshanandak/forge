# Support And Troubleshooting

Start here when Forge setup, Beads, protected state, GitHub sync, worktrees, validation, or release readiness fails.

## First Checks

```bash
git status --short --branch
git remote show origin
bun --version
node --version
bun run check
```

If the failure involves Beads:

```bash
bd doctor
bd dolt status
forge sync
```

If `forge` wrappers fail because Beads is unavailable, use direct `git`, `gh`, and `bd` commands only after identifying the source of truth.

For branch-specific checks, resolve the default branch first:

```powershell
$defaultBranch = git remote show origin | Select-String 'HEAD branch' | ForEach-Object { $_.ToString().Split(':')[-1].Trim() }
```

## FAQ

### Is DeepWiki the source of truth?

No. DeepWiki is generated from the repository. Fix README, CHANGELOG, quickstart, docs, CLI files, and tests first, then refresh DeepWiki.

### Is Forge only the seven-stage TDD workflow?

No. The default template is TDD-first, but Forge is a runtime control plane with local state, gates, adapters, issue wrappers, validation evidence, and recovery surfaces.

### Are `/review` and `/verify` CLI commands?

They are agent workflow stages. Do not document them as `forge review` or `forge verify` unless those CLI commands exist in the current code.

### Does protected state always block edits?

Only when `scripts/protected-state-check.js` is wired into the active hook or CI path. The model is real, but enforcement depends on configuration.

### Can agents publish releases?

Agents can prepare a release PR and validation evidence. Publishing is out of scope unless the user explicitly requests it.

## Beads And Dolt Recovery

Common errors:

- `Beads is not initialized in this project.`
- `database "forge" not found on Dolt server`
- `database locked`
- stale `.beads/backup` data
- Windows EPERM or locked files during worktree cleanup

Triage:

```bash
bd doctor
bd dolt status
bd dolt pull
bd dolt push
```

If the Dolt server is serving the wrong database or data directory, stop and diagnose before closing or rewriting issue state. Use the root checkout when the feature worktree has an incomplete `.beads` runtime.

Recovery guidance:

- Preserve current state first: copy `.beads/backup` or export a Beads backup if the command is available.
- Prefer `forge sync` when Beads is configured and healthy.
- Use `bd close`, `bd comments`, or `bd dep` directly only for operations Forge does not wrap or when wrappers fail.
- If default branch protection blocks Beads metadata changes, route the metadata through a small follow-up PR.
- Do not hand-edit `.beads` live state unless a recovery procedure explicitly requires it.
- Success proof is concrete: `bd doctor` exits cleanly, `bd dolt status` is understandable, and `forge ready` or `forge show <id>` can read current issue state.

## GitHub Sync

`forge setup --sync` scaffolds GitHub/Beads sync support. `forge sync` runs Beads/Dolt sync operations. These are different surfaces.

Modern sync should use snapshot or backup files, not stale examples that edit live `.beads/issues.jsonl` directly.

When sync fails:

```bash
gh auth status
bd doctor
bd dolt status
```

```powershell
gh run list --branch $defaultBranch --limit 10
```

Check whether GitHub owns the field you are trying to update. GitHub owns shared remote issue fields; Forge/Beads owns local workflow context and recovery metadata.

## Worktrees

Create isolated work:

```bash
forge worktree create <slug> --branch <branch-name>
```

Remove it:

```bash
forge worktree remove <slug>
```

If removal fails on Windows:

1. Stop any active `node`, `bun`, `gh`, or Dolt process using the worktree.
2. Run `git worktree list`.
3. Prove the branch is preserved: `git status --short --branch` and `git log --oneline -1`.
4. Retry `forge worktree remove <slug>`.
5. If Git already unregistered the worktree but files remain locked, wait for the process to exit before deleting the leftover directory.

Never delete a worktree before verifying that its branch is pushed or intentionally disposable.

## Branch Protection

Branch protection can reject direct pushes to `master` or `main` with `GH006`. That is expected for code changes.

Known exception: Beads-only metadata may need a protected sync path or follow-up PR, depending on repository rules.

Recovery:

```bash
git status --short --branch
gh pr checks <pr-number>
```

```powershell
git fetch origin $defaultBranch
```

If metadata cannot land directly, create a narrow follow-up branch for the state update.

## Rollback And Recovery Paths

Choose the rollback path by surface:

- Docs PR confusion: revert the docs PR or open a corrective docs PR. Do not publish while README, CHANGELOG, Quickstart, and release docs disagree.
- Setup-generated files: rerun `forge setup --dry-run` first, then rerun setup with the intended `--merge` mode. Preserve existing instruction files before replacing them.
- Beads metadata: prefer `forge sync` or a narrow follow-up PR. Avoid direct `.beads` edits unless a documented recovery path requires them.
- Failed GitHub sync commit: inspect the workflow run, preserve the generated backup or snapshot, then replay through the configured sync workflow or a follow-up branch.
- Worktree cleanup: prove the branch is pushed or disposable before removal, then remove through `forge worktree remove <slug>` or Git's worktree command if Forge is unavailable.

## Protected State

Protected surfaces include `.beads`, `.forge`, generated agent harness files, workflows, lockfiles, extension manifests, secrets, immutable Git internals, and append-only logs.

If a protected-state check blocks a file:

1. Read the repair hint.
2. Use the owning command or API surface.
3. For Forge-owned writes, set `FORGE_PROTECTED_STATE_ALLOWED_SURFACES` only for the surfaces that command owns.
4. For Beads metadata after merge, prefer a follow-up PR when branch protection blocks direct updates.

## Validation Failures

`bun run check` runs:

1. `bun run typecheck`
2. `bun run lint`
3. `bun audit`
4. `node scripts/test.js --validate`

Fix the first failing stage first. Do not hide a validation failure by documenting that it "should pass"; rerun the command and record the fresh result.

## Known Limitations

- Package version remains separate from docs readiness until release/publish occurs.
- `forge migrate` is dry-run only.
- Protected-state enforcement depends on hooks/CI wiring.
- Review adapters currently focus on review adapters and Greptile-shaped scaffolding.
- DeepWiki can lag after merge until refreshed.
- Some external services require credentials and branch protection setup outside Forge.
