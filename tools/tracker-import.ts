// Operator tool: reads an isolated local state backup and reports what converting its forge/work namespace for
// cloud restore would select (forge-1231). It is a dry run: it writes nothing, uses no network and never opens
// the home store. Writing the page files is a follow-up slice.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { byteLength, rowOf, type Row } from "../cloud/src/dump.ts";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import {
  namespacesOf,
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
  readonly selected: Readonly<Record<Table, Totals>>;
  readonly excluded: Readonly<Record<string, Readonly<Record<string, Totals>>>>;
  /** Selected events renumbered from one: their count and the sha256 of the `old,new` lines. */
  readonly sequence: { readonly count: number; readonly digest: string };
  readonly predictedFloorPairs: number;
  readonly largestRow: number;
}

const NAMESPACE = "forge/work";
const ISSUE_FLOOR = "issue:work-";
const FAMILY = /^((?:comment|link):[^:]+:)[1-9][0-9]*$/;
const STATE = TABLES.slice(0, 4) as StateTable[];

class Refusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
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
  issues.set(value.id, {
    deps: Array.isArray(value.dependsOn) ? value.dependsOn.map(String) : [],
    ...(typeof value.parent === "string" ? { parent: value.parent } : {}),
  });
}
/** Every dependency and parent must be a selected issue; dependencies must not cycle (a parent may depend on its children). */
function checkGraph(issues: Map<string, Issue>): void {
  const state = new Map<string, boolean>();
  const visit = (id: string): void => {
    const issue = issues.get(id);
    if (issue === undefined) throw new Refusal("GRAPH_MISSING_TARGET");
    if (state.get(id) === false) throw new Refusal("GRAPH_CYCLE");
    if (state.has(id)) return;
    state.set(id, false);
    issue.deps.forEach(visit);
    state.set(id, true);
  };
  for (const [id, { parent }] of issues) {
    if (parent !== undefined && !issues.has(parent))
      throw new Refusal("GRAPH_MISSING_TARGET");
    visit(id);
  }
}

/** One pass over the selected rows and a tally of every other namespace; no row body is kept. */
function analyse(db: SqlDatabase): Omit<Report, "status" | "code"> {
  const selected = {} as Record<Table, Totals>;
  const keys = new Set<string>();
  const observed = new Set<string>();
  const issues = new Map<string, Issue>();
  const map = createHash("sha256");
  let events = 0;
  let largest = 0;
  for (const table of STATE) {
    const sum = totals();
    for (const raw of readRows(db, table, NAMESPACE)) {
      const row: Row = rowOf(table, plain(raw));
      sum.add(row);
      largest = Math.max(largest, byteLength(row));
      const key = String(row.key);
      const family = FAMILY.exec(key)?.[1];
      if (family !== undefined) observed.add(family);
      if (table === "state_records") {
        keys.add(key);
        if (key.startsWith("issue:")) addIssue(issues, String(row.body));
      } else if (table === "state_events") {
        events += 1;
        map.update(`${String(row.sequence)},${events}\n`);
      }
    }
    selected[table] = sum.end();
  }
  selected.domain_cloud_requests = totals().end();
  checkGraph(issues);
  const excluded: Record<string, Record<string, Totals>> = {};
  for (const ns of namespacesOf(db).filter((name) => name !== NAMESPACE)) {
    const per: Record<string, Totals> = {};
    excluded[ns] = per;
    for (const table of STATE) {
      const sum = totals();
      for (const row of readRows(db, table, ns)) sum.add(plain(row));
      per[table] = sum.end();
    }
  }
  const floors = [ISSUE_FLOOR, ...observed].filter(
    (prefix) => !keys.has(`allocation:${prefix}`),
  );
  return {
    selected,
    excluded,
    sequence: { count: events, digest: map.digest("hex") },
    predictedFloorPairs: floors.length,
    largestRow: largest,
  };
}

export async function convert(options: Options): Promise<Report> {
  const path = resolve(options.backup);
  try {
    if (/\/\.forge\/state\.sqlite$/.test(path.replaceAll("\\", "/")))
      throw new Refusal("SOURCE_LIVE_HOME");
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new Refusal("SOURCE_MISSING");
    }
    if (sha(bytes) !== options.digest)
      throw new Refusal("SOURCE_DIGEST_MISMATCH");
    if (bytes.subarray(0, 15).toString() !== "SQLite format 3")
      throw new Refusal("SOURCE_UNSUPPORTED");
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
      for (const name of names.filter((n) => n.startsWith("domain_")))
        if (db.get(`SELECT 1 AS found FROM "${name}" LIMIT 1`) !== undefined)
          throw new Refusal("SOURCE_UNSUPPORTED");
      found = analyse(db);
    } finally {
      await opened.handle.close();
    }
    options.afterRead?.();
    if (sha(readFileSync(path)) !== options.digest)
      throw new Refusal("SOURCE_CHANGED");
    return { status: "PASS", code: null, ...found };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    const blank = totals().end();
    return {
      status: "FAIL",
      code,
      selected: Object.fromEntries(TABLES.map((t) => [t, blank])) as Record<
        Table,
        Totals
      >,
      excluded: {},
      sequence: { count: 0, digest: "" },
      predictedFloorPairs: 0,
      largestRow: 0,
    };
  }
}

export const exitCode = (report: Report): number =>
  report.status === "PASS" ? 0 : 1;

if (import.meta.main) {
  const { values } = parseArgs({
    options: { backup: { type: "string" }, digest: { type: "string" } },
  });
  const report = await convert({
    backup: values.backup ?? "",
    digest: values.digest ?? "",
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode(report);
}
