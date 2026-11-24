import { DatabaseSync } from "node:sqlite";

const path = process.argv[2];
if (!path) throw new Error("Expected a database path");

const db = new DatabaseSync(path);
db.exec(`
  PRAGMA wal_autocheckpoint=0;
  BEGIN IMMEDIATE;
  UPDATE meta SET value = '99' WHERE key = 'schema_version';
  INSERT INTO people (person_id, display_name) VALUES ('per_crash', 'Crash');
  COMMIT;
`);
process.exit(0);
