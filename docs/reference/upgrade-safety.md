# Upgrade Safety

Forge 0.0.16 upgrade safety is a foundation layer. It makes upgrade inputs reviewable and checks recoverable metadata before later releases add full install, rollback, and restore flows.

## Lockfile

`forge add <source> [--name <id>]` records extension source metadata in `forge.lock`.

Trusted local files inside the project root are hashed with SHA-512 SRI and can be rechecked:

```bash
forge add ./extensions/local.plugin.json --name local
forge audit verify
```

Remote and package locator strings such as `https:`, `gh:`, `gist:`, and `npm:` are untrusted by default. They are recorded only when the caller explicitly uses `--allow-untrusted`:

```bash
forge add gh:owner/repo/plugin --name plugin --allow-untrusted
```

Those entries are visible in `forge.lock` as explicit trust-policy records. This foundation does not fetch remote bytes for SRI verification.

## Audit Log

`forge add` appends a JSONL audit event to `.forge/log.jsonl`. The log is best-effort local evidence for reviewing lockfile changes. Beads remains the durable issue-state authority.

## Verification

`forge audit verify` rechecks all local lockfile integrity hashes:

- matching local content passes;
- missing or tampered local content fails;
- untrusted remote/package locators warn because this PR does not implement resolver-backed byte materialization.

## Upgrade Dry-Run

`forge upgrade --dry-run` is report-only. It reads:

- resolved runtime config health;
- patch intent record/orphan status;
- lock/trust state and integrity verification;
- recoverable self-heal candidates.

The dry-run does not write files.

## Self-Heal

`forge upgrade --self-heal` applies only safe metadata repairs:

- create missing `.forge/`;
- create missing `.forge/log.jsonl`.

It is idempotent and refuses unrecoverable integrity failures. It does not edit managed workflow files, apply patch intent diffs, install extensions, create rollback snapshots, or restore backups.

## Non-Scope

This PR intentionally does not implement rollback snapshots, full restore, marketplace allowlists, name-collision policy, resolver-backed downloads, or automatic patch application.

