# State schema

The fresh 0.1.0 baseline and ledger executor are in `src/core/state/migrations.ts` so the compiled package contains them without reading a source checkout. The baseline contains only baseline columns. Each later column is introduced by its own ledgered migration; existing columns are checked before execution and rechecked after a failed ADD COLUMN. Other SQL failures propagate.

Domain registrations are trusted assembly inputs, reviewed with their owning first-party block. Outside blocks receive only a namespace-bound record client. Registrations supply ordered, uniquely named migrations and never a second database connection.
