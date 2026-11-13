// Operator tool: converts an isolated local state backup of the forge/work namespace into forge-cloud-dump-page/1
// files (forge-1231). Without `out` it is a dry run that reads the backup and writes nothing. With `out` it
// writes page files, a sequence map and, last, a manifest. It never touches a project, a network or the home store.
import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  byteLength,
  emptyTables,
  limitsFrom,
  pageOf,
  rowOf,
  type Row,
} from "../cloud/src/dump.ts";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import {
  namespacesOf,
  readRows,
  STATE_TABLES,
  type StateTable,
} from "../src/core/state/rows.ts";
import type { SqlDatabase, SqlRow } from "../src/ports/store.ts";

export const TABLES = [
  "state_records",
  "state_events",
  "state_leases",
  "state_requests",
  "domain_cloud_requests",
] as const;
export type Table = (typeof TABLES)[number];
export type Status = "PASS" | "FAIL" | "INCOMPLETE" | "NOT_EXECUTED";

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
  /** With `out` the run writes page files, the sequence map and the manifest; without it the run is a dry run. */
  readonly out?: string;
  readonly pageBytes?: number;
  /** Test seam: runs after the rows are read and before the second digest check. */
  readonly afterRead?: () => void;
}
export interface Report {
  readonly status: Status;
  readonly code: string | null;
  readonly selected: Readonly<Record<Table, Totals>>;
  readonly excluded: Readonly<Record<string, Readonly<Record<string, Totals>>>>;
  readonly sequence: { readonly count: number; readonly digest: string };
  readonly predictedFloorPairs: number;
  readonly pages: number;
  readonly contentDigest: string;
  /** Capacity handoff: the largest selected row and each page's serialized bytes. */
  readonly largestRow: number;
  readonly pageSizes: readonly number[];
}

const NAMESPACE = "forge/work";
const VERSION = 1;
const ISSUE_FLOOR = "issue:work-";
const FAMILY = /^((?:comment|link):[^:]+:)[1-9][0-9]*$/;
const STATE = Object.keys(STATE_TABLES) as StateTable[];

class Refusal extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const sha = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");
const number = (value: SqlRow[string]): SqlRow[string] => {
  if (typeof value !== "bigint") return value;
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Refusal("SOURCE_INCONSISTENT");
  return Number(value);
};
const plain = (row: SqlRow): SqlRow =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k, number(v)]));

/** The rows of one namespace as plain numbers and strings, optionally checked against the dump value limits. */
function* scan(
  db: SqlDatabase,
  table: StateTable,
  ns: string,
  check: boolean,
): Generator<SqlRow> {
  for (const raw of readRows(db, table, ns)) {
    const row = plain(raw);
    yield check ? rowOf(table, row) : row;
  }
}
/** Streams rows into their count, stored bytes and digest, calling `each` on every row. */
function tally(
  rows: Iterable<SqlRow>,
  each: (row: SqlRow) => void = () => {},
): Totals {
  const hash = createHash("sha256").update("[");
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    hash.update((count ? "," : "") + JSON.stringify(row));
    for (const value of Object.values(row))
      bytes += Buffer.byteLength(String(value));
    count += 1;
    each(row);
  }
  return { rows: count, bytes, digest: hash.update("]").digest("hex") };
}

/** Parents and dependencies must point at live issues, ids must be unique and dependencies must not cycle. */
function checkGraph(
  issues: Map<string, { deps: string[]; parent?: string }>,
): void {
  for (const [, { deps, parent }] of issues)
    for (const target of parent === undefined ? deps : [parent, ...deps])
      if (!issues.has(target)) throw new Refusal("GRAPH_MISSING_TARGET");
  const state = new Map<string, boolean>();
  const visit = (id: string): void => {
    if (state.get(id) === false) throw new Refusal("GRAPH_CYCLE");
    if (state.has(id)) return;
    state.set(id, false);
    for (const next of issues.get(id)!.deps) visit(next);
    state.set(id, true);
  };
  for (const id of issues.keys()) visit(id);
}

interface Analysis {
  readonly selected: Record<Table, Totals>;
  readonly excluded: Record<string, Record<string, Totals>>;
  readonly sequence: { count: number; digest: string };
  readonly predictedFloorPairs: number;
  readonly largestRow: number;
}

/** One pass over the selected rows and a tally of every other namespace; no row body leaves this function. */
function analyse(db: SqlDatabase): Analysis {
  const keys = new Set<string>();
  const observed = new Set<string>();
  const issues = new Map<string, { deps: string[]; parent?: string }>();
  let largest = 0;
  const seen = (row: SqlRow): void => {
    largest = Math.max(largest, byteLength(row));
  };
  const selected = {} as Record<Table, Totals>;
  const map = createHash("sha256");
  let ordinal = 0;
  for (const table of STATE) {
    selected[table] = tally(scan(db, table, NAMESPACE, true), (row) => {
      seen(row);
      if (table === "state_records") {
        const key = String(row.key);
        keys.add(key);
        const family = FAMILY.exec(key)?.[1];
        if (family !== undefined) observed.add(family);
        if (key.startsWith("issue:")) {
          let body: { id?: unknown; dependsOn?: unknown; parent?: unknown };
          try {
            body = JSON.parse(String(row.body)) as typeof body;
          } catch {
            throw new Refusal("SOURCE_INCONSISTENT");
          }
          const id = String(body.id);
          if (issues.has(id)) throw new Refusal("GRAPH_DUPLICATE_ID");
          issues.set(id, {
            deps: Array.isArray(body.dependsOn)
              ? body.dependsOn.map(String)
              : [],
            ...(typeof body.parent === "string" ? { parent: body.parent } : {}),
          });
        }
      } else if (table === "state_events") {
        const family = FAMILY.exec(String(row.key))?.[1];
        if (family !== undefined) observed.add(family);
        ordinal += 1;
        map.update(`${String(row.sequence)},${ordinal}\n`);
      }
    });
  }
  selected.domain_cloud_requests = tally([]);
  const sequence = { count: ordinal, digest: map.digest("hex") };
  checkGraph(issues);
  const floors = [ISSUE_FLOOR, ...observed].filter(
    (prefix) => !keys.has(`allocation:${prefix}`),
  );
  const excluded: Record<string, Record<string, Totals>> = {};
  for (const ns of namespacesOf(db).filter((name) => name !== NAMESPACE))
    excluded[ns] = Object.fromEntries(
      STATE.map((table) => [table, tally(scan(db, table, ns, false))]),
    );
  return {
    selected,
    excluded,
    sequence,
    predictedFloorPairs: floors.length,
    largestRow: largest,
  };
}

/** Writes the page files and the sequence map into `dir`, one page held at a time; returns each file's digest. */
function emit(
  db: SqlDatabase,
  dir: string,
  budget: number,
): { files: Record<string, string>; sizes: number[] } {
  const files: Record<string, string> = {};
  const sizes: number[] = [];
  const mapFile = openSync(join(dir, "sequence-map.csv"), "w", 0o600);
  const mapHash = createHash("sha256");
  let ordinal = 0;
  function* rows(): Generator<{ t: number; row: Row }> {
    for (const [t, table] of TABLES.entries()) {
      if (t === 4) return;
      for (const row of scan(db, table as StateTable, NAMESPACE, true)) {
        if (table === "state_events") {
          ordinal += 1;
          const line = `${String(row.sequence)},${ordinal}\n`;
          writeSync(mapFile, line);
          mapHash.update(line);
          yield { t, row: { ...row, sequence: ordinal } };
        } else yield { t, row: row as Row };
      }
    }
  }
  const write = (page: number, content: ReturnType<typeof pageOf>): void => {
    const text = JSON.stringify(content);
    const name = `page-${String(page).padStart(6, "0")}.json`;
    writeFileSync(join(dir, name), text, { mode: 0o600 });
    files[name] = sha(text);
    sizes.push(Buffer.byteLength(text));
  };
  const source = rows();
  let page = 0;
  let used = 0;
  let tables = emptyTables();
  let cur = source.next();
  let ahead = cur.done ? cur : source.next();
  let last: { p: number; t: number; k: (string | number)[]; w: string } | null =
    null;
  while (!cur.done) {
    const { t, row } = cur.value;
    const name = TABLES[t]!;
    const list = tables[name]!;
    const here = {
      p: page + 1,
      t,
      k: [row[STATE_TABLES[name as StateTable].key]!],
      w: "",
    };
    const added = byteLength(row) + (list.length > 0 ? 1 : 0);
    if (
      byteLength(pageOf(page, emptyTables(), ahead.done ? null : here)) +
        used +
        added >
      budget
    ) {
      if (used === 0) throw new Refusal("DUMP_TOO_LARGE");
      write(page, pageOf(page, tables, last));
      page += 1;
      tables = emptyTables();
      used = 0;
      continue;
    }
    list.push(row);
    used += added;
    last = here;
    cur = ahead;
    ahead = cur.done ? cur : source.next();
  }
  write(page, pageOf(page, tables, null));
  closeSync(mapFile);
  files["sequence-map.csv"] = mapHash.digest("hex");
  return { files, sizes };
}

const digestsOf = (dir: string): Record<string, string> =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, sha(readFileSync(join(dir, name)))]),
  );

const empty = (code: string | null, status: Status): Report => ({
  status,
  code,
  selected: Object.fromEntries(
    TABLES.map((table) => [table, tally([])]),
  ) as Record<Table, Totals>,
  excluded: {},
  sequence: { count: 0, digest: "" },
  predictedFloorPairs: 0,
  pages: 0,
  contentDigest: "",
  largestRow: 0,
  pageSizes: [],
});

export async function convert(options: Options): Promise<Report> {
  const path = resolve(options.backup);
  const staging =
    options.out === undefined ? undefined : `${resolve(options.out)}.partial`;
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
    let done: Analysis;
    let emitted: ReturnType<typeof emit> | undefined;
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
      done = analyse(db);
      if (staging !== undefined) {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        emitted = emit(
          db,
          staging,
          Math.min(
            options.pageBytes ?? limitsFrom({}).pageBytes,
            8 * 1024 * 1024,
          ),
        );
      }
    } finally {
      await opened.handle.close();
    }
    options.afterRead?.();
    if (sha(readFileSync(path)) !== options.digest)
      throw new Refusal("SOURCE_CHANGED");
    const report = {
      ...done,
      status: "PASS" as const,
      code: null,
      pages: 0,
      contentDigest: "",
      pageSizes: [] as number[],
    };
    if (staging === undefined || emitted === undefined) return report;
    const contentDigest = sha(
      JSON.stringify({
        version: VERSION,
        source: options.digest,
        files: emitted.files,
      }),
    );
    const out = resolve(options.out!);
    writeFileSync(
      join(staging, "manifest.json"),
      JSON.stringify(
        {
          version: VERSION,
          source: options.digest,
          contentDigest,
          files: emitted.files,
          selected: done.selected,
          excluded: done.excluded,
          sequence: done.sequence,
          predictedFloorPairs: done.predictedFloorPairs,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const staged = digestsOf(staging);
    let exists = true;
    try {
      readdirSync(out);
    } catch {
      exists = false;
    }
    if (exists) {
      if (JSON.stringify(digestsOf(out)) !== JSON.stringify(staged))
        throw new Refusal("OUTPUT_MISMATCH");
      rmSync(staging, { recursive: true, force: true });
    } else renameSync(staging, out);
    return {
      ...report,
      pages: emitted.sizes.length,
      contentDigest,
      pageSizes: emitted.sizes,
    };
  } catch (error) {
    if (staging !== undefined)
      rmSync(staging, { recursive: true, force: true });
    const code = (error as { code?: unknown }).code;
    if (typeof code !== "string") throw error;
    return empty(code, "FAIL");
  }
}

export const exitCode = (report: Report): number =>
  report.status === "PASS" ? 0 : 1;

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      backup: { type: "string" },
      digest: { type: "string" },
      out: { type: "string" },
      "page-bytes": { type: "string" },
    },
  });
  const report = await convert({
    backup: values.backup ?? "",
    digest: values.digest ?? "",
    ...(values.out === undefined ? {} : { out: values.out }),
    ...(values["page-bytes"] === undefined
      ? {}
      : { pageBytes: Number(values["page-bytes"]) }),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode(report);
}
