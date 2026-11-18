import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compute, type Options } from "../../tools/cloud-to-local-delta.ts";
import * as converter from "../../tools/import-current.ts";
import {
  acknowledged,
  cloudRow,
  editCloud,
  editPage,
  limits,
  moved,
  pageNames,
  project,
} from "./cloud-to-local.fixture.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(120_000);

async function refused(options: Options, reason: string) {
  const error = await compute(options).then(
    () => undefined,
    (thrown: unknown) => thrown as { error: { code: string; message: string } },
  );
  expect(error?.error.code).toBe("INPUT_INVALID");
  expect(error?.error.message).toContain(reason);
  expect(existsSync(options.out)).toBe(false);
}
const sha = (path: string) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const state = (options: Options) =>
  [
    sha(options.backup),
    ...pageNames(options.dump).map((name) => sha(join(options.dump, name))),
  ].join();
type Left = {
  scope: string;
  reason: string;
  count: number;
  keys?: { namespace: string; key: string }[];
};

test("a local fixture through the converter and a fake dump gives an empty delta", async () => {
  const { source, options } = await moved();
  const report = await compute(options);
  expect(report.delta).toEqual([]);
  expect(report.absentInCloud).toEqual([]);
  expect(report.counts).toMatchObject({
    new: 0,
    changed: 0,
    cloudRecords: report.counts.localRecords,
  });
  expect(report.pages).toBeGreaterThan(1);
  expect(JSON.parse(readFileSync(options.out, "utf8"))).toEqual(report);
  expect(source.bytes()).toBe(source.manifest.sha256);
}, 120_000);

test("a cloud-only comment and an issue closed in the cloud appear with their content", async () => {
  const { dump, options } = await moved();
  editCloud(dump, (rows, first) => {
    for (const row of rows) {
      if (row.key !== "issue:work-3") continue;
      const record = JSON.parse(row.body) as {
        value: object;
        revision: number;
      };
      record.value = {
        ...record.value,
        status: "closed",
        withoutReceipt: "closed in the cloud",
      };
      record.revision = row.revision = 2;
      row.body = JSON.stringify(record);
    }
    if (first)
      rows.splice(
        1,
        0,
        cloudRow("comment:work-1:2", f.ns, {
          id: "work-1",
          body: "cloud only",
        }),
      );
  });
  const report = await compute(options);
  expect(
    report.delta.map((entry) => [
      entry.key,
      entry.kind,
      entry.change,
      entry.beforeRevision,
    ]),
  ).toEqual([
    ["comment:work-1:2", "comment", "new", null],
    ["issue:work-3", "issue", "changed", 1],
  ]);
  expect(report.delta[0]!.after).toEqual({ id: "work-1", body: "cloud only" });
  expect(report.delta[1]!.after).toMatchObject({
    status: "closed",
    withoutReceipt: "closed in the cloud",
  });
  expect(report.counts).toMatchObject({ new: 1, changed: 1 });
  expect(report.absentInCloud).toEqual([]);
}, 120_000);

test("a record removed in the cloud is listed as absent and not as a change", async () => {
  const { dump, options } = await moved();
  let removed: string | undefined;
  pageNames(dump).forEach((_name, index) =>
    editPage(dump, index, (page) => {
      const rows = page.tables.state_records;
      const later = Object.entries(page.tables).some(
        ([table, other]) => table !== "state_records" && other.length > 0,
      );
      const at = rows.findIndex(
        (row, place) =>
          /^(issue|comment):/.test(row.key) &&
          (place < rows.length - 1 || later),
      );
      if (removed !== undefined || at < 0) return;
      removed = rows[at]!.key;
      rows.splice(at, 1);
    }),
  );
  expect(removed).toBeDefined();
  const report = await compute(options);
  expect(report.delta).toEqual([]);
  expect(report.absentInCloud).toEqual([removed!]);
}, 120_000);

test("non-invertible tables, families and fields are listed as not carried back with a reason", async () => {
  const { options } = await moved();
  const { notCarriedBack } = await compute(options);
  const by = Object.fromEntries(notCarriedBack.map((e) => [e.scope, e]));
  expect(by.state_events!.count).toBeGreaterThan(0);
  expect(by.state_events!.reason).toContain("derives its event locally");
  expect(by["forge/work:allocation:*"]!.count).toBeGreaterThan(0);
  const fields = by["state_records fields revision, updatedAt, updatedBy"]!;
  expect(fields.reason).toContain("cloud assigns these");
  expect(fields.count).toBeGreaterThan(0);
  for (const entry of notCarriedBack)
    expect(entry.reason.length).toBeGreaterThan(0);
}, 120_000);

test("cloud-created records outside the mapping are listed by key and said to be lost on rollback", async () => {
  const { dump, options } = await moved();
  editCloud(dump, (rows, first) => {
    if (first)
      rows.splice(
        1,
        0,
        cloudRow("autopilot:global", f.ns, { any: 1 }),
        cloudRow("lane-control:global", f.ns, { any: 2 }),
        cloudRow("note", "forge/other", { any: 3 }),
      );
  });
  const left = (await compute(options)).notCarriedBack as Left[];
  const by = Object.fromEntries(left.map((e) => [e.scope, e]));
  const cases = [
    ["forge/work:autopilot:*", f.ns, "autopilot:global"],
    ["forge/work:lane-control:*", f.ns, "lane-control:global"],
    ["forge/other:*", "forge/other", "note"],
  ] as const;
  for (const [scope, namespace, key] of cases) {
    expect(by[scope]!.keys).toEqual([{ namespace, key }]);
    expect(by[scope]!.reason).toContain("lost on rollback");
    expect(by[scope]!.reason).not.toContain("retained in the pre-cutover");
  }
}, 120_000);

test("a backup whose hash differs from source.json is refused", async () => {
  const { options, source } = await moved();
  writeFileSync(
    options.manifest,
    JSON.stringify({ ...source.manifest, sha256: "0".repeat(64) }),
  );
  await refused(options, "backup hash");
}, 120_000);

test("a missing page, an extra page and out-of-order pages are refused", async () => {
  const { options, dump, root } = await moved();
  const first = join(dump, "page-0000.json"),
    second = join(dump, "page-0001.json");
  renameSync(first, join(root, "held.json"));
  await refused(options, "page sequence");
  renameSync(join(root, "held.json"), first);
  copyFileSync(first, join(dump, "page-9999.json"));
  await refused(options, "page sequence");
  renameSync(join(dump, "page-9999.json"), join(root, "extra.json"));
  renameSync(first, join(root, "swap.json"));
  renameSync(second, first);
  renameSync(join(root, "swap.json"), second);
  await refused(options, "page sequence");
}, 120_000);

test("a broken next-cursor chain is refused", async () => {
  const { options, dump } = await moved();
  editPage(dump, 0, (page) => {
    const cursor = JSON.parse(page.next!) as { k: unknown[] };
    page.next = JSON.stringify({ ...cursor, k: [...cursor.k, "x"] });
  });
  await refused(options, "cursor chain");
}, 120_000);

test("pages from two dumps are refused", async () => {
  const { options, dump, again } = await moved();
  const other = await again("other", "2027-01-01T00:00:00.000Z");
  expect(pageNames(dump).length).toBeGreaterThan(2);
  copyFileSync(join(other, "page-0001.json"), join(dump, "page-0001.json"));
  await refused(options, "cursor chain");
}, 120_000);

test("a dump from another project is refused", async () => {
  const { options, again } = await moved();
  const other = await again("other", "2027-01-01T00:00:00.000Z");
  await refused({ ...options, dump: other }, "different project");
}, 120_000);

test("a duplicate cloud key is refused, including a key outside the mapping", async () => {
  const { options, dump } = await moved();
  editPage(dump, 0, (page) => {
    const rows = page.tables.state_records;
    const allocation = rows.find((row) => row.key.startsWith("allocation:"))!;
    rows.splice(1, 0, { ...allocation });
  });
  await refused(options, "duplicate key");
}, 120_000);

test("the dump and the backup are byte-identical after a run", async () => {
  const { options } = await moved();
  const before = state(options);
  await compute(options);
  expect(state(options)).toBe(before);
}, 120_000);

test("a difference only in revision, updatedAt or updatedBy gives an empty delta", async () => {
  const { options, dump } = await moved();
  editCloud(dump, (rows) => {
    for (const row of rows) {
      const record = JSON.parse(row.body) as Record<string, unknown>;
      record.revision = row.revision = 7;
      record.updatedAt = "2030-01-01T00:00:00.000Z";
      record.updatedBy = { kind: "agent", id: "cloud-writer" };
      row.body = JSON.stringify(record);
    }
  });
  const report = await compute(options);
  expect(report.delta).toEqual([]);
  expect(report.absentInCloud).toEqual([]);
}, 120_000);

test("a symlinked backup and a backup with a -wal sidecar are refused", async () => {
  const { options, root } = await moved();
  writeFileSync(options.backup + "-wal", "");
  await refused(options, "Invalid offline import input");
  rmSync(options.backup + "-wal");
  const link = join(root, "link.sqlite");
  try {
    symlinkSync(options.backup, link);
  } catch (error) {
    const code = (error as { code?: string }).code;
    expect(process.platform === "win32" && code === "EPERM").toBe(true);
    return;
  }
  await refused({ ...options, backup: link }, "Invalid offline import input");
}, 120_000);

test("the report carries the backup's project identity", async () => {
  const named = await moved();
  expect((await compute(named.options)).source).toEqual({
    sha256: named.source.manifest.sha256,
    project: { id: project.id, projectId: project.projectId },
  });
}, 120_000);

test("a backup without a project identity is refused", async () => {
  const { options } = await moved(false);
  await refused(options, "no project identity");
}, 120_000);

test("a backup with no work records is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "forge-empty-delta-"));
  try {
    const backup = join(dir, "standalone.sqlite"),
      manifest = join(dir, "source.json"),
      dump = join(dir, "bundle"),
      db = f.database(backup),
      state = f.owner(db);
    state.initialize();
    state.put("forge/core-project", "identity", project, f.actor, {
      expectRevision: 0,
    });
    db.exec("PRAGMA journal_mode=DELETE");
    const read = f.database(backup, true);
    const facts = {
      sha256: sha(backup),
      eventHighWaterMark: Number(
        read.get("SELECT COALESCE(MAX(sequence),0) AS n FROM state_events")!.n,
      ),
      records: Number(read.get("SELECT COUNT(*) AS n FROM state_records")!.n),
      at: new Date(f.at).toISOString(),
    };
    writeFileSync(manifest, JSON.stringify(facts));
    await converter.convert({
      backup,
      manifest,
      out: dump,
      limits,
      acknowledgeLeftBehind: acknowledged(facts),
    });
    await refused(
      { dump, backup, manifest, out: join(dir, "delta.json") },
      "different project",
    );
  } finally {
    f.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
