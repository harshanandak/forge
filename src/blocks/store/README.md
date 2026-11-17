# Forge store export

Consumer: the owner of a project, taking a verified backup before a tracker move with `forge store export --out <folder>`.
Enable the `forge/store` built-in block in `.forge/config.yaml` (`blocks: { store: { source: { builtin: forge/store } } }`).

The command never writes to the store. It opens the project store read-only and asks SQLite for a complete image with
`VACUUM INTO`, which reads inside one read transaction, so a concurrent writer cannot tear the copy. The counts,
high-water mark and schema version in `source.json` are read from that image, not from the live store. It refuses a
folder that is not empty and never overwrites a file.

The folder gets `backup.sqlite` and `source.json`. `source.json` holds `sha256` of the backup, `eventHighWaterMark`,
`records`, `at`, `schemaVersion` (the newest migration id), `tables` (row count per data table), `elapsedMs` and
`forgeVersion`. `tools/import-current.ts` reads both files directly: `--backup <folder>/backup.sqlite --manifest <folder>/source.json`.

The operation is for a person (`callers: ["human"]`), so it is not an MCP tool. It copies the whole store to disk,
including every record value, which an agent has no need to do.
