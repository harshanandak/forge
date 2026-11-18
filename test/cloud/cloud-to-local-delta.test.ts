import { expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { limitsFrom } from "../../cloud/src/dump.ts";
import { compute } from "../../tools/cloud-to-local-delta.ts";
import * as converter from "../../tools/import-current.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(120_000);

async function moved() {
  const source = f.source(6, false, false, (_db, state) => {
    state.put(
      f.ns,
      "comment:work-1:1",
      { id: "work-1", body: "local" },
      f.actor,
      { expectRevision: 0 },
    );
    state.put(
      f.ns,
      "allocation:comment:work-1:",
      { prefix: "comment:work-1:", number: 1 },
      f.actor,
      { expectRevision: 1 },
    );
    state.put(
      f.ns,
      "issue:work-2",
      { ...f.issueValue("work-2", "Synthetic 2"), status: "closed" },
      f.actor,
      { expectRevision: 1 },
    );
  });
  const backup = String(source.db.all("PRAGMA database_list")[0]!.file),
    root = dirname(backup);
  const manifest = join(root, "source.json"),
    dump = join(root, "bundle");
  writeFileSync(manifest, JSON.stringify(source.manifest));
  await converter.convert({
    backup,
    manifest,
    out: dump,
    limits: { ...limitsFrom({}), pageBytes: 4096 },
  });
  return {
    source,
    dump,
    options: { dump, backup, manifest, out: join(root, "delta.json") },
  };
}
type Rows = { key: string; body: string; revision: number }[];
function editCloud(dump: string, edit: (rows: Rows, first: boolean) => void) {
  const names = readdirSync(dump).filter((name) => name.startsWith("page-"));
  expect(names.length).toBeGreaterThan(1);
  names.forEach((name, index) => {
    const file = join(dump, name),
      page = JSON.parse(readFileSync(file, "utf8")) as {
        tables: { state_records: Rows };
      };
    edit(page.tables.state_records, index === 0);
    writeFileSync(file, JSON.stringify(page));
  });
}

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
});

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
      rows.push({
        namespace: f.ns,
        key: "comment:work-1:2",
        revision: 1,
        body: JSON.stringify({
          namespace: f.ns,
          key: "comment:work-1:2",
          revision: 1,
          value: { id: "work-1", body: "cloud only" },
          updatedAt: new Date(f.at).toISOString(),
          updatedBy: f.actor,
        }),
      } as never);
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
});

test("a record removed in the cloud is listed as absent and not as a change", async () => {
  const { dump, options } = await moved();
  editCloud(dump, (rows) => {
    const at = rows.findIndex((row) => row.key === "comment:work-1:1");
    if (at >= 0) rows.splice(at, 1);
  });
  const report = await compute(options);
  expect(report.delta).toEqual([]);
  expect(report.absentInCloud).toEqual(["comment:work-1:1"]);
});

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
});

test("an existing output file is refused and left untouched", async () => {
  const { options } = await moved();
  writeFileSync(options.out, "keep");
  await expect(compute(options)).rejects.toMatchObject({
    error: { code: "INPUT_INVALID" },
  });
  expect(readFileSync(options.out, "utf8")).toBe("keep");
});
