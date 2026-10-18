import type { SqlDatabase, SqlValue } from "../../ports/store.ts";
import { identifier } from "./migrations.ts";

export interface DomainTable {
  readonly namespace: string;
  readonly table: string;
  readonly reviewedDigest: string;
}
export interface DomainData extends DomainTable {
  readonly rows: readonly Readonly<Record<string, EncodedCell>>[];
}
export interface EncodedCell {
  readonly kind: "null" | "number" | "bigint" | "string" | "bytes";
  readonly value: string;
}

export function registerTables(
  db: SqlDatabase,
  domains: readonly DomainTable[],
): void {
  const names = new Set<string>();
  for (const domain of domains) {
    identifier(domain.table);
    if (!domain.table.startsWith("domain_") || names.has(domain.table))
      throw new Error(
        "Registered tables must be unique and start with domain_",
      );
    names.add(domain.table);
    if (
      !db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [
        domain.table,
      ])
    )
      throw new Error("Registered table is absent");
    const prior = db.get(
      "SELECT namespace,reviewed_digest FROM state_domains WHERE table_name=?",
      [domain.table],
    );
    if (
      prior &&
      (prior.namespace !== domain.namespace ||
        prior.reviewed_digest !== domain.reviewedDigest)
    )
      throw new Error("Registered table ownership changed");
    db.run(
      "INSERT OR IGNORE INTO state_domains(namespace,table_name,reviewed_digest) VALUES (?,?,?)",
      [domain.namespace, domain.table, domain.reviewedDigest],
    );
  }
}
export function exportTables(db: SqlDatabase): readonly DomainData[] {
  return db
    .all(
      "SELECT namespace,table_name,reviewed_digest FROM state_domains ORDER BY table_name",
    )
    .map((entry) => ({
      namespace: String(entry.namespace),
      table: String(entry.table_name),
      reviewedDigest: String(entry.reviewed_digest),
      rows: db
        .all(`SELECT * FROM ${identifier(String(entry.table_name))}`)
        .map((row) =>
          Object.fromEntries(
            Object.entries(row).map(([column, value]) => [
              column,
              encode(value),
            ]),
          ),
        ),
    }));
}
function encode(value: SqlValue): EncodedCell {
  if (value === null) return { kind: "null", value: "" };
  if (value instanceof Uint8Array)
    return { kind: "bytes", value: Buffer.from(value).toString("base64") };
  if (typeof value === "number")
    return { kind: "number", value: String(value) };
  if (typeof value === "bigint")
    return { kind: "bigint", value: String(value) };
  return { kind: "string", value };
}
