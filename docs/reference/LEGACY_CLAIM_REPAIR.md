# Legacy Claim Repair

This is an explicit operator tool for the one-time pre-0.1.0 reconciliation of
legacy Kernel claim rows. It is not called by setup, startup, broker migrations,
claim acquisition, or any background process.

## Safety contract

- Always use an explicit, file-backed database path and a different backup path.
- The observation time is mandatory and must be one canonical UTC instant. Reuse
  that literal time for approval and apply.
- Dry-run does not mutate Kernel authority. It creates a separate SQLite backup,
  restores that backup into an isolated temporary database, and requires the
  restored snapshot digest to equal the source preflight digest. On POSIX
  systems, both the temporary and final backup are forced to owner-only `0600`
  permissions before the backup is accepted. On Windows, inherited access is
  removed and a private DACL for the current operator is applied and verified.
- The digest covers the complete Kernel database schema and every row in every
  authority table, while the report exposes only the digest and aggregate claim
  counts. Any intervening Kernel write invalidates approval.
- Preflight fails closed on integrity, foreign-key, schema/index, duplicate-row,
  state, timestamp, read faults, or active claims attached to unclaimable issue
  types.
- Apply requires the human-approved exact digest and the verified backup. It
  acquires `BEGIN IMMEDIATE`, re-reads the complete repair snapshot, rejects any
  digest drift, and compare-and-swaps every exact row before committing one
  privacy-safe receipt.
- Terminal issue state wins over expiry: its active claim becomes `released`.
  An expired active claim on nonterminal work becomes `reclaimable`. Valid
  unexpired leases and historical null-expiry leases remain active.
- Replaying the same approved digest returns the original receipt without another
  mutation. Any interruption before receipt commit rolls back the whole repair.

## Dry-run and approval

Choose the observation time once; do not substitute a moving clock between steps.

```powershell
bun scripts/legacy-claim-repair.js --dry-run `
  --database <absolute-kernel.sqlite> `
  --backup <absolute-separate-backup.sqlite> `
  --at <YYYY-MM-DDTHH:mm:ss.sssZ>
```

```bash
bun scripts/legacy-claim-repair.js --dry-run \
  --database <absolute-kernel.sqlite> \
  --backup <absolute-separate-backup.sqlite> \
  --at <YYYY-MM-DDTHH:mm:ss.sssZ>
```

Every dry-run requires a new, unused `--backup` path. Repeating a dry-run with
the same path fails closed instead of overwriting the immutable backup.

Review the privacy-safe counts, `preflight.digest`, `preflight.after_digest`, and
backup proof. Approval must name the exact `preflight.digest`.

## Apply (human-gated)

Do not run this command until the exact dry-run digest is explicitly approved.

```powershell
bun scripts/legacy-claim-repair.js --apply `
  --database <absolute-kernel.sqlite> `
  --backup <absolute-separate-backup.sqlite> `
  --at <same-literal-observation-time> `
  --approved-digest <approved-preflight-digest> `
  --actor <operator-id>
```

```bash
bun scripts/legacy-claim-repair.js --apply \
  --database <absolute-kernel.sqlite> \
  --backup <absolute-separate-backup.sqlite> \
  --at <same-literal-observation-time> \
  --approved-digest <approved-preflight-digest> \
  --actor <operator-id>
```

If an apply process is forcibly terminated, it may leave empty blocker
directories named `<backup>-wal`, `<backup>-shm`, and `<backup>-journal`. After
confirming that no repair process is still running, remove those stale
directories before verifying or reusing that backup. An already committed
receipt can still be replayed without this cleanup.

`CLAIM_REPAIR_BACKUP_POSTCOMMIT_DRIFT` means the repair and receipt committed,
but the named backup changed during commit. Do not discard the
`details.recovery_path` copy: it is the independently retained verified backup.
Fence writers and investigate the named path before any restore. Repeating the
same approved apply returns the committed receipt without mutating rows again.

A successful first apply also reports `receipt.recovery_path`, and its durable
receipt stores a privacy-safe `recovery_ref` suffix so a retry with the same
`--backup` path reconstructs the retained artifact after response loss. The
tool never automatically unlinks this owner-only independent copy after commit
because no final check can make a later unlink race-free. Keep it until the
named backup and receipt have been independently verified. A human may then
remove that exact reported recovery path after confirming that no repair
process is running.

On POSIX the recovery file and its parent directory entry are synced before the
authority transaction commits. Every receipt replay reopens the retained copy,
reapplies owner-only permissions, and verifies its exact digest and identity
before reporting success.

## Restore boundary

Restore is deliberately not automated. Fence every Kernel writer, stop Forge
processes, and close all database handles first. Preserve the failed database and
its `-wal`/`-shm` sidecars for diagnosis, then restore the separately verified
backup to a new path and run the same fixed-time dry-run there before replacing
authority. Never overwrite a live or open SQLite database.
