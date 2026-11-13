// forge-1231 acceptance: the converter turns an isolated local state backup into restorable pages. Every expectation is
// read from the fixture with plain SQL, never from the converter. Sources are synthetic and built in a temp dir.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
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
import {
  backup,
  mapped,
  NOW,
  read,
  sha,
  sqlOf,
  WORK,
  type Row,
  type Shape,
} from "../../cloud/conformance/import-source.ts";
import { convert, exitCode, TABLES } from "../../tools/tracker-import.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "tracker-import-"));
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
  // The manifest is published last, so it lists every other file with its digest, and nothing else is there.
  const manifest = JSON.parse(
    readFileSync(join(out, "manifest.json"), "utf8"),
  ) as { files: Record<string, string> };
  expect(Object.keys(manifest.files).sort()).toEqual(
    names.filter((name) => name !== "manifest.json"),
  );
  for (const [name, digest] of Object.entries(manifest.files))
    expect(sha(readFileSync(join(out, name)))).toBe(digest);
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
  (dir: string) => { backup: string; digest: string; afterRead?: () => void },
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
    "the live default home store",
    (d) => {
      const s = backup(d, { floors: true }, join(".forge", "state.sqlite"));
      return { backup: s.path, digest: s.digest };
    },
    "SOURCE_LIVE_HOME",
  ],
  [
    "a source that changes between the two digest checks",
    (d) => {
      const s = backup(d, { floors: true });
      return {
        backup: s.path,
        digest: s.digest,
        afterRead: () => appendFileSync(s.path, "x"),
      };
    },
    "SOURCE_CHANGED",
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
    if (before !== "" && input.afterRead === undefined)
      expect(sha(readFileSync(input.backup))).toBe(before);
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
    maxRows: read(source.path, "state_events", WORK).length,
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
  const original = readFileSync(page, "utf8");
  const altered = original.replace("Issue 3", "Issue X");
  expect(altered).not.toBe(original);
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
