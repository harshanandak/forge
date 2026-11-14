import { createHash } from "node:crypto";
import { ForgeFailure } from "../../contract/failure.ts";
import {
  validateBlockId,
  validateLeaseRecord,
} from "../../generated/validators.ts";
import type { SqlDatabase, SqlValue } from "../../ports/store.ts";
import { parseRestoreJson } from "./restore-json.ts";

/** Owner metadata, deliberately separate from the cloud v2 wire tables. */
export const checkpointTables = {
  state_checkpoint_header:
    "id INTEGER PRIMARY KEY CHECK(id=1), format_version INTEGER NOT NULL, lineage TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0), covered_sequence INTEGER NOT NULL CHECK(covered_sequence>=0), retention_policy_version INTEGER NOT NULL CHECK(retention_policy_version>0), archive_through INTEGER NOT NULL CHECK(archive_through>=0 AND archive_through<=covered_sequence)",
  state_checkpoint_live:
    "namespace TEXT NOT NULL, key TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), revision INTEGER NOT NULL CHECK(revision>0), digest TEXT NOT NULL, PRIMARY KEY(namespace,key)",
  state_checkpoint_deleted:
    "namespace TEXT NOT NULL, key TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), revision INTEGER NOT NULL CHECK(revision>0), PRIMARY KEY(namespace,key)",
  state_checkpoint_leases:
    "namespace TEXT NOT NULL, subject TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), generation INTEGER NOT NULL CHECK(generation>0), body TEXT NOT NULL, PRIMARY KEY(namespace,subject)",
  state_checkpoint_reservations:
    "namespace TEXT NOT NULL, prefix TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), number INTEGER NOT NULL CHECK(number>0), PRIMARY KEY(namespace,prefix,number)",
  state_checkpoint_floors:
    "namespace TEXT NOT NULL, prefix TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), highest INTEGER NOT NULL CHECK(highest>=0), PRIMARY KEY(namespace,prefix)",
  state_checkpoint_receipts:
    "namespace TEXT NOT NULL, request_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), fingerprint_digest TEXT NOT NULL, result_digest TEXT NOT NULL, PRIMARY KEY(namespace,request_id)",
  state_checkpoint_denied:
    "namespace TEXT NOT NULL, request_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), PRIMARY KEY(namespace,request_id)",
} as const;

/** Tuples use table column order, excluding the singleton header's SQL id. */
export interface Checkpoint {
  readonly header: readonly [
    formatVersion: 1,
    lineage: string,
    generation: number,
    coveredSequence: number,
    retentionPolicyVersion: number,
    archiveThrough: number,
  ];
  readonly live: readonly (readonly [
    namespace: string,
    key: string,
    sequence: number,
    revision: number,
    digest: string,
  ])[];
  readonly deleted: readonly (readonly [
    namespace: string,
    key: string,
    sequence: number,
    revision: number,
  ])[];
  readonly leases: readonly (readonly [
    namespace: string,
    subject: string,
    sequence: number,
    generation: number,
    body: string,
  ])[];
  readonly reservations: readonly (readonly [
    namespace: string,
    prefix: string,
    sequence: number,
    number: number,
  ])[];
  readonly floors: readonly (readonly [
    namespace: string,
    prefix: string,
    sequence: number,
    highest: number,
  ])[];
  readonly receipts: readonly (readonly [
    namespace: string,
    requestId: string,
    sequence: number,
    fingerprintDigest: string,
    resultDigest: string,
  ])[];
  readonly denied: readonly (readonly [
    namespace: string,
    requestId: string,
    sequence: number,
  ])[];
}

// s: nonempty text; e: prefix text; p: positive; z: nonnegative; d: SHA-256; b: lease body.
const shapes = {
  header: "pspzpz",
  live: "ssppd",
  deleted: "sspp",
  leases: "ssppb",
  reservations: "sepp",
  floors: "sepz",
  receipts: "sspdd",
  denied: "ssp",
} as const;
function invalid(message = "Invalid checkpoint"): never {
  throw new ForgeFailure({ code: "INPUT_INVALID", message, retry: "never" });
}
function canonical(value: unknown): string {
  const walk = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(walk)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, entry]) => [k, walk(entry)]),
          )
        : v;
  return JSON.stringify(walk(value));
}
function rowValid(
  value: unknown,
  shape: string,
): asserts value is (string | number)[] {
  if (!Array.isArray(value) || value.length !== shape.length) invalid();
  for (let i = 0; i < shape.length; i++) {
    const cell: unknown = value[i],
      rule = shape[i];
    if (rule === "p" || rule === "z") {
      if (
        typeof cell !== "number" ||
        !Number.isSafeInteger(cell) ||
        cell < (rule === "p" ? 1 : 0)
      )
        invalid();
    } else if (
      typeof cell !== "string" ||
      (rule !== "e" && !cell.length) ||
      !cell.isWellFormed() ||
      (rule === "d" && !/^sha256:[0-9a-f]{64}$/.test(cell))
    )
      invalid();
  }
}
/** Strict on fields, tuple widths, primary-key order and the coverage boundary. */
export function decodeCheckpoint(text: string): Checkpoint {
  let parsed: unknown;
  try {
    parsed = parseRestoreJson(text);
  } catch {
    return invalid();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    invalid();
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== Object.keys(shapes).sort().join())
    invalid();
  if (Array.isArray(value.header) && value.header[0] !== 1)
    invalid("Checkpoint format unsupported; newer Forge required");
  rowValid(value.header, shapes.header);
  const covered = value.header[3] as number;
  if ((value.header[5] as number) > covered) invalid();
  const live = new Set<string>();
  for (const [kind, shape] of Object.entries(shapes)) {
    if (kind === "header") continue;
    const rows = value[kind];
    if (!Array.isArray(rows)) invalid();
    let previous: (string | number)[] | undefined;
    for (const row of rows as unknown[]) {
      rowValid(row, shape);
      if (
        !validateBlockId(row[0]).ok ||
        (row[1] as string).length > 500 ||
        (row[2] as number) > covered
      )
        invalid();
      const key = [
        row[0]!,
        row[1]!,
        ...(kind === "reservations" ? [row[3]!] : []),
      ];
      if (previous) {
        const differing = key.findIndex(
          (cell, index) => cell !== previous![index],
        );
        const left = key[differing]!,
          right = previous[differing]!;
        // SQLite BINARY text order is UTF-8, not JavaScript's UTF-16 order.
        if (
          differing < 0 ||
          (typeof left === "string" && typeof right === "string"
            ? Buffer.compare(Buffer.from(left), Buffer.from(right)) < 0
            : left < right)
        )
          invalid();
      }
      previous = key;
      const identity = JSON.stringify(key);
      if (kind === "live") live.add(identity);
      if (kind === "deleted" && live.has(identity)) invalid();
      if (kind === "leases") {
        let lease: unknown;
        try {
          lease = parseRestoreJson(row[4] as string);
        } catch {
          return invalid();
        }
        if (!validateLeaseRecord(lease).ok) invalid();
        const body = lease as { subject: string; generation: number };
        if (
          body.subject !== row[1] ||
          body.generation !== row[3] ||
          canonical(lease) !== row[4]
        )
          invalid();
      }
    }
  }
  return value as unknown as Checkpoint;
}
export function encodeCheckpoint(value: Checkpoint): string {
  const checked = decodeCheckpoint(JSON.stringify(value));
  return canonical(checked);
}
export function checkpointDigest(value: Checkpoint): string {
  return `sha256:${createHash("sha256").update(encodeCheckpoint(value)).digest("hex")}`;
}

export interface CheckpointSeed {
  readonly coveredSequence: number;
  readonly live: Checkpoint["live"];
  readonly deleted: Checkpoint["deleted"];
  readonly receipts: Checkpoint["receipts"];
}

/** Trusted owner-side read. Missing tables in older images mean no checkpoint. */
export function readCheckpointSeed(
  db: SqlDatabase,
  pageSize: number,
): CheckpointSeed | undefined {
  const present = new Set(
    Object.keys(checkpointTables).filter((table) =>
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [
        table,
      ]),
    ),
  );
  const header = present.has("state_checkpoint_header")
    ? db.get("SELECT * FROM state_checkpoint_header WHERE id=1")
    : undefined;
  if (!header) {
    for (const table of present)
      if (db.get(`SELECT 1 FROM ${table} LIMIT 1`))
        invalid("Checkpoint entries require a header");
    return undefined;
  }
  for (const kind of ["leases", "floors", "reservations", "denied"])
    if (
      present.has(`state_checkpoint_${kind}`) &&
      db.get(`SELECT 1 FROM state_checkpoint_${kind} LIMIT 1`)
    )
      invalid(`Unsupported checkpoint ${kind} entries; newer Forge required`);
  if (present.size !== Object.keys(checkpointTables).length)
    invalid("Incomplete checkpoint tables");
  if (!Number.isSafeInteger(pageSize) || pageSize < 1)
    invalid("Invalid checkpoint page size");
  const read = (
    kind: string,
    columns: readonly string[],
    keys: readonly string[],
  ): SqlValue[][] => {
    const result: SqlValue[][] = [];
    let after: readonly SqlValue[] | undefined;
    for (;;) {
      const rows = db.all(
        `SELECT ${columns.join(",")} FROM state_checkpoint_${kind}${after === undefined ? "" : ` WHERE (${keys.join(",")}) > (${keys.map(() => "?").join(",")})`} ORDER BY ${keys.join(",")} LIMIT ?`,
        [...(after ?? []), pageSize],
      );
      for (const row of rows)
        result.push(
          columns.map((column) => {
            const cell = row[column]!;
            return typeof cell === "bigint" ? Number(cell) : cell;
          }),
        );
      if (rows.length < pageSize) return result;
      after = keys.map((column) => rows.at(-1)![column]!);
    }
  };
  const checkpoint = decodeCheckpoint(
    JSON.stringify({
      header: [
        "format_version",
        "lineage",
        "generation",
        "covered_sequence",
        "retention_policy_version",
        "archive_through",
      ].map((column) => {
        const cell = header[column];
        return typeof cell === "bigint" ? Number(cell) : cell;
      }),
      live: read(
        "live",
        ["namespace", "key", "sequence", "revision", "digest"],
        ["namespace", "key"],
      ),
      deleted: read(
        "deleted",
        ["namespace", "key", "sequence", "revision"],
        ["namespace", "key"],
      ),
      receipts: read(
        "receipts",
        [
          "namespace",
          "request_id",
          "sequence",
          "fingerprint_digest",
          "result_digest",
        ],
        ["namespace", "request_id"],
      ),
      leases: [],
      floors: [],
      reservations: [],
      denied: [],
    }),
  );
  return {
    coveredSequence: checkpoint.header[3],
    live: checkpoint.live,
    deleted: checkpoint.deleted,
    receipts: checkpoint.receipts,
  };
}

/** Trusted owner-side inspection; older images may predate these tables. */
export function assertNoCheckpoint(db: SqlDatabase): void {
  for (const table of Object.keys(checkpointTables))
    if (
      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [
        table,
      ]) &&
      db.get(`SELECT 1 FROM ${table} LIMIT 1`)
    )
      invalid("Checkpoint data requires a newer Forge");
}
