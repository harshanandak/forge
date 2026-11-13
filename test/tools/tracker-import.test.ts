// forge-1231 acceptance for the dry run: the converter reads an isolated local state backup and reports what it would
// select. Every expectation is read from the fixture with plain SQL, never from the converter. Sources are synthetic
// and built in a temp dir.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backup,
  read,
  sha,
  sqlOf,
  WORK,
  type Row,
} from "../../cloud/conformance/import-source.ts";
import { readRows } from "../../src/core/state/rows.ts";
import {
  convert,
  COPY_PREFIX,
  MAX_SOURCE_BYTES,
  TABLES,
} from "../../tools/tracker-import.ts";

const scratch = (): string => mkdtempSync(join(tmpdir(), "tracker-import-"));
// The converter's private copy of the source lives in its own temporary directory, which must never outlive a call.
const copies = (): string[] =>
  readdirSync(tmpdir())
    .filter((name) => name.startsWith(COPY_PREFIX))
    .sort();
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
test("dry run reports the selection and writes nothing", async () => {
  const dir = scratch();
  const source = backup(dir, { floors: false });
  const before = { files: readdirSync(dir).sort(), digest: source.digest };
  const leftovers = copies();
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
    for (const table of TABLES)
      expect(report.selected[table]).toEqual(
        totals(read(source.path, table, WORK)),
      );
    expect(report.predictedFloorPairs).toBe(4);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(fetched).toEqual([]);
  expect(copies()).toEqual(leftovers);
  expect(readdirSync(dir).sort()).toEqual(before.files);
  expect(sha(readFileSync(source.path))).toBe(before.digest);
}, 30_000);

type Case = [
  string,
  (dir: string) => { backup: string; digest: string },
  string,
];
const tampered = (sql: string) => (d: string) => {
  const s = backup(d, { floors: true, tamper: sql });
  return { backup: s.path, digest: sha(readFileSync(s.path)) };
};
const refused: Case[] = [
  [
    "a store in write-ahead log mode",
    (d) => {
      const s = backup(d, { floors: true });
      const raw = new Database(s.path);
      raw.run("PRAGMA journal_mode = WAL");
      raw.close();
      return { backup: s.path, digest: sha(readFileSync(s.path)) };
    },
    "SOURCE_NOT_ISOLATED",
  ],
  ...["-wal", "-shm", "-journal"].map((suffix): Case => [
    `a ${suffix} file beside the source`,
    (d) => {
      const s = backup(d, { floors: true });
      writeFileSync(s.path + suffix, "x");
      return { backup: s.path, digest: s.digest };
    },
    "SOURCE_NOT_ISOLATED",
  ]),
  [
    "an unknown schema version",
    tampered("PRAGMA user_version = 5"),
    "SOURCE_UNSUPPORTED",
  ],
  [
    "an unknown migration entry",
    tampered("INSERT INTO state_migrations (id) VALUES ('999_future')"),
    "SOURCE_UNSUPPORTED",
  ],
  [
    "an issue that is its own parent",
    tampered(
      `UPDATE state_records SET body = replace(body, '"parent":"work-1"', '"parent":"work-3"') WHERE namespace = 'forge/work' AND key = 'issue:work-3'`,
    ),
    "GRAPH_CYCLE",
  ],
  [
    "two issues that are each other's parent",
    tampered(
      `UPDATE state_records SET body = replace(body, '"dependsOn":[]', '"dependsOn":[],"parent":"work-3"') WHERE namespace = 'forge/work' AND key = 'issue:work-1'`,
    ),
    "GRAPH_CYCLE",
  ],
  [
    "a dependsOn that is a string",
    tampered(
      `UPDATE state_records SET body = replace(body, '"dependsOn":[]', '"dependsOn":"work-3"') WHERE namespace = 'forge/work' AND key = 'issue:work-1'`,
    ),
    "SOURCE_INCONSISTENT",
  ],
  [
    "a parent that is a number",
    tampered(
      `UPDATE state_records SET body = replace(body, '"parent":"work-1"', '"parent":7') WHERE namespace = 'forge/work' AND key = 'issue:work-3'`,
    ),
    "SOURCE_INCONSISTENT",
  ],
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
    "a directory link to the live store",
    (d) => {
      // The path itself looks harmless; only following the link reaches `.forge/state.sqlite`. A junction runs on every OS.
      const live = backup(
        d,
        { floors: true },
        join("live", ".forge", "state.sqlite"),
      );
      symlinkSync(join(d, "live", ".forge"), join(d, "alias"), "junction");
      return { backup: join(d, "alias", "state.sqlite"), digest: live.digest };
    },
    "SOURCE_LIVE_HOME",
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
    "two live issues with one id",
    (d) => {
      const s = backup(d, {
        floors: true,
        tamper: `UPDATE state_records SET body = replace(body, '"id":"work-3"', '"id":"work-1"') WHERE namespace = 'forge/work' AND key = 'issue:work-3'`,
      });
      return { backup: s.path, digest: sha(readFileSync(s.path)) };
    },
    "GRAPH_DUPLICATE_ID",
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
  test(`refuses ${name} with a fixed code and changes nothing`, async () => {
    const dir = scratch();
    const input = make(dir);
    const files = readdirSync(dir).sort();
    const leftovers = copies();
    const before = existsSync(input.backup)
      ? sha(readFileSync(input.backup))
      : "";
    const report = await convert(input);
    expect([report.status, report.code]).toEqual(["FAIL", code]);
    expect(readdirSync(dir).sort()).toEqual(files);
    expect(copies()).toEqual(leftovers);
    if (before !== "") expect(sha(readFileSync(input.backup))).toBe(before);
  }, 30_000);

// Real stores wrap each issue in its record's `value`, and an epic may depend on its own children: both are legal.
test("a graph with distinct ids and a parent that depends on its child is accepted", async () => {
  const dir = scratch();
  const source = backup(dir, {
    floors: true,
    deps: [],
    tamper: `UPDATE state_records SET body = replace(body, '"dependsOn":[]', '"dependsOn":["work-3"]') WHERE namespace = 'forge/work' AND key = 'issue:work-1'`,
  });
  const report = await convert({
    backup: source.path,
    digest: sha(readFileSync(source.path)),
  });
  expect([report.status, report.code]).toEqual(["PASS", null]);
}, 30_000);

// A tracker can hold a long dependency chain; the cycle check must not use the call stack for it.
const links = 30_000;
const chain = (loopBackTo?: number) => {
  const dir = scratch();
  const source = backup(dir, { floors: true });
  const raw = new Database(source.path);
  const insert = raw.prepare(
    "INSERT INTO state_records (namespace, key, revision, body) VALUES ('forge/work', ?, 1, ?)",
  );
  const id = (n: number) => `chain-${String(n).padStart(6, "0")}`;
  raw.transaction(() => {
    for (let n = 1; n <= links; n += 1) {
      const dependsOn =
        n < links
          ? [id(n + 1)]
          : loopBackTo === undefined
            ? []
            : [id(loopBackTo)];
      insert.run(
        `issue:${id(n)}`,
        JSON.stringify({
          namespace: "forge/work",
          key: `issue:${id(n)}`,
          revision: 1,
          value: { id: id(n), dependsOn },
        }),
      );
    }
  })();
  raw.close();
  return { path: source.path, digest: sha(readFileSync(source.path)) };
};
test("a legal dependency chain 30,000 deep is accepted", async () => {
  const source = chain();
  const report = await convert({ backup: source.path, digest: source.digest });
  expect([report.status, report.code]).toEqual(["PASS", null]);
  expect(report.selected.state_records.rows).toBe(
    read(source.path, "state_records", WORK).length,
  );
}, 60_000);
test("a cycle near the end of a 30,000 deep chain is refused", async () => {
  const source = chain(links - 4);
  const report = await convert({ backup: source.path, digest: source.digest });
  expect([report.status, report.code]).toEqual(["FAIL", "GRAPH_CYCLE"]);
}, 60_000);

// The live path in capitals names the live store wherever the file system ignores case (Windows, macOS); Linux keeps it.
test("an upper-case live store path is refused where case is ignored and read where it is not", async () => {
  const dir = scratch();
  const source = backup(dir, { floors: true }, join(".FORGE", "STATE.SQLITE"));
  const report = await convert({ backup: source.path, digest: source.digest });
  expect([report.status, report.code]).toEqual(
    process.platform === "linux"
      ? ["PASS", null]
      : ["FAIL", "SOURCE_LIVE_HOME"],
  );
}, 30_000);

// Restore tallies a family from a live key, a deleted key or a written allocation floor, never from a lease. The
// expectation is computed here from plain SQL, not by the converter.
const familyOf = /^((?:comment|link):[^:]+:)[1-9][0-9]*$/;
const floorPairsBySql = (path: string): number => {
  const db = new Database(path, { readonly: true });
  const keys = (where: string, table = "state_events") =>
    (
      db
        .query(
          `SELECT key FROM ${table} WHERE namespace = 'forge/work'${where}`,
        )
        .all() as { key: string }[]
    ).map((r) => r.key);
  const type = (kind: string) =>
    ` AND json_extract(body, '$.type') LIKE '%:record.${kind}@1'`;
  const live = new Set(keys("", "state_records"));
  const named = [...live, ...keys(type("deleted"))].map(
    (k) => familyOf.exec(k)?.[1],
  );
  const floors = keys(`${type("updated")} AND key LIKE 'allocation:%'`)
    .map((k) => k.slice("allocation:".length))
    .filter((p) => familyOf.exec(`${p}1`)?.[1] === p);
  db.close();
  const found = new Set([...named, ...floors].filter((f) => f !== undefined));
  return ["issue:work-", ...found].filter((p) => !live.has(`allocation:${p}`))
    .length;
};
const floorRows: [string, { lease?: string; history?: string }, number][] = [
  [
    "a lease on a comment subject with no record adds no comment floor",
    { lease: "comment:work-8:7" },
    4,
  ],
  [
    "an allocation floor that was written and deleted with no numbered key adds a floor",
    { history: "comment:work-9:" },
    5,
  ],
];
for (const [name, extra, expected] of floorRows)
  test(`floor prediction: ${name}`, async () => {
    const source = backup(scratch(), { floors: false, ...extra });
    const report = await convert({
      backup: source.path,
      digest: source.digest,
    });
    expect(report.status).toBe("PASS");
    expect(floorPairsBySql(source.path)).toBe(expected);
    expect(report.predictedFloorPairs).toBe(expected);
  }, 30_000);

// The report describes the bytes that were read once, even when the source path is swapped before anything opens them.
test("a swap of the source after it is read still reports the original bytes", async () => {
  const source = backup(scratch(), { floors: true });
  const other = backup(scratch(), { floors: false });
  const of = (path: string, table: (typeof TABLES)[number]) =>
    totals(read(path, table, WORK));
  // Read before the swap: the swapped-in store would select different rows, so a report that followed the path could not match.
  const expected = Object.fromEntries(
    TABLES.map((table) => [table, of(source.path, table)]),
  ) as Record<(typeof TABLES)[number], ReturnType<typeof totals>>;
  expect(of(other.path, "state_records")).not.toEqual(expected.state_records);
  const floors = floorPairsBySql(source.path);
  const leftovers = copies();
  const report = await convert({
    backup: source.path,
    digest: source.digest,
    afterRead: () => copyFileSync(other.path, source.path),
  });
  expect(sha(readFileSync(source.path))).toBe(other.digest);
  expect(report.status).toBe("PASS");
  for (const table of TABLES)
    expect(report.selected[table]).toEqual(expected[table]);
  expect(report.predictedFloorPairs).toBe(floors);
  expect(copies()).toEqual(leftovers);
}, 30_000);

// A source over the limit is refused by its size, before it is read into memory.
test("a source over the size limit is refused with a fixed code and leaves no copy", async () => {
  const dir = scratch();
  try {
    const source = backup(dir, { floors: true });
    truncateSync(source.path, MAX_SOURCE_BYTES + 1);
    const leftovers = copies();
    const report = await convert({
      backup: source.path,
      digest: source.digest,
    });
    expect([report.status, report.code]).toEqual(["FAIL", "SOURCE_TOO_LARGE"]);
    expect(copies()).toEqual(leftovers);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

// A batch that is not a positive safe integer never advances, so the reader refuses it.
for (const batch of [0, -1, 1.5, Number.NaN, 2 ** 53])
  test(`readRows refuses a batch of ${batch}`, () => {
    const raw = new Database(backup(scratch(), { floors: true }).path, {
      readonly: true,
    });
    expect(() =>
      readRows(sqlOf(raw), "state_records", WORK, batch).next(),
    ).toThrow(RangeError);
    raw.close();
  }, 30_000);

// A value local state accepts but a cloud column does not (here a body over 8 MiB) is a report, never a crash or a leaked body.
test("a row over a cloud column limit is refused naming its table and key, never its body", async () => {
  const dir = scratch();
  const make = tampered(
    `UPDATE state_records SET body = replace(hex(zeroblob(5000000)), '0', 'a') WHERE namespace = 'forge/work' AND key = 'issue:work-3'`,
  );
  const report = await convert(make(dir));
  expect([report.status, report.code, report.detail]).toEqual([
    "FAIL",
    "ROW_UNSUPPORTED",
    "state_records issue:work-3",
  ]);
  expect(JSON.stringify(report)).not.toContain("aaaaaaaa");
}, 60_000);
