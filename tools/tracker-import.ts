// Operator tool: converts an isolated local state backup of the forge/work namespace into forge-cloud-dump-page/1
// files (forge-1231). Without `out` it is a dry run that reads the backup and writes nothing. With `out` it
// writes page files, a sequence map and, last, a manifest. It never touches a project, a network or the home store.
import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  existsSync,
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
  /** With `out` the run writes page files, the sequence map and the manifest; without it the run is a dry run. */
  readonly out?: string;
  readonly pageBytes?: number;
  /** Test seam: runs after the rows are read and before the second digest check. */
  readonly afterRead?: () => void;
}
export interface Report {
  readonly status: "PASS" | "FAIL";
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

/** What the single pass over the selected rows learns; no row body is kept. */
interface Seen {
  readonly selected: Partial<Record<Table, Totals>>;
  readonly keys: Set<string>;
  readonly observed: Set<string>;
  readonly issues: Map<string, Issue>;
  readonly map: Hash;
  events: number;
  largest: number;
}

/**
 * The selected rows in dump order, one at a time, with each event's sequence replaced by its one-based position.
 * Dry run and generation both drive this pass, so what the report says is what the pages hold.
 */
function* select(
  db: SqlDatabase,
  seen: Seen,
  mapFile?: number,
): Generator<{ t: number; row: Row }> {
  for (const [t, table] of STATE.entries()) {
    const sum = totals();
    for (const raw of readRows(db, table, NAMESPACE)) {
      const row: Row = rowOf(table, plain(raw));
      sum.add(row);
      seen.largest = Math.max(seen.largest, byteLength(row));
      const key = String(row.key);
      const family = FAMILY.exec(key)?.[1];
      if (family !== undefined) seen.observed.add(family);
      if (table === "state_records") {
        seen.keys.add(key);
        if (key.startsWith("issue:")) addIssue(seen.issues, String(row.body));
      }
      if (table !== "state_events") {
        yield { t, row };
        continue;
      }
      seen.events += 1;
      const line = `${String(row.sequence)},${seen.events}\n`;
      seen.map.update(line);
      if (mapFile !== undefined) writeSync(mapFile, line);
      yield { t, row: { ...row, sequence: seen.events } };
    }
    seen.selected[table] = sum.end();
  }
}
function addIssue(issues: Map<string, Issue>, body: string): void {
  // A stored record wraps the issue in its `value`.
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

/** Cuts the rows into page files in `dir`, holding one page at a time; returns each page's size. */
function emit(
  rows: Generator<{ t: number; row: Row }>,
  dir: string,
  budget: number,
  files: Record<string, string>,
): number[] {
  const sizes: number[] = [];
  const write = (content: ReturnType<typeof pageOf>): void => {
    const text = JSON.stringify(content);
    const name = `page-${String(sizes.length).padStart(6, "0")}.json`;
    writeFileSync(join(dir, name), text, { mode: 0o600 });
    files[name] = sha(text);
    sizes.push(Buffer.byteLength(text));
  };
  let tables = emptyTables();
  let used = 0;
  let last: { p: number; t: number; k: (string | number)[]; w: string } | null =
    null;
  let cur = rows.next();
  let ahead = cur.done ? cur : rows.next();
  while (!cur.done) {
    const { t, row } = cur.value;
    const name = TABLES[t]!;
    const list = tables[name]!;
    const here = {
      p: sizes.length + 1,
      t,
      k: [row[STATE_TABLES[name as StateTable].key]!],
      w: "",
    };
    const added = byteLength(row) + (list.length > 0 ? 1 : 0);
    const envelope = pageOf(
      sizes.length,
      emptyTables(),
      ahead.done ? null : here,
    );
    if (byteLength(envelope) + used + added > budget) {
      if (used === 0) throw new Refusal("DUMP_TOO_LARGE");
      write(pageOf(sizes.length, tables, last));
      tables = emptyTables();
      used = 0;
      continue;
    }
    list.push(row);
    used += added;
    last = here;
    cur = ahead;
    ahead = cur.done ? cur : rows.next();
  }
  write(pageOf(sizes.length, tables, null));
  return sizes;
}

const digestsOf = (dir: string): string =>
  JSON.stringify(
    readdirSync(dir)
      .sort()
      .map((name) => [name, sha(readFileSync(join(dir, name)))]),
  );

export async function convert(options: Options): Promise<Report> {
  const path = resolve(options.backup);
  const out = options.out === undefined ? undefined : resolve(options.out);
  const staging = out === undefined ? undefined : `${out}.partial`;
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
    const seen: Seen = {
      selected: {},
      keys: new Set(),
      observed: new Set(),
      issues: new Map(),
      map: createHash("sha256"),
      events: 0,
      largest: 0,
    };
    const excluded: Record<string, Record<string, Totals>> = {};
    const files: Record<string, string> = {};
    let sizes: number[] = [];
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
      if (staging === undefined) {
        const rows = select(db, seen);
        while (!rows.next().done);
      } else {
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(staging, { recursive: true, mode: 0o700 });
        const mapFile = openSync(join(staging, "sequence-map.csv"), "w", 0o600);
        const budget = Math.min(
          options.pageBytes ?? limitsFrom({}).pageBytes,
          8 * 1024 * 1024,
        );
        sizes = emit(select(db, seen, mapFile), staging, budget, files);
        closeSync(mapFile);
      }
      for (const ns of namespacesOf(db).filter((name) => name !== NAMESPACE)) {
        const per: Record<string, Totals> = {};
        excluded[ns] = per;
        for (const table of STATE) {
          const sum = totals();
          for (const row of readRows(db, table, ns)) sum.add(plain(row));
          per[table] = sum.end();
        }
      }
    } finally {
      await opened.handle.close();
    }
    options.afterRead?.();
    if (sha(readFileSync(path)) !== options.digest)
      throw new Refusal("SOURCE_CHANGED");
    checkGraph(seen.issues);
    const floors = [ISSUE_FLOOR, ...seen.observed].filter(
      (prefix) => !seen.keys.has(`allocation:${prefix}`),
    );
    const sequence = { count: seen.events, digest: seen.map.digest("hex") };
    let contentDigest = "";
    if (staging !== undefined && out !== undefined) {
      files["sequence-map.csv"] = sequence.digest;
      contentDigest = sha(
        JSON.stringify({ version: 1, source: options.digest, files }),
      );
      writeFileSync(
        join(staging, "manifest.json"),
        JSON.stringify(
          { version: 1, source: options.digest, files, contentDigest },
          null,
          2,
        ),
        { mode: 0o600 },
      );
      if (existsSync(out)) {
        if (digestsOf(out) !== digestsOf(staging))
          throw new Refusal("OUTPUT_MISMATCH");
        rmSync(staging, { recursive: true, force: true });
      } else renameSync(staging, out);
    }
    return {
      status: "PASS",
      code: null,
      selected: Object.fromEntries(
        TABLES.map((table) => [table, seen.selected[table] ?? totals().end()]),
      ) as Record<Table, Totals>,
      excluded,
      sequence,
      predictedFloorPairs: floors.length,
      pages: sizes.length,
      contentDigest,
      largestRow: seen.largest,
      pageSizes: sizes,
    };
  } catch (error) {
    if (staging !== undefined)
      rmSync(staging, { recursive: true, force: true });
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
      pages: 0,
      contentDigest: "",
      largestRow: 0,
      pageSizes: [],
    };
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
