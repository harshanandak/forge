// forge-1231 acceptance: the converter turns an isolated kernel backup into restorable pages. Every expectation is
// read from the fixture with plain SQL, never from the converter. Sources are synthetic and built in a temp dir.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dumpOf,
  limitsFrom,
  parseDump,
  restorePage,
  type Page,
} from "../../cloud/src/dump.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";
import {
  convert,
  exitCode,
  TABLES,
  type Table,
} from "../../tools/tracker-import.ts";

const NOW = 1_800_000_000_000;
const ISO = new Date(NOW).toISOString();
const WORK = "forge/work";
const ACTOR = { kind: "agent", id: "fixture" } as const;
const HOLDER = { actor: ACTOR, session: { id: "session" } };
const KEYS: Record<Table, string> = {
  state_records: "namespace, key",
  state_events: "sequence",
  state_leases: "namespace, subject",
  state_requests: "namespace, request_id",
  domain_cloud_requests: "request_id",
};
const COLUMNS: Record<Table, string> = {
  state_records: "namespace, key, revision, body",
  state_events: "sequence, namespace, key, body",
  state_leases: "namespace, subject, generation, body",
  state_requests: "namespace, request_id, fingerprint, result",
  domain_cloud_requests: "request_id, fingerprint, outcome, result",
};
type Row = Record<string, string | number>;
const sha = (text: string | Uint8Array): string =>
  createHash("sha256").update(text).digest("hex");
const sqlOf = (db: Database): SqlDatabase => ({
  exec: (sql) => void db.run(sql),
  run: (sql, params = []) => db.query(sql).run(...(params as never[])),
  all: (sql, params = []) =>
    db.query(sql).all(...(params as never[])) as SqlRow[],
  get: (sql, params = []) =>
    (db.query(sql).get(...(params as never[])) ?? undefined) as
      SqlRow | undefined,
  transaction: (body) => db.transaction(body)(),
});
const scratch = (): string => mkdtempSync(join(tmpdir(), "tracker-import-"));

interface Shape {
  /** Write the four allocation floors, or leave the history to carry the numbers. */
  floors: boolean;
  /** work-3 depends on these ids; the default is the coherent graph. */
  deps?: string[];
  /** A raw SQL statement applied to the finished backup. */
  tamper?: string;
}
const issue = (n: number, extra: object = {}) => ({
  id: `work-${n}`,
  prefix: "forge",
  title: `Issue ${n}`,
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: ISO,
  ...extra,
});

/** A kernel store with interleaved namespaces, every tracker key family, deletions, a lease and a shared request id. */
function backup(dir: string, shape: Shape, name = "source.db") {
  const path = join(dir, name);
  const raw = new Database(path);
  const owner = new StateOwner(sqlOf(raw), { now: () => NOW });
  owner.initialize();
  const put = (ns: string, key: string, value: unknown, requestId?: string) =>
    owner.put(ns, key, value, ACTOR, {
      expectRevision: 0,
      ...(requestId === undefined ? {} : { requestId }),
    });
  put("forge/identity", "project", { name: "excluded" });
  put(
    WORK,
    "issue:work-1",
    issue(1, { title: 'Ünï "q" \\ € \u0001' }),
    "put-a",
  );
  put("forge/other", "issue:work-1", { other: true }, "put-a");
  put(WORK, "issue:work-2", issue(2));
  put(
    WORK,
    "issue:work-3",
    issue(3, { parent: "work-1", dependsOn: shape.deps ?? ["work-1"] }),
  );
  owner.delete(WORK, "issue:work-2", ACTOR, { expectRevision: 1 });
  put(WORK, "comment:work-1:1", { id: "work-1", body: "one" });
  put(WORK, "comment:work-1:4", { id: "work-1", body: "four" });
  owner.delete(WORK, "comment:work-1:4", ACTOR, { expectRevision: 1 });
  put(WORK, "comment:work-3:2", { id: "work-3", body: "two" });
  owner.delete(WORK, "comment:work-3:2", ACTOR, { expectRevision: 1 });
  put(WORK, "link:work-1:1", {
    id: "work-1",
    relation: "delivers",
    url: "https://example.com/1",
  });
  const subject = "lane:work-1:attempt-1";
  const lease = owner.acquire(WORK, subject, HOLDER, 100, "claim-lane");
  owner.put(WORK, subject, { attempt: 1 }, ACTOR, {
    expectRevision: 0,
    requestId: "put-lane",
    fence: { subject, holder: HOLDER, generation: lease.generation },
  });
  put("forge/other", "other:key", { x: 1 });
  if (shape.floors)
    for (const [prefix, number] of [
      ["issue:work-", 3],
      ["comment:work-1:", 4],
      ["comment:work-3:", 2],
      ["link:work-1:", 1],
    ] as const)
      put(WORK, `allocation:${prefix}`, { prefix, number });
  if (shape.tamper !== undefined) raw.run(shape.tamper);
  raw.close();
  return { path, digest: sha(readFileSync(path)) };
}

// Independent reads of the finished backup, in plain SQL.
function read(path: string, table: Table, ns: string | null): Row[] {
  const db = new Database(path, { readonly: true });
  try {
    if (table === "domain_cloud_requests" && !tableExists(db, table)) return [];
    const where = ns === null ? "" : ` WHERE namespace = '${ns}'`;
    return db
      .query(
        `SELECT ${COLUMNS[table]} FROM ${table}${where} ORDER BY ${KEYS[table]}`,
      )
      .all() as Row[];
  } finally {
    db.close();
  }
}
const tableExists = (db: Database, table: string): boolean =>
  db.query("SELECT 1 FROM sqlite_master WHERE name = ?").get(table) !== null;
const bytesOf = (rows: Row[]): number =>
  rows.reduce(
    (sum, row) =>
      sum +
      Object.values(row).reduce<number>(
        (n, v) => n + Buffer.byteLength(String(v)),
        0,
      ),
    0,
  );
const totals = (rows: Row[]) => ({
  rows: rows.length,
  bytes: bytesOf(rows),
  digest: sha(JSON.stringify(rows)),
});
const namespaces = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  const found = (
    db.query("SELECT DISTINCT namespace AS n FROM state_records").all() as {
      n: string;
    }[]
  ).map((r) => r.n);
  db.close();
  return found.filter((n) => n !== WORK).sort();
};

const pagesOf = (out: string) =>
  readdirSync(out)
    .filter((f) => /^page-\d{6}\.json$/.test(f))
    .sort()
    .map((f) => parseDump(readFileSync(join(out, f), "utf8")) as Page);
function restoreAll(out: string, limits = limitsFrom({})) {
  const db = sqlOf(new Database(":memory:"));
  const owner = new StateOwner(db, { now: () => NOW });
  owner.initialize();
  db.exec(
    "CREATE TABLE domain_cloud_requests (request_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)",
  );
  const pages = pagesOf(out);
  for (const page of pages) restorePage(db, owner, page, limits);
  return { db, owner, pages };
}
const mapped = (path: string): Row[] =>
  read(path, "state_events", WORK).map((row, i) => ({
    ...row,
    sequence: i + 1,
  }));
const fresh = async (shape: Shape, extra: { pageBytes?: number } = {}) => {
  const dir = scratch();
  const source = backup(dir, shape);
  const out = join(dir, "out");
  const report = await convert({
    backup: source.path,
    digest: source.digest,
    out,
    ...extra,
  });
  return { dir, source, out, report };
};

test("dry run reports the selection and excluded inventory and writes nothing", async () => {
  const dir = scratch();
  const source = backup(dir, { floors: false });
  const before = { files: readdirSync(dir).sort(), digest: source.digest };
  const fetched: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((...args: unknown[]) => (
    fetched.push(args),
    realFetch(args[0] as string)
  )) as typeof fetch;
  try {
    const report = await convert({
      backup: source.path,
      digest: source.digest,
    });
    expect(report.status).toBe("PASS");
    expect(exitCode(report)).toBe(0);
    for (const table of TABLES)
      expect(report.selected[table]).toEqual(
        totals(read(source.path, table, WORK)),
      );
    expect(Object.keys(report.excluded).sort()).toEqual(
      namespaces(source.path),
    );
    for (const ns of namespaces(source.path))
      for (const table of TABLES.slice(0, 4))
        expect(report.excluded[ns]![table]).toEqual(
          totals(read(source.path, table, ns)),
        );
    expect(report.sequence.count).toBe(
      read(source.path, "state_events", WORK).length,
    );
    expect(report.predictedFloorPairs).toBe(4);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(fetched).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(before.files);
  expect(sha(readFileSync(source.path))).toBe(before.digest);
}, 30_000);

test("generation writes exactly the forge/work rows, the sequence map and the manifest last", async () => {
  const { source, out, report } = await fresh({ floors: true });
  expect(report.status).toBe("PASS");
  const names = readdirSync(out).sort();
  expect(names.at(-1)).toBe("manifest.json");
  expect(names).toContain("sequence-map.csv");
  const map = read(source.path, "state_events", WORK)
    .map((r, i) => `${r.sequence},${i + 1}\n`)
    .join("");
  expect(readFileSync(join(out, "sequence-map.csv"), "utf8")).toBe(map);
  expect(report.sequence).toEqual({
    count: map.split("\n").length - 1,
    digest: sha(map),
  });
  const { db, pages } = restoreAll(out);
  expect(pages.at(-1)!.last).toBe(true);
  const restored = dumpOf(db).tables;
  expect(restored.state_records).toEqual(
    read(source.path, "state_records", WORK),
  );
  expect(restored.state_events).toEqual(mapped(source.path));
  expect(restored.state_leases).toEqual(
    read(source.path, "state_leases", WORK),
  );
  expect(restored.state_requests).toEqual(
    read(source.path, "state_requests", WORK),
  );
  expect(restored.domain_cloud_requests).toEqual([]);
}, 30_000);

test("ids, parents, dependencies, history and request ids come back exactly", async () => {
  const { source, out, report } = await fresh({ floors: true });
  expect(report.status).toBe("PASS");
  const { db } = restoreAll(out);
  const live = (dumpOf(db).tables.state_records ?? []).map((r) => r.key);
  for (const key of [
    "issue:work-1",
    "issue:work-3",
    "comment:work-1:1",
    "link:work-1:1",
    "lane:work-1:attempt-1",
  ])
    expect(live).toContain(key);
  expect(live).not.toContain("issue:work-2");
  const requests = (dumpOf(db).tables.state_requests ?? []).filter(
    (r) => r.request_id === "put-a",
  );
  expect(requests).toHaveLength(1);
  expect(
    read(source.path, "state_requests", null).filter(
      (r) => r.request_id === "put-a",
    ),
  ).toHaveLength(2);
  const body: unknown = JSON.parse(
    String(
      (dumpOf(db).tables.state_records ?? []).find(
        (r) => r.key === "issue:work-3",
      )!.body,
    ),
  );
  expect(body).toMatchObject({
    id: "work-3",
    parent: "work-1",
    dependsOn: ["work-1"],
  });
}, 30_000);

const refused: [
  string,
  (dir: string) => { backup: string; digest: string },
  string,
][] = [
  [
    "missing path",
    (d) => ({ backup: join(d, "absent.db"), digest: "0".repeat(64) }),
    "SOURCE_MISSING",
  ],
  [
    "digest mismatch",
    (d) => ({
      backup: backup(d, { floors: true }).path,
      digest: "0".repeat(64),
    }),
    "SOURCE_DIGEST_MISMATCH",
  ],
  [
    "jsonl input",
    (d) => {
      const p = join(d, "tracker.jsonl");
      writeFileSync(p, '{"id":"work-1"}\n');
      return { backup: p, digest: sha(readFileSync(p)) };
    },
    "SOURCE_UNSUPPORTED",
  ],
  [
    "unreviewed domain data",
    (d) => {
      const s = backup(d, { floors: true });
      const raw = new Database(s.path);
      raw.run(
        "CREATE TABLE domain_cloud_requests (request_id TEXT PRIMARY KEY, fingerprint TEXT, outcome TEXT, result TEXT)",
      );
      raw.run("INSERT INTO domain_cloud_requests VALUES ('r','{}','ok','{}')");
      raw.close();
      return { backup: s.path, digest: sha(readFileSync(s.path)) };
    },
    "SOURCE_UNSUPPORTED",
  ],
  [
    "missing dependency target",
    (d) => {
      const s = backup(d, { floors: true, deps: ["work-99"] });
      return { backup: s.path, digest: s.digest };
    },
    "GRAPH_MISSING_TARGET",
  ],
  [
    "dependency cycle",
    (d) => {
      const s = backup(d, {
        floors: true,
        tamper: `UPDATE state_records SET body = replace(body, '"dependsOn":[]', '"dependsOn":["work-3"]') WHERE key = 'issue:work-1'`,
      });
      return { backup: s.path, digest: sha(readFileSync(s.path)) };
    },
    "GRAPH_CYCLE",
  ],
];
for (const [name, make, code] of refused)
  test(`refuses ${name} with a fixed code and no manifest`, async () => {
    const dir = scratch();
    const input = make(dir);
    const out = join(dir, "out");
    const before = existsSync(input.backup)
      ? sha(readFileSync(input.backup))
      : "";
    const report = await convert({ ...input, out });
    expect([report.status, report.code]).toEqual(["FAIL", code]);
    expect(exitCode(report)).not.toBe(0);
    expect(existsSync(join(out, "manifest.json"))).toBe(false);
    if (before !== "") expect(sha(readFileSync(input.backup))).toBe(before);
  }, 30_000);

const corrupt: [string, string, string][] = [
  [
    "mismatched indexed key",
    "UPDATE state_events SET key = 'issue:work-9' WHERE sequence = (SELECT MAX(sequence) FROM state_events WHERE namespace = 'forge/work')",
    "state_events",
  ],
  [
    "missing event",
    "DELETE FROM state_events WHERE namespace = 'forge/work' AND key = 'link:work-1:1'",
    "state_records",
  ],
  [
    "bad receipt",
    "UPDATE state_requests SET result = 'not json' WHERE namespace = 'forge/work' AND request_id = 'put-lane'",
    "state_requests",
  ],
  [
    "duplicate json label",
    "UPDATE state_records SET body = '{\"a\":1,\"a\":2}' WHERE key = 'comment:work-1:1'",
    "state_records",
  ],
  [
    "low floor",
    'UPDATE state_records SET body = \'{"prefix":"issue:work-","number":1}\' WHERE key = \'allocation:issue:work-\'',
    "state_records",
  ],
];
for (const [name, tamper, table] of corrupt)
  test(`restore rejects ${name} at ${table} and stages nothing`, async () => {
    const { out, report } = await fresh({ floors: true, tamper });
    expect(report.status).toBe("PASS");
    const db = sqlOf(new Database(":memory:"));
    const owner = new StateOwner(db, { now: () => NOW });
    owner.initialize();
    db.exec(
      "CREATE TABLE domain_cloud_requests (request_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)",
    );
    const pages = pagesOf(out);
    let failure: unknown;
    try {
      for (const page of pages) restorePage(db, owner, page, limitsFrom({}));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "RESTORE_INVALID_ROW" });
    expect(String((failure as Error).message)).toContain(`${table} row`);
    expect(Object.values(dumpOf(db).tables).flat()).toEqual([]);
  }, 30_000);

test("pages stay within the byte budget, one byte under refuses the largest row, and the envelope fits exactly", async () => {
  const whole = await fresh({ floors: true });
  expect(whole.report.status).toBe("PASS");
  const size = (out: string) =>
    pagesOf(out).map((p) => Buffer.byteLength(JSON.stringify(p)));
  const total = size(whole.out).reduce((a, b) => a + b, 0);
  const small = await fresh(
    { floors: true },
    { pageBytes: Math.ceil(total / 4) },
  );
  expect(small.report.status).toBe("PASS");
  expect(small.report.pages).toBeGreaterThan(1);
  for (const bytes of size(small.out))
    expect(bytes).toBeLessThanOrEqual(Math.ceil(total / 4));
  const tiny = await fresh({ floors: true }, { pageBytes: 400 });
  expect([tiny.report.status, tiny.report.code]).toEqual([
    "FAIL",
    "DUMP_TOO_LARGE",
  ]);
  expect(existsSync(join(tiny.out, "manifest.json"))).toBe(false);
  expect(dumpOf(restoreAll(small.out).db).tables.state_events).toEqual(
    mapped(small.source.path),
  );
}, 60_000);

test("a missing floor is predicted, not written, and restore adds exactly one record and one event for each", async () => {
  const { source, out, report } = await fresh({ floors: false });
  expect(report.status).toBe("PASS");
  expect(report.predictedFloorPairs).toBe(4);
  expect(
    pagesOf(out)
      .flatMap((p) => p.tables.state_records ?? [])
      .filter((r) => String(r.key).startsWith("allocation:")),
  ).toEqual([]);
  const { db } = restoreAll(out);
  const tables = dumpOf(db).tables;
  const added = (tables.state_records ?? []).filter((r) =>
    String(r.key).startsWith("allocation:"),
  );
  expect(added.map((r) => r.key)).toEqual([
    "allocation:comment:work-1:",
    "allocation:comment:work-3:",
    "allocation:issue:work-",
    "allocation:link:work-1:",
  ]);
  expect((tables.state_events ?? []).length).toBe(
    read(source.path, "state_events", WORK).length + 4,
  );
  expect(
    (tables.state_events ?? []).slice(0, mapped(source.path).length),
  ).toEqual(mapped(source.path));
  const capped = {
    ...limitsFrom({}),
    maxRows: read(source.path, "state_records", WORK).length,
  };
  expect(() => restoreAll(out, capped)).toThrow(/RESTORE_TOO_LARGE|row limit/);
}, 30_000);

test("the same source twice gives identical artifacts, and altered output is refused", async () => {
  const dir = scratch();
  const source = backup(dir, { floors: true });
  const run = (name: string) =>
    convert({
      backup: source.path,
      digest: source.digest,
      out: join(dir, name),
    });
  const [a, b] = [await run("a"), await run("b")];
  expect([a.status, b.status]).toEqual(["PASS", "PASS"]);
  expect(a.contentDigest).toBe(b.contentDigest);
  expect(a.contentDigest).not.toBe("");
  for (const file of readdirSync(join(dir, "a")).filter(
    (f) => f !== "manifest.json",
  ))
    expect(sha(readFileSync(join(dir, "b", file)))).toBe(
      sha(readFileSync(join(dir, "a", file))),
    );
  expect((await run("a")).status).toBe("PASS");
  const page = join(dir, "a", "page-000000.json");
  const altered = readFileSync(page, "utf8").replace("Issue 1", "Issue X");
  writeFileSync(page, altered);
  const again = await run("a");
  expect([again.status, again.code]).toEqual(["FAIL", "OUTPUT_MISMATCH"]);
  expect(readFileSync(page, "utf8")).toBe(altered);
}, 60_000);

test("a half staged restore restarts from page 0 and succeeds", async () => {
  const { source, out, report } = await fresh(
    { floors: true },
    { pageBytes: 3000 },
  );
  expect(report.status).toBe("PASS");
  const pages = pagesOf(out);
  expect(pages.length).toBeGreaterThan(2);
  const db = sqlOf(new Database(":memory:"));
  const owner = new StateOwner(db, { now: () => NOW });
  owner.initialize();
  db.exec(
    "CREATE TABLE domain_cloud_requests (request_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)",
  );
  for (const page of pages.slice(0, 2))
    restorePage(db, owner, page, limitsFrom({}));
  for (const page of pages) restorePage(db, owner, page, limitsFrom({}));
  expect(dumpOf(db).tables.state_events).toEqual(mapped(source.path));
}, 60_000);

// Pinned separately: this is the current cap on main, so an expected capacity refusal can never stand in for converter red.
test("main defaults refuse a 10,001 row page at admission, whatever the converter does", () => {
  const db = sqlOf(new Database(":memory:"));
  const owner = new StateOwner(db, { now: () => NOW });
  owner.initialize();
  db.exec(
    "CREATE TABLE domain_cloud_requests (request_id TEXT PRIMARY KEY NOT NULL, fingerprint TEXT NOT NULL, outcome TEXT NOT NULL, result TEXT NOT NULL)",
  );
  const rows = Array.from({ length: 10_001 }, (_, i) => ({
    namespace: WORK,
    request_id: `r-${i}`,
    fingerprint: "{}",
    result: "{}",
  }));
  const page = {
    format: "forge-cloud-dump-page/1",
    page: 0,
    last: false,
    next: "more",
    tables: {
      state_records: [],
      state_events: [],
      state_leases: [],
      state_requests: rows,
      domain_cloud_requests: [],
    },
  };
  expect(() => restorePage(db, owner, page, limitsFrom({}))).toThrow(
    /10000 row limit/,
  );
}, 30_000);
