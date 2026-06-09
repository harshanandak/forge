## Description
Keep Beads/Dolt compatibility safe while Kernel becomes authority.

## Scope
- Preserve unsupported Beads fields under projection/extension metadata.
- Keep import/export dry-run and fidelity reports mandatory.
- Compare dependency/ready-work behavior before retiring Beads runtime assumptions.
- Document rollback boundaries.

## Acceptance Criteria
- Adapter conformance tests cover unsupported fields and round-trip preservation.
- Fidelity report flags gaps rather than silently dropping fields.
- Projection failures never override Kernel authority.
