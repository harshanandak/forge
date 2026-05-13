# 0.0.16 Patch Intent Decisions

## Decisions

- Patch intent records are markdown blocks in `.forge/patch.md` with YAML metadata plus a fenced unified diff.
- Record IDs are deterministic from anchor ID plus diff body so recording the same diff replaces the same block.
- Anchors are declared in managed files with HTML comments such as `<!-- forge-anchor:stage.validate -->`.
- Rename behavior is anchor-driven: if the recorded path disappears but the anchor is found elsewhere, the record resolves as renamed.
- `.forge/config.yaml` may set `patchIntent.enabled`, `patchIntent.path`, and `patchIntent.anchorAliases`.

## Deferred

- Upgrade application/self-heal.
- Rollback snapshot capture.
- Extension marketplace/adapters.

