# Forge 0.1.0 Restructuring Development Decisions

## Decision 1

**Date**: 2026-08-09
**Task**: PR 1 lane B — issue-bound approval events
**Gap**: The issue proposed `forge control approve|status <id>`, while `forge control` already owns policy classification and `forge gate approve <issue-id> <gate-id>` already owns durable issue-bound human decisions. Adding approval verbs to `control` would create a second authority surface.
**Score**: 6/14; mandatory override — permission/security surface
**Route**: BLOCKED
**Choice made**: Keep `forge control` limited to mandatory/optional/permission policy configuration. Keep approval authority on the existing issue-bound gate event surface: `forge gate approve <issue-id> <gate-id>`. If bounded expiry is required, extend that existing event with `--ttl`; do not add project-scoped approval or a new `forge issue approve`/`forge control approve` command. Unscoped approval fails closed.
**Status**: RESOLVED
