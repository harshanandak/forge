// Measured capacity of the real-tracker import (forge-1040), run by Node: `node capacity.ts measure [shape...]`.
// Each shape is built through the real state owner, exported by the real paged export, and restored page by page
// through the real Project inside a worker thread with a hard V8 heap cap, reading that thread's own CPU time.
// This is a stand-in for one Durable Object isolate, not the isolate: nothing here measures the deployed service.
// `node capacity.ts pages <dir> [shape...]` only writes the pages, for the workerd phase of conformance.ts.
import assert from "node:assert/strict";
import { timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getHeapStatistics } from "node:v8";
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from "node:worker_threads";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { Project } from "../src/project.ts";
import type { DurableStorage } from "../src/store.ts";
import {
  COLUMNS,
  digests,
  type Expected,
  FLOOR,
  fold,
  KEYS,
  problems as compare,
  TABLES,
  tally,
} from "./digest.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) =>
      timingSafeEqual(a, b),
  });

const MIB = 1024 * 1024;
const NAME = "cap";
const NS = "forge/capacity";
const FROZEN = 1_800_000_000_000;
const CANDIDATE_BYTES = 32 * MIB;
// The real tracker, measured locally: rows per table and stored bytes of the four exported state tables.
const TRACKER = {
  records: 7_366,
  events: 12_425,
  leases: 1_093,
  requests: 1_858,
};
const TRACKER_BYTES = 27_156_389;
// A 96 MiB heap in all: 80 old space plus 16 young space. The proposed gates for one request.
const HEAP = {
  maxOldGenerationSizeMb: 80,
  maxYoungGenerationSizeMb: 16,
  stackSizeMb: 4,
};
const HEAP_LIMIT = 96 * MIB;
const CPU_LIMIT_MS = 10_000;
const WALL_LIMIT_MS = 60_000;
const queryBudget = (rows: number): number => 1_000 + 8 * rows;
const actor = { kind: "agent", id: "capacity" } as const;
const env = (extra: Record<string, string> = {}): Record<string, string> => ({
  FORGE_CLOUD_PROJECT: NAME,
  FORGE_CLOUD_ID_PREFIX: "forge",
  ...extra,
});

type Bindings =
  Parameters<DurableStorage["sql"]["exec"]> extends [string, ...infer B]
    ? B
    : never;
/** Durable Object style storage over node:sqlite, counting the statements it runs. */
function storageOf(db: DatabaseSync, count = { n: 0 }): DurableStorage {
  const values = new Map<string, unknown>();
  let depth = 0;
  return {
    sql: {
      exec: (statement, ...bindings: Bindings) => {
        count.n += 1;
        const rows = db
          .prepare(statement)
          .all(
            ...(bindings.map((b) =>
              b instanceof ArrayBuffer ? new Uint8Array(b) : b,
            ) as never[]),
          ) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
    transactionSync: (body) => {
      const outer = depth === 0;
      if (outer) db.exec("BEGIN");
      depth += 1;
      try {
        const result = body();
        depth -= 1;
        if (outer) db.exec("COMMIT");
        return result;
      } catch (error) {
        depth -= 1;
        if (outer) db.exec("ROLLBACK");
        throw error;
      }
    },
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => {
      values.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(values.delete(key)),
  };
}
const sqlOf = (db: DatabaseSync): SqlDatabase => ({
  exec: (sql) => {
    db.exec(sql);
  },
  run: (sql, p = []) => {
    const done = db.prepare(sql).run(...(p as never[]));
    return {
      changes: Number(done.changes),
      lastInsertRowid: done.lastInsertRowid,
    };
  },
  all: (sql, p = []) => db.prepare(sql).all(...(p as never[])),
  get: (sql, p = []) => db.prepare(sql).get(...(p as never[])),
  transaction: (body) => {
    db.exec("BEGIN");
    try {
      const result = body();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
});

// One project shape: distinct keys, updates of them, leases, and how many writes carry request ids. A fenced write
// holds its own lease and a read set; the value is what each write stores.
interface Shape {
  records: number;
  updates: number;
  leases: number;
  ids: number;
  fenced: boolean;
  floor: boolean;
  runs: number;
  value: (i: number, step: number) => unknown;
}
const text = (n: number): string => "x".repeat(n);
const nest = (levels: number, inner: unknown): unknown =>
  Array.from({ length: levels }).reduce<unknown>((v) => [v], inner);
const small = (i: number, step: number): unknown => ({ i, step });
const ceiling = (over: Partial<Shape>): Shape => ({
  records: 0,
  updates: 0,
  leases: 0,
  ids: 0,
  fenced: false,
  floor: false,
  runs: 2,
  value: small,
  ...over,
});
const withPad = (pad: (i: number) => number) => (i: number, step: number) => ({
  i,
  step,
  text: text(pad(i)),
});
// The largest legal text: 65,536 code points of a quote, a backslash, two multibyte characters and U+0001, six JSON characters each.
const BODY = '"\\é€' + "\u0001".repeat(65_532);

const BYTES_ROWS = 9_999;
const SHAPES: Record<string, () => Shape | Promise<Shape>> = {
  // The real tracker's row counts, with text sized so the four state tables hold about 27 MB.
  real: () =>
    ceiling({
      records: TRACKER.records,
      updates: TRACKER.events - TRACKER.records - TRACKER.leases,
      leases: TRACKER.leases,
      ids: TRACKER.requests - TRACKER.leases,
      fenced: true,
      runs: 3,
      value: withPad(() => 1_050),
    }),
  // A restore adds an issue number floor (one record and one event) when the dump has none, then measures the project
  // again. So 19,999 rows in, 20,000 out: both tables sit exactly on the candidate row cap after the floor.
  "rows-records": () => ceiling({ records: 19_999 }),
  // 9,999 acquisitions + 9,999 releases + one record event + the derived floor = 20,000 events.
  "rows-leases": () => ceiling({ records: 1, leases: 9_999 }),
  "rows-leases-over": () => ceiling({ records: 2, leases: 9_999, runs: 1 }),
  // Stored bytes at the candidate cap, to within one byte, with the supplied floor making 10,000 records and events, the old row cap.
  bytes: async () => {
    const base = ceiling({
      records: BYTES_ROWS,
      floor: true,
      value: withPad(() => 0),
    });
    const zero = await source(base);
    const empty = storedBytes(zero.db);
    zero.db.close();
    const each = Math.floor((CANDIDATE_BYTES - empty) / (2 * BYTES_ROWS));
    const rest = Math.floor(
      (CANDIDATE_BYTES - empty - 2 * BYTES_ROWS * each) / 2,
    );
    return { ...base, value: withPad((i) => each + (i === 0 ? rest : 0)) };
  },
  text: () =>
    ceiling({ records: 30, value: (i, step) => ({ i, step, body: BODY }) }),
  // The edge of the raw-text budget in every body: 32 levels of depth and 5,000 values (10 fixed values, 31 arrays, 4,959 scalars).
  edge: () =>
    ceiling({
      records: 500,
      value: () =>
        nest(
          30,
          Array.from({ length: 4_959 }, (_, j) => j % 10),
        ),
    }),
};

function build(owner: StateOwner, s: Shape): void {
  const revision: number[] = [];
  let ids = s.ids;
  // A supplied floor is a record and an event the restore then keeps as they are, so stored bytes are exact.
  if (s.floor)
    owner.put(
      "forge/work",
      "allocation:issue:work-",
      { prefix: "issue:work-", number: 0 },
      actor,
      { expectRevision: 0 },
    );
  const put = (i: number, fence?: { subject: string; generation: number }) => {
    const step = revision[i] ?? 0;
    const holder = { actor, session: { id: `s-${i}` } };
    owner.put(NS, `k-${i}`, s.value(i, step), actor, {
      expectRevision: step,
      ...(ids-- > 0 ? { requestId: `put-${i}-${step}` } : {}),
      ...(fence === undefined
        ? {}
        : {
            fence: { ...fence, holder },
            readSet: [{ key: "absent", expectRevision: 0 }],
          }),
    });
    revision[i] = step + 1;
  };
  for (let j = 0; j < s.leases; j += 1) {
    const holder = { actor, session: { id: `s-${j}` } };
    const lease = owner.acquire(
      NS,
      `lease-${j}`,
      holder,
      3_600_000,
      `acq-${j}`,
    );
    if (s.fenced && j < s.records)
      put(j, { subject: `lease-${j}`, generation: lease.generation });
  }
  for (
    let i = s.fenced ? Math.min(s.leases, s.records) : 0;
    i < s.records;
    i += 1
  )
    put(i);
  for (let u = 0; u < s.updates; u += 1) put(u % s.records);
}

async function source(shape: Shape) {
  const db = new DatabaseSync(":memory:");
  const project = new Project(
    { storage: storageOf(db) },
    env({ DUMP_MAX_ROWS: "100000", DUMP_MAX_BYTES: String(64 * MIB) }),
  );
  const issued = await project.fetch(
    new Request(`https://cap.example/p/${NAME}/devices`, {
      method: "POST",
      body: JSON.stringify({ device: "d", ttlMs: 3_600_000 }),
    }),
  );
  if (issued.status !== 200) throw new Error(`source setup: ${issued.status}`);
  build(new StateOwner(sqlOf(db), { now: () => FROZEN }), shape);
  return { db, project };
}

/** The stored bytes of every column of every row, summed by SQLite the way a restore bounds a project. */
function storedBytes(db: DatabaseSync): number {
  let sum = 0;
  for (const table of TABLES) {
    const sizes = COLUMNS[table]
      .map((c) => `LENGTH(CAST(${c} AS BLOB))`)
      .join(" + ");
    const row = db
      .prepare(`SELECT COALESCE(SUM(${sizes}), 0) AS n FROM ${table}`)
      .get() as { n: number };
    sum += row.n;
  }
  return sum;
}
const rowsOf = (db: DatabaseSync): Record<string, number> =>
  Object.fromEntries(
    TABLES.map((t) => [
      t,
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n,
    ]),
  );

function scan(db: DatabaseSync, t: ReturnType<typeof tally>): void {
  for (const table of TABLES)
    for (const row of db
      .prepare(
        `SELECT ${COLUMNS[table].join(", ")} FROM ${table} ORDER BY ${KEYS[table].join(", ")}`,
      )
      .iterate())
      fold(t, table, row);
}
/** What the source holds, by raw SQL over its own tables: a count and a digest of every row in dump order, per table. */
function expectOf(db: DatabaseSync): Expected {
  const t = tally();
  scan(db, t);
  const counted = rowsOf(db);
  for (const table of TABLES)
    if (t.rows[table] !== counted[table])
      throw new Error(
        `${table}: ${counted[table]} rows counted, ${t.rows[table]} read`,
      );
  const one = (sql: string, ...bind: string[]): number =>
    (db.prepare(sql).get(...bind) as { n: number }).n;
  return {
    floorSupplied:
      one(
        "SELECT COUNT(*) AS n FROM state_records WHERE namespace = ? AND key = ?",
        FLOOR.namespace,
        FLOOR.key,
      ) > 0,
    lastSequence: one(
      "SELECT COALESCE(MAX(sequence), 0) AS n FROM state_events",
    ),
    tables: digests(t),
  };
}
/** How a restored target differs from the source expectations; its generated floor rows are counted, not digested. */
function differences(db: DatabaseSync, expected: Expected): string[] {
  const t = tally(expected);
  scan(db, t);
  return compare(t, expected);
}

/** Every page of the real export, as the exact document a restore request carries. */
async function exported(project: Project): Promise<string[]> {
  const pages: string[] = [];
  let cursor = "start";
  for (;;) {
    const reply = await project.fetch(
      new Request(
        `https://cap.example/p/${NAME}/dump?cursor=${encodeURIComponent(cursor)}`,
      ),
    );
    const body = (await reply.json()) as {
      value?: { next: string | null };
      error?: { code: string };
    };
    if (reply.status !== 200 || body.value === undefined)
      throw new Error(`export page ${pages.length}: ${body.error?.code}`);
    pages.push(JSON.stringify(body.value));
    if (body.value.next === null) return pages;
    cursor = body.value.next;
  }
}

interface Meta {
  // Taken from the source tables before the export runs; every restored target is checked against it.
  expect: Expected;
  rows: Record<string, number>;
  stored: number;
  pages: number[];
  runs: number;
}
async function write(dir: string, name: string): Promise<Meta> {
  const shape = await SHAPES[name]!();
  const { db, project } = await source(shape);
  const expect = expectOf(db);
  const pages = await exported(project);
  const meta: Meta = {
    expect,
    rows: rowsOf(db),
    stored: storedBytes(db),
    pages: pages.map((p) => Buffer.byteLength(p)),
    runs: shape.runs,
  };
  db.close();
  mkdirSync(join(dir, name), { recursive: true });
  for (const [n, page] of pages.entries())
    writeFileSync(
      join(dir, name, `page-${String(n).padStart(4, "0")}.json`),
      page,
    );
  writeFileSync(join(dir, name, "meta.json"), JSON.stringify(meta));
  return meta;
}

interface Sample {
  run: number;
  page: number;
  last: boolean;
  status: number;
  code: string | undefined;
  wallMs: number;
  cpuMs: number;
  queries: number;
  committed: number;
  external: number;
  malloced: number;
}
interface Done {
  samples: Sample[];
  mismatches: string[];
}
/** The worker: restore the pages `runs` times into fresh targets. The first run is cold, the rest warm. A target that took
 * all its pages is compared with the source expectations before it is closed. */
async function restoreAll(): Promise<Done> {
  const { dir, runs, limits, expect, refuse } = workerData as {
    dir: string;
    runs: number;
    limits: Record<string, string>;
    expect: Expected;
    refuse: boolean;
  };
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("page-"))
    .sort();
  const samples: Sample[] = [];
  const mismatches: string[] = [];
  for (let run = 0; run < runs; run += 1) {
    const db = new DatabaseSync(":memory:");
    const count = { n: 0 };
    const storage = storageOf(db, count);
    const project = new Project({ storage }, env(limits));
    for (const [page, file] of files.entries()) {
      const body = readFileSync(join(dir, file), "utf8");
      const queries = count.n;
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      const reply = await project.fetch(
        new Request(`https://cap.example/p/${NAME}/restore`, {
          method: "POST",
          body,
        }),
      );
      const answer = await reply.text();
      const wallMs = performance.now() - started;
      const used = process.threadCpuUsage(cpu);
      const heap = getHeapStatistics();
      samples.push({
        run,
        page,
        last: page === files.length - 1,
        status: reply.status,
        code: (JSON.parse(answer) as { error?: { code: string } }).error?.code,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        queries: count.n - queries,
        committed: heap.total_physical_size,
        external: heap.external_memory,
        malloced: heap.peak_malloced_memory,
      });
      if (reply.status !== 200) {
        if (refuse) {
          assert.equal(
            page,
            files.length - 1,
            "only final releases cross the cap",
          );
          assert.equal(reply.status, 413);
          assert.equal(samples.at(-1)!.code, "RESTORE_TOO_LARGE");
          assert.notEqual(await storage.get("provisioned"), true);
          assert.ok(
            Object.values(rowsOf(db)).every((n) => n === 0),
            "refused restore leaves no rows",
          );
        }
        db.close();
        return { samples, mismatches };
      }
    }
    assert.equal(refuse, false, "release-only overflow must be refused");
    const wrong = differences(db, expect);
    if (wrong.length > 0) mismatches.push(`run ${run}: ${wrong.join("; ")}`);
    db.close();
  }
  return { samples, mismatches };
}

function inWorker(data: object): Promise<Partial<Done> & { error?: string }> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: data,
      resourceLimits: HEAP,
    });
    worker.once("message", (done: Done) => resolve(done));
    worker.once("error", (error: NodeJS.ErrnoException) =>
      resolve({ error: error.code ?? error.message }),
    );
  });
}
const pct = (xs: number[], q: number): number =>
  [...xs].sort((a, b) => a - b)[Math.ceil(q * xs.length) - 1]!;
const fmt = (xs: number[]): string =>
  `p50 ${pct(xs, 0.5).toFixed(0)} p95 ${pct(xs, 0.95).toFixed(0)} max ${Math.max(...xs).toFixed(0)}`;

/** Restores one written shape and prints its evidence; true when every gate holds. */
async function measure(
  dir: string,
  name: string,
  meta: Meta,
): Promise<boolean> {
  const limits = Object.fromEntries(
    ["DUMP_MAX_ROWS", "DUMP_MAX_BYTES", "DUMP_PAGE_BYTES"]
      .filter((k) => process.env[k] !== undefined)
      .map((k) => [k, process.env[k]!]),
  );
  const refuse = name === "rows-leases-over";
  if (name === "rows-leases" || refuse)
    assert.equal(
      meta.rows.state_events! + meta.rows.state_leases! + 1,
      20_000 + Number(refuse),
    );
  const done = await inWorker({
    dir: join(dir, name),
    refuse,
    runs: meta.runs,
    limits,
    expect: meta.expect,
  });
  const problems: string[] = [];
  const samples = done.samples ?? [];
  if (done.error !== undefined) problems.push(`worker failed: ${done.error}`);
  const refused = samples.find((s) => s.status !== 200);
  if (
    refused !== undefined &&
    !(
      refuse &&
      refused.last &&
      refused.status === 413 &&
      refused.code === "RESTORE_TOO_LARGE"
    )
  )
    problems.push(`page ${refused.page}: ${refused.status} ${refused.code}`);
  const total = Object.values(meta.rows).reduce((a, b) => a + b, 0);
  if (problems.length === 0) {
    const last = samples.filter((s) => s.last);
    if (Math.max(...samples.map((s) => s.cpuMs)) > CPU_LIMIT_MS)
      problems.push(`a request used over ${CPU_LIMIT_MS} ms of CPU`);
    if (Math.max(...samples.map((s) => s.wallMs)) > WALL_LIMIT_MS)
      problems.push(`a request took over ${WALL_LIMIT_MS} ms`);
    if (Math.max(...last.map((s) => s.queries)) > queryBudget(total))
      problems.push(`the final page ran over ${queryBudget(total)} queries`);
    if (Math.max(...samples.map((s) => s.committed)) > HEAP_LIMIT)
      problems.push("committed heap went over 96 MiB");
    const cold = last.filter((s) => s.run === 0);
    const warm = last.filter((s) => s.run > 0);
    console.log(
      `INFO capacity ${name}: rows ${JSON.stringify(meta.rows)}, stored ${meta.stored} bytes, ${meta.pages.length} pages (largest ${Math.max(...meta.pages)} bytes); ` +
        `final page cold wall ${cold.map((s) => s.wallMs.toFixed(0)).join("/")} ms cpu ${cold.map((s) => s.cpuMs.toFixed(0)).join("/")} ms, warm wall ${warm.map((s) => s.wallMs.toFixed(0)).join("/")} ms cpu ${warm.map((s) => s.cpuMs.toFixed(0)).join("/")} ms; ` +
        `all requests wall ms ${fmt(samples.map((s) => s.wallMs))}, cpu ms ${fmt(samples.map((s) => s.cpuMs))}; ` +
        `final page queries ${Math.max(...last.map((s) => s.queries))} (budget ${queryBudget(total)}); ` +
        `after-request indicators, not peaks: committed heap ${(Math.max(...samples.map((s) => s.committed)) / MIB).toFixed(1)} MiB, external ${(Math.max(...samples.map((s) => s.external)) / MIB).toFixed(1)} MiB, peak malloced ${(Math.max(...samples.map((s) => s.malloced)) / MIB).toFixed(1)} MiB; ` +
        `heap cap ${HEAP_LIMIT / MIB} MiB held`,
    );
  }
  // Accepting a restore on its HTTP status alone would let an export that drops rows pass.
  for (const wrong of done.mismatches ?? []) problems.push(`restored ${wrong}`);
  if (name === "real") {
    for (const [what, have, need] of [
      ["records", meta.rows.state_records!, TRACKER.records],
      ["events", meta.rows.state_events!, TRACKER.events],
      ["leases", meta.rows.state_leases!, TRACKER.leases],
      ["requests", meta.rows.state_requests!, TRACKER.requests],
      ["stored bytes", meta.stored, Math.floor(TRACKER_BYTES * 0.95)],
    ] as const)
      if ((have ?? 0) < need)
        problems.push(
          `the shape has ${have} ${what}, under the tracker's ${need}`,
        );
  }
  console.log(
    problems.length === 0
      ? `PASS capacity ${name}`
      : `FAIL capacity ${name}: ${problems.join("; ")}`,
  );
  return problems.length === 0;
}

/** The heap cap is real in this runner: a worker that keeps allocating is killed by it. */
async function capBinds(): Promise<boolean> {
  const done = await inWorker({ allocate: true });
  const ok = done.error === "ERR_WORKER_OUT_OF_MEMORY";
  console.log(
    ok
      ? "PASS capacity heap cap binds"
      : `FAIL capacity heap cap binds: the allocating worker ended with ${done.error ?? "no error"}`,
  );
  return ok;
}

/** The comparison is not blind: a copy that drops a row or changes one is reported. The wire journey shares it. */
function gateCatches(): boolean {
  const rows = [
    { namespace: "n", key: "a", revision: 1, body: "{}" },
    { namespace: "n", key: "b", revision: 1, body: "{}" },
  ];
  const skip = { floorSupplied: true, lastSequence: 0 };
  const of = (list: typeof rows) => {
    const t = tally(skip);
    for (const row of list) fold(t, "state_records", row);
    return t;
  };
  const expected: Expected = { ...skip, tables: digests(of(rows)) };
  const clean = compare(of(rows), expected).length === 0;
  const dropped = compare(of(rows.slice(0, 1)), expected).some((p) =>
    p.startsWith("state_records has 1 rows"),
  );
  const changed = compare(
    of([rows[0]!, { ...rows[1]!, body: "{ }" }]),
    expected,
  ).some((p) => p.includes("different content"));
  const ok = clean && dropped && changed;
  console.log(
    ok
      ? "PASS capacity gate reports a dropped row and a changed row"
      : `FAIL capacity gate reports a dropped row and a changed row: clean ${clean}, dropped ${dropped}, changed ${changed}`,
  );
  return ok;
}

if (!isMainThread) {
  const data = workerData as { allocate?: boolean };
  if (data.allocate) {
    const keep: string[] = [];
    for (;;) keep.push("x".repeat(MIB) + keep.length);
  }
  parentPort!.postMessage(await restoreAll());
} else {
  const [command = "measure", ...rest] = process.argv.slice(2);
  if (command === "pages") {
    const [dir, ...names] = rest;
    for (const name of names.length > 0 ? names : Object.keys(SHAPES)) {
      const meta = await write(dir!, name);
      console.log(
        `INFO pages ${name}: ${meta.pages.length} pages, rows ${JSON.stringify(meta.rows)}, stored ${meta.stored}`,
      );
    }
  } else {
    const dir = mkdtempSync(join(tmpdir(), "forge-capacity-"));
    let ok = gateCatches();
    ok = (await capBinds()) && ok;
    for (const name of rest.length > 0 ? rest : Object.keys(SHAPES))
      ok = (await measure(dir, name, await write(dir, name))) && ok;
    process.exitCode = ok ? 0 : 1;
  }
}
