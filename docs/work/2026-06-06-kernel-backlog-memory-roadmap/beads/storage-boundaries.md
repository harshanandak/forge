## Description
Document and enforce the storage authority split for Forge Kernel.

## Scope
- SQLite WAL broker is solo/local authority only.
- Team/multi-machine writes require serialized server authority.
- Beads/GitHub/Linear remain projections/import-export surfaces.
- Knowledge search indexes are rebuildable read models, not authority.

## Acceptance Criteria
- Roadmap/reference docs include storage class table.
- CLI/docs do not imply git/SQLite is safe for multi-machine writes.
- Future command guards can detect unsupported team-write mode.
- Tests or fixtures cover storage classification wording/drift where available.
