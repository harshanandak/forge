export interface StatementProfile {
  kind: string;
  statement: string;
  calls: number;
  rows: number;
  reads: number;
}

export function recordWrite(
  profile: Map<string, StatementProfile> | undefined,
  sql: string,
  bindings: readonly unknown[],
  rows: number,
  reads: number,
): void {
  if (!profile) return;
  const statement = sql.replace(/\s+/g, " ").trim();
  let kind = /^(SELECT|WITH)\b/i.test(statement) ? "read queries" : "other SQL";
  if (/^(CREATE|ALTER|DROP)\b/i.test(statement)) {
    kind = /CREATE (?:UNIQUE )?INDEX/i.test(statement)
      ? "schema indexes"
      : /CREATE TRIGGER/i.test(statement)
        ? "schema triggers"
        : "schema tables";
  }
  const insert =
    /^INSERT INTO (state_records|state_events)\s*\(([^)]+)\)/i.exec(statement);
  if (insert) {
    const key =
      bindings[
        insert[2]!
          .split(",")
          .map((s) => s.trim())
          .indexOf("key")
      ];
    if (typeof key === "string")
      kind = key.startsWith("issue:work-")
        ? `${insert[1]} inserts`
        : key.startsWith("allocation:")
          ? "floor settlement"
          : key.startsWith("lane-control:")
            ? "restore stop"
            : "other state inserts";
  }
  const id = `${kind}\n${statement}`;
  const entry = profile.get(id) ?? {
    kind,
    statement,
    calls: 0,
    rows: 0,
    reads: 0,
  };
  entry.calls++;
  entry.rows += rows;
  entry.reads += reads;
  profile.set(id, entry);
}
