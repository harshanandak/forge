// forge-1231 acceptance for the dry run: the converter reads an isolated local state backup and reports what it would
// select. Every expectation is read from the fixture with plain SQL, never from the converter. Sources are synthetic
// and built in a temp dir.
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
  backup,
  read,
  sha,
  WORK,
  type Row,
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
    const events = read(source.path, "state_events", WORK);
    expect(report.sequence).toEqual({
      count: events.length,
      digest: sha(
        events
          .map(
            (r, i) => `${r.sequence},${i + 1}
`,
          )
          .join(""),
      ),
    });
    expect(report.largestRow).toBeGreaterThan(0);
    expect(report.predictedFloorPairs).toBe(4);
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(fetched).toEqual([]);
  expect(readdirSync(dir).sort()).toEqual(before.files);
  expect(sha(readFileSync(source.path))).toBe(before.digest);
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
    const before = existsSync(input.backup)
      ? sha(readFileSync(input.backup))
      : "";
    const report = await convert(input);
    expect([report.status, report.code]).toEqual(["FAIL", code]);
    expect(exitCode(report)).not.toBe(0);
    expect(readdirSync(dir).sort()).toEqual(files);
    if (before !== "" && input.afterRead === undefined)
      expect(sha(readFileSync(input.backup))).toBe(before);
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
