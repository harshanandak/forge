// Operator tool: reads an isolated local state backup and reports what converting its forge/work namespace for
// cloud restore would select (forge-1231). It is a dry run: it writes nothing, uses no network and never opens
// the home store. Writing the page files, the command line, the sequence map and the other-namespace inventory are follow-up slices.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { rowOf, type Row } from "../cloud/src/dump.ts";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { baseline, stateMigrations } from "../src/core/state/migrations.ts";
import {
  readRows,
  STATE_TABLES,
  type StateTable,
} from "../src/core/state/rows.ts";
import type { SqlDatabase, SqlRow } from "../src/ports/store.ts";

export const TABLES = [
  ...(Object.keys(STATE_TABLES) as StateTable[]),
  "domain_cloud_requests",
] as const;
export type Table = (typeof TABLES)[number];

/** Rows, stored bytes (SQL column-byte measure) and the sha256 of the JSON of the rows in key order. */
export interface Totals {
  readonly rows: number;
  readonly bytes: number;
  readonly digest: string;
}
export interface Options {
  /** The isolated backup file, and the sha256 the lead recorded for it. */
  readonly backup: string;
  readonly digest: string;
  /** Test seam: runs after the rows are read and before the second digest check. */
  readonly afterRead?: () => void;
}
export interface Report {
  readonly status: "PASS" | "FAIL";
  readonly code: string | null;
  readonly detail: string | null;
  readonly selected: Readonly<Record<Table, Totals>>;
  readonly predictedFloorPairs: number;
}

const NAMESPACE = "forge/work";
const ISSUE_FLOOR = "issue:work-";
// Paths ignore case on Windows and macOS by default; only Linux is case-sensitive.
const isLive = (path: string): boolean =>
  new RegExp(
    "/\\.forge/state\\.sqlite$",
    process.platform === "linux" ? "" : "i",
  ).test(path.replaceAll("\\", "/"));
const SIDECARS = ["-wal", "-shm", "-journal"];
const identity = (path: string): string => {
  const { dev, ino } = statSync(path, { bigint: true });
  return `${dev}:${ino}`;
};
const FAMILY = /^((?:comment|link):[^:]+:)[1-9][0-9]*$/;
/** The family restore tallies from one event: a deleted key's own, or an allocation floor that was written; never a lease's. */
function eventFamily(key: string, body: unknown): string | undefined {
  let type: string;
  try {
    type = String((JSON.parse(String(body)) as { type?: unknown }).type);
  } catch {
    return undefined;
  }
  if (type.endsWith(":record.deleted@1")) return FAMILY.exec(key)?.[1];
  if (!type.endsWith(":record.updated@1") || !key.startsWith("allocation:"))
    return undefined;
  const prefix = key.slice("allocation:".length);
  return FAMILY.exec(`${prefix}1`)?.[1] === prefix ? prefix : undefined;
}
const STATE = TABLES.slice(0, 4) as StateTable[];

class Refusal extends Error {
  readonly code: string;
  /** Names a table and key, never a body. */
  readonly detail: string | null;
  constructor(code: string, detail: string | null = null) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}
const sha = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const plain = (row: SqlRow): SqlRow =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      typeof v === "bigint" ? Number(v) : v,
    ]),
  );

/** Streams rows into a count, their stored bytes and the digest of their JSON. */
function totals() {
  const hash = createHash("sha256").update("[");
  let rows = 0;
  let bytes = 0;
  return {
    add(row: SqlRow): void {
      hash.update((rows++ ? "," : "") + JSON.stringify(row));
      for (const value of Object.values(row))
        bytes += Buffer.byteLength(String(value));
    },
    end: (): Totals => ({
      rows,
      bytes,
      digest: hash.update("]").digest("hex"),
    }),
  };
}

interface Stored {
  id?: unknown;
  dependsOn?: unknown;
  parent?: unknown;
}
interface Issue {
  deps: string[];
  parent?: string;
}
/** A stored record wraps the issue in its `value`. */
function addIssue(issues: Map<string, Issue>, body: string): void {
  let value: Stored | undefined;
  try {
    value = (JSON.parse(body) as { value?: Stored }).value;
  } catch {
    // Falls through to the refusal below.
  }
  if (typeof value?.id !== "string") throw new Refusal("SOURCE_INCONSISTENT");
  if (issues.has(value.id)) throw new Refusal("GRAPH_DUPLICATE_ID");
  // An edge that is not a string, or a list of strings, is refused rather than dropped.
  const { dependsOn = [], parent } = value;
  const strings = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string");
  if (
    !strings(dependsOn) ||
    (parent !== undefined && typeof parent !== "string")
  )
    throw new Refusal("SOURCE_INCONSISTENT");
  issues.set(value.id, {
    deps: dependsOn,
    ...(typeof parent === "string" ? { parent } : {}),
  });
}
/** Every dependency and parent must be a selected issue; dependencies must not cycle (a parent may depend on its children). */
function checkGraph(issues: Map<string, Issue>): void {
  // An explicit stack keeps a chain of any depth off the call stack. 1 is on the path, 2 is finished.
  const colour = new Map<string, 1 | 2>();
  for (const [root, { parent }] of issues) {
    if (parent !== undefined && !issues.has(parent))
      throw new Refusal("GRAPH_MISSING_TARGET");
    if (colour.has(root)) continue;
    colour.set(root, 1);
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const deps = issues.get(top.id)!.deps;
      if (top.next === deps.length) {
        colour.set(top.id, 2);
        stack.pop();
        continue;
      }
      const id = deps[top.next++]!;
      if (!issues.has(id)) throw new Refusal("GRAPH_MISSING_TARGET");
      if (colour.get(id) === 1) throw new Refusal("GRAPH_CYCLE");
      if (!colour.has(id)) {
        colour.set(id, 1);
        stack.push({ id, next: 0 });
      }
    }
  }
  // An issue has one parent, so a parent chain is a path: meeting an issue twice on one path is a cycle.
  const settled = new Set<string>();
  for (const start of issues.keys()) {
    const path = new Set<string>();
    for (
      let id: string | undefined = start;
      id !== undefined && !settled.has(id);
      id = issues.get(id)!.parent
    ) {
      if (path.has(id)) throw new Refusal("GRAPH_CYCLE");
      path.add(id);
    }
    for (const id of path) settled.add(id);
  }
}

/** One pass over the selected rows; no row body is kept. */
function analyse(db: SqlDatabase): Omit<Report, "status" | "code" | "detail"> {
  const selected = {} as Record<Table, Totals>;
  const keys = new Set<string>();
  const observed = new Set<string>();
  const issues = new Map<string, Issue>();
  for (const table of STATE) {
    const sum = totals();
    for (const raw of readRows(db, table, NAMESPACE)) {
      let row: Row;
      try {
        row = rowOf(table, plain(raw));
      } catch (error) {
        // Local state allows values a cloud column does not (for example a body over 8 MiB).
        if (!(error instanceof ForgeFailure)) throw error;
        const at = STATE_TABLES[table].key;
        throw new Refusal("ROW_UNSUPPORTED", `${table} ${String(raw[at])}`);
      }
      sum.add(row);
      const key = String(row.key);
      if (table === "state_records") {
        keys.add(key);
        const family = FAMILY.exec(key)?.[1];
        if (family !== undefined) observed.add(family);
        if (key.startsWith("issue:")) addIssue(issues, String(row.body));
      } else if (table === "state_events") {
        const family = eventFamily(key, row.body);
        if (family !== undefined) observed.add(family);
      }
    }
    selected[table] = sum.end();
  }
  selected.domain_cloud_requests = totals().end();
  checkGraph(issues);
  const floors = [ISSUE_FLOOR, ...observed].filter(
    (prefix) => !keys.has(`allocation:${prefix}`),
  );
  return {
    selected,
    predictedFloorPairs: floors.length,
  };
}

export async function convert(options: Options): Promise<Report> {
  let path = resolve(options.backup);
  try {
    // The live store is refused by its own path and by where any link to it really leads.
    if (isLive(path)) throw new Refusal("SOURCE_LIVE_HOME");
    try {
      path = realpathSync.native(path);
    } catch {
      throw new Refusal("SOURCE_MISSING");
    }
    if (isLive(path)) throw new Refusal("SOURCE_LIVE_HOME");
    // A write-ahead log or a hot journal can change committed rows that the hash of this file does not cover.
    if (SIDECARS.some((suffix) => existsSync(path + suffix)))
      throw new Refusal("SOURCE_NOT_ISOLATED");
    let bytes: Buffer;
    let first: string;
    try {
      first = identity(path);
      bytes = readFileSync(path);
    } catch {
      throw new Refusal("SOURCE_MISSING");
    }
    if (sha(bytes) !== options.digest)
      throw new Refusal("SOURCE_DIGEST_MISMATCH");
    if (bytes.subarray(0, 15).toString() !== "SQLite format 3")
      throw new Refusal("SOURCE_UNSUPPORTED");
    // File-format bytes 18 and 19 are 2 in write-ahead log mode, and opening such a file can create -wal and -shm.
    if (bytes[18] === 2 || bytes[19] === 2)
      throw new Refusal("SOURCE_NOT_ISOLATED");
    const opened = await createSqliteStore(dirname(path)).open({
      path,
      readOnly: true,
    });
    if (!opened.ok) throw new Refusal("SOURCE_UNSUPPORTED");
    let found: ReturnType<typeof analyse>;
    try {
      const db = opened.handle.value;
      const names = db
        .all("SELECT name FROM sqlite_master WHERE type = 'table'")
        .map((row) => String(row.name));
      if (!STATE.every((table) => names.includes(table)))
        throw new Refusal("SOURCE_UNSUPPORTED");
      // The schema must be one this binary accepts (migrations.ts): version 0, the baseline, and only known ids.
      const known = new Set(stateMigrations.map((m) => m.id));
      const ledger = names.includes("state_migrations")
        ? db.all("SELECT id FROM state_migrations").map((r) => String(r.id))
        : [];
      if (
        Number(db.get("PRAGMA user_version")?.user_version ?? 0) !== 0 ||
        !ledger.includes(baseline.id) ||
        ledger.some((id) => !known.has(id))
      )
        throw new Refusal("SOURCE_UNSUPPORTED");
      for (const name of names.filter((n) => n.startsWith("domain_")))
        if (db.get(`SELECT 1 AS found FROM "${name}" LIMIT 1`) !== undefined)
          throw new Refusal("SOURCE_UNSUPPORTED");
      found = analyse(db);
    } finally {
      await opened.handle.close();
    }
    options.afterRead?.();
    // The same canonical file, with the same bytes, must still be there.
    try {
      if (
        realpathSync.native(path) !== path ||
        identity(path) !== first ||
        sha(readFileSync(path)) !== options.digest
      )
        throw new Refusal("SOURCE_CHANGED");
    } catch (error) {
      throw error instanceof Refusal ? error : new Refusal("SOURCE_CHANGED");
    }
    return { status: "PASS", code: null, detail: null, ...found };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const blank = totals().end();
    return {
      status: "FAIL",
      code: error.code,
      detail: error.detail,
      selected: Object.fromEntries(TABLES.map((t) => [t, blank])) as Record<
        Table,
        Totals
      >,
      predictedFloorPairs: 0,
    };
  }
}
