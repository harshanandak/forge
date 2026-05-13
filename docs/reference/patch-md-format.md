# patch.md Format

`patch.md` records user patch intent against stable Forge anchors. It is a reviewable markdown file, not an upgrade engine. Later upgrade and rollback work can consume these records to explain conflicts, preserve local edits, or refuse unsafe operations with a clear hint.

## Anchor Declaration

Managed files declare stable anchors with HTML comments:

```md
<!-- forge-anchor:stage.validate -->
```

The anchor ID is the durable identity. File paths can change. When a file is renamed, Forge scans the workspace and resolves the record to the file that still declares the anchor.

## Record Block

Each patch intent record is a markdown block with YAML metadata and a unified diff:

````md
<!-- forge-patch-intent:v1
id: patch_stage_validate_8f14e45fceea
anchorId: stage.validate
path: .claude/commands/validate.md
createdAt: 2026-05-13T00:00:00.000Z
source: git-diff
status: active
anchorLine: 3
baseAnchorHash: sha256:72a7d2a11b2ef199
-->
```diff
diff --git a/.claude/commands/validate.md b/.claude/commands/validate.md
--- a/.claude/commands/validate.md
+++ b/.claude/commands/validate.md
@@ -1,4 +1,4 @@
 # Validate
 <!-- forge-anchor:stage.validate -->
-Run checks.
+Run checks carefully.
```
<!-- /forge-patch-intent -->
````

Record IDs are deterministic from the anchor ID and diff body. Recording the same diff replaces the same block instead of appending duplicates.

## Example 1: Basic Edit

1. A managed file declares `<!-- forge-anchor:stage.dev -->`.
2. The user edits text below that anchor.
3. `forge patch record --from-diff` writes a record whose `anchorId` is `stage.dev` and whose diff can be reapplied to recreate the edit.

## Example 2: Rename

If `.claude/commands/validate.md` moves to `.codex/skills/validate/SKILL.md` but keeps `<!-- forge-anchor:stage.validate -->`, Forge resolves the record as `renamed` with `currentPath: .codex/skills/validate/SKILL.md`. Later upgrade code can use that resolved path instead of treating the patch as lost.

## Example 3: Orphan

If a record references `stage.ship` and no file declares that anchor, `forge patch status` reports it as orphaned. Later upgrade work should refuse to apply that record automatically and tell the user to re-record or restore the anchor.

## Config

`.forge/config.yaml` may configure patch intent:

```yaml
patchIntent:
  enabled: true
  path: .forge/patch.md
  anchorAliases:
    stage.old-validate: stage.validate
```

- `enabled: false` disables `forge patch record --from-diff`.
- `path` moves the record file.
- `anchorAliases` lets renamed anchors resolve without editing historical records.

## Later Upgrade and Rollback Safety

Upgrade can use patch intent records to decide whether a local edit is anchored, moved, or orphaned before touching managed files. Rollback can use the same metadata to explain which user edits were intentionally preserved. This baseline does not implement upgrade application, rollback snapshots, self-heal, marketplace, or adapter behavior.
