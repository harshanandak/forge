# Changelog

## 0.0.11

Forge 0.0.11 is the local-only stable release. Install the `forge-workflow`
package using Node 24.15 or later in the 24.x series, or Node 26 and later.
npm removed versions 0.0.2 through 0.0.10 and the earlier 0.1.0 prereleases.

- Use the same block catalog through the `forge` CLI, stdio MCP tools and generated
  agent skills. Import the delivery template to set up local issue tracking and
  run project checks that record receipts tied to a commit.
- Keep device memory across projects and use project-scoped memory where configured.
- Claims belong to a device and session. Renew and release reject malformed lease
  subjects. Forge detects a missing registered store and points to recovery.
- Export a local store for backup. A work lane that cannot remove its worktree
  reports the remaining cleanup so you can retry.

### Store upgrade and rollback

The state-store upgrade is one-way. Before upgrading, back up both the project
and device stores, then upgrade every Forge installation on the machine together.
Older builds can fail against upgraded stores. Retain migration
`003_device_session_identity`. To roll back, restore the pre-upgrade backups for
both stores and run the older build. See [claim identity](README.md#claim-identity)
for the upgrade details.
