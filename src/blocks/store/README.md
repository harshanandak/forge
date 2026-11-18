# Forge store export

Consumer: the owner of a project, taking a verified backup before a tracker move with `forge store export --out <folder>`.
The command is available in a Forge project without enabling the store block.

The command never writes to the store. It opens the project store read-only and asks SQLite for a complete image with
`VACUUM INTO`, which reads inside one read transaction, so a concurrent writer cannot tear the copy. The counts
and schema version in `export-info.json`, and the high-water mark in `source.json`, are read from that image, not from the live store. It refuses a
folder that is not empty and never overwrites a file. If a write fails part way, it removes the files it created and nothing else.

The folder gets `backup.sqlite`, `source.json` and `export-info.json`. `source.json` has exactly the four keys the converter reads: `sha256` of the backup, `eventHighWaterMark`, `records` and `at`. `export-info.json` holds `schemaVersion` (the newest migration id), `tables` (row count per data table), `elapsedMs` and `forgeVersion`; nothing reads it. `tools/import-current.ts` reads the pair directly: `--backup <folder>/backup.sqlite --manifest <folder>/source.json`.

The operation is for a person (`callers: ["human"]`), so it is not an MCP tool. It copies the whole store to disk,
including every record value, which an agent has no need to do.
