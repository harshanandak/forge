import { expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { limitsFrom } from "../../cloud/src/dump.ts";
import {
  compute,
  run,
  type Options,
} from "../../tools/cloud-to-local-delta.ts";
import * as converter from "../../tools/import-current.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(120_000);
const limits = { ...limitsFrom({}), pageBytes: 2048 };

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
  await converter.convert({ backup, manifest, out: dump, limits });
  const again = async (name: string, at: string) => {
    const other = join(root, `${name}.json`),
      out = join(root, name);
    writeFileSync(other, JSON.stringify({ ...source.manifest, at }));
    await converter.convert({ backup, manifest: other, out, limits });
    return out;
  };
  const options = {
    dump,
    backup,
    manifest,
    out: join(root, "delta.json"),
    dumpManifest: join(root, "export.json"),
    project: "tracker",
  };
  pinDump(options);
  return { source, dump, root, again, options };
}
type Row = { key: string; body: string; revision: number };
type Doc = {
  next: string | null;
  tables: Record<string, Row[]> & { state_records: Row[] };
};
const pageNames = (dump: string) =>
  readdirSync(dump)
    .filter((name) => name.startsWith("page-"))
    .sort();
function pinDump({
  dump,
  dumpManifest,
  project,
}: {
  dump: string;
  dumpManifest: string;
  project: string;
}) {
  writeFileSync(
    dumpManifest,
    JSON.stringify({
      project,
      pages: pageNames(dump).map((name) => ({
        name,
        sha256: sha(join(dump, name)),
      })),
    }),
  );
}
function editPage(dump: string, index: number, edit: (page: Doc) => void) {
  const file = join(dump, pageNames(dump)[index]!),
    page = JSON.parse(readFileSync(file, "utf8")) as Doc;
  edit(page);
  writeFileSync(file, JSON.stringify(page));
}
function editCloud(dump: string, edit: (rows: Row[], first: boolean) => void) {
  expect(pageNames(dump).length).toBeGreaterThan(1);
  pageNames(dump).forEach((_name, index) =>
    editPage(dump, index, (page) =>
      edit(page.tables.state_records, index === 0),
    ),
  );
}
const cloudRow = (key: string, namespace: string, value: object): Row =>
  ({
    namespace,
    key,
    revision: 1,
    body: JSON.stringify({
      namespace,
      key,
      revision: 1,
      value,
      updatedAt: new Date(f.at).toISOString(),
      updatedBy: f.actor,
    }),
  }) as unknown as Row;
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
  pinDump(options);
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
  pinDump(options);
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
  expect(by["forge/work:allocation:*"]).toBeUndefined();
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
  pinDump(options);
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
  pinDump(options);
  await refused(options, "cursor chain");
}, 120_000);

test("pages from two dumps are refused", async () => {
  const { options, dump, again } = await moved();
  const other = await again("other", "2027-01-01T00:00:00.000Z");
  expect(pageNames(dump).length).toBeGreaterThan(2);
  copyFileSync(join(other, "page-0001.json"), join(dump, "page-0001.json"));
  pinDump(options);
  await refused(options, "cursor chain");
}, 120_000);

test("a dump from another project is refused", async () => {
  const { options, again } = await moved();
  const other = await again("other", "2027-01-01T00:00:00.000Z");
  const otherOptions = { ...options, dump: other };
  pinDump(otherOptions);
  await refused(otherOptions, "different project");
}, 120_000);

test("a duplicate cloud key is refused, including a key outside the mapping", async () => {
  const { options, dump } = await moved();
  editPage(dump, 0, (page) => {
    const rows = page.tables.state_records;
    const allocation = rows.find((row) => row.key.startsWith("allocation:"))!;
    rows.splice(1, 0, { ...allocation });
  });
  pinDump(options);
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
  pinDump(options);
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

test("reports the floor advance when the allocated comment was deleted", async () => {
  const { dump, options } = await moved();
  const prefix = "comment:work-1:";
  const key = `allocation:${prefix}`;
  editCloud(dump, (rows) => {
    const floor = rows.find((row) => row.key === key);
    if (!floor) return;
    const record = JSON.parse(floor.body) as {
      revision: number;
      value: object;
    };
    record.revision = floor.revision = 2;
    record.value = { prefix, number: 2 };
    floor.body = JSON.stringify(record);
  });
  pinDump(options);
  const report = await compute(options);
  expect(report.delta).toMatchObject([
    {
      key,
      kind: "allocation",
      change: "changed",
      before: { prefix, number: 1 },
      after: { prefix, number: 2 },
    },
  ]);
  expect(report.counts.changed).toBe(1);
}, 120_000);

test("refuses a stale terminal page that still follows the preceding cursor", async () => {
  const { dump, options, root } = await moved();
  const names = pageNames(dump);
  expect(names.length).toBeGreaterThan(1);
  const last = join(dump, names.at(-1)!);
  const old = readFileSync(last);
  editPage(dump, names.length - 1, (page) => {
    expect(page.next).toBeNull();
    const events = page.tables.state_events! as (Row & { sequence: number })[];
    const event = events.at(-1)!;
    const sequence = event.sequence + 1;
    const body = JSON.parse(event.body) as Record<string, unknown>;
    events.push({
      ...event,
      sequence,
      body: JSON.stringify({ ...body, sequence }),
    });
  });
  pinDump(options);
  writeFileSync(last, old);
  const reply = await run(options);
  expect(reply.envelope).toMatchObject({
    ok: false,
    error: { code: "INPUT_INVALID", retry: "never" },
  });
  expect(existsSync(options.out)).toBe(false);
  const withoutManifest = {
    ...options,
    dumpManifest: join(root, "missing.json"),
  };
  await refused(withoutManifest, "dump provenance");
}, 120_000);

test("refuses another project's export of the same import", async () => {
  const { options, root, source, again } = await moved();
  const other = {
    ...options,
    dump: await again("rehearsal", source.manifest.at),
    dumpManifest: join(root, "rehearsal-export.json"),
    project: "rehearsal",
  };
  pinDump(other);
  const wrongProject = { ...other, project: options.project };
  await refused(wrongProject, "different project");
  await refused({ ...options, dump: other.dump }, "dump provenance");
}, 120_000);

test("scans the verified bytes when the source path changes after hashing", async () => {
  const { options, root } = await moved();
  const backup = join(root, "swappable.sqlite");
  copyFileSync(options.backup, backup);
  const other = String(f.source(5).db.all("PRAGMA database_list")[0]!.file);
  const importer = JSON.stringify(
    new URL("../../tools/import-current.ts", import.meta.url).href,
  );
  const hooked = `
    import { readFileSync, writeFileSync } from "node:fs";
    import { digest as hash } from ${importer};
    export { isolatedBackup } from ${importer};
    const source = ${JSON.stringify(backup)};
    const original = readFileSync(source);
    let swapped = false;
    export async function digest(path) {
      const sourcePath = path === source;
      if (swapped && sourcePath) writeFileSync(source, original);
      const result = await hash(path);
      if (!swapped) {
        writeFileSync(source, readFileSync(${JSON.stringify(other)}));
        swapped = true;
      }
      return result;
    }
  `;
  const dependency = `data:text/javascript;base64,${Buffer.from(hooked).toString("base64")}`;
  const url = await f.moduleUrl(
    "../../tools/cloud-to-local-delta.ts",
    undefined,
    ["./import-current.ts", dependency],
  );
  const delta = (await import(
    url
  )) as typeof import("../../tools/cloud-to-local-delta.ts");
  const report = await delta.compute({ ...options, backup });
  expect(report.delta).toEqual([]);
  expect(report.absentInCloud).toEqual([]);
  expect(sha(backup)).toBe(sha(other));
}, 120_000);
