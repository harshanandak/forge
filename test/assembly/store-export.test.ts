import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStoreExport } from "../../src/assembly/store-export.ts";
import { createSqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  type StateImageStore,
} from "../../src/core/state/index.ts";
import { version } from "../../src/version.ts";
import * as converter from "../../tools/import-current.ts";

const actor = { kind: "agent" as const, id: "export" };
const scope = {
  op: "store.export",
  effects: ["files:write"],
  signal: new AbortController().signal,
  deadline: Date.now() + 600_000,
  processContainment: "supervised",
} as const;

interface Source {
  sha256: string;
  eventHighWaterMark: number;
  records: number;
  at: string;
  schemaVersion: string;
  tables: Record<string, number>;
  elapsedMs: number;
  forgeVersion: string;
}
const readSource = (out: string): Source =>
  JSON.parse(readFileSync(join(out, "source.json"), "utf8")) as Source;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function open(directory: string, path: string, readOnly: boolean) {
  const result = await createSqliteStore(directory).open({ path, readOnly });
  if (!result.ok) throw new Error(result.unavailable.reason);
  cleanups.push(() => result.handle.close());
  return result.handle;
}

function put(owner: StateOwner, index: number): void {
  owner.put("forge/test", `key-${index}`, { index }, actor, {
    expectRevision: 0,
    requestId: `write-${index}`,
  });
}

async function seeded(records: number) {
  const directory = mkdtempSync(join(tmpdir(), "forge-store-export-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "state.sqlite");
  const writer = await open(directory, path, false);
  const owner = new StateOwner(writer.value, { now: () => 1000 });
  owner.initialize();
  for (let index = 0; index < records; index++) put(owner, index);
  return { directory, path, writer, owner };
}

const digest = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

test("the backup's counts, high-water mark and digest match the backup file", async () => {
  const fixture = await seeded(3);
  await fixture.writer.close();
  const reader = await open(fixture.directory, fixture.path, true);
  const out = join(fixture.directory, "out");
  const result = createStoreExport(
    scope,
    new StateOwner(reader.value, { now: () => 1000 }),
  ).export({ out });
  const source = readSource(out);
  const backup = join(out, "backup.sqlite");
  expect(source.sha256).toBe(digest(backup));
  expect(result).toEqual({
    out,
    sha256: source.sha256,
    eventHighWaterMark: 3,
    records: 3,
  });
  expect(Object.keys(source).sort()).toEqual([
    "at",
    "elapsedMs",
    "eventHighWaterMark",
    "forgeVersion",
    "records",
    "schemaVersion",
    "sha256",
    "tables",
  ]);
  expect(source.forgeVersion).toBe(version);
  expect(source.elapsedMs).toBeGreaterThanOrEqual(0);
  const copy = (await open(fixture.directory, backup, true)).value;
  for (const [table, count] of Object.entries(source.tables))
    expect(Number(copy.get(`SELECT COUNT(*) AS n FROM ${table}`)?.n)).toBe(
      count,
    );
  expect(source.tables.state_records).toBe(3);
  expect(source.tables.state_events).toBe(3);
  expect(
    Number(copy.get("SELECT MAX(sequence) AS n FROM state_events")?.n),
  ).toBe(source.eventHighWaterMark);
  expect(source.schemaVersion).toBe(
    String(copy.get("SELECT MAX(id) AS id FROM state_migrations")?.id),
  );
});

test("a write that commits during the export does not reach the backup or its counts", async () => {
  const fixture = await seeded(3);
  const reader = (await open(fixture.directory, fixture.path, true))
    .value as StateImageStore;
  const racing: StateImageStore = {
    ...reader,
    exportImage: (inspect) =>
      reader.exportImage((image) => {
        put(fixture.owner, 99);
        inspect?.(image);
      }),
  };
  const out = join(fixture.directory, "out");
  createStoreExport(scope, new StateOwner(racing, { now: () => 1000 })).export({
    out,
  });
  const source = readSource(out);
  expect(fixture.owner.get("forge/test", "key-99")).toBeDefined();
  expect(source.records).toBe(3);
  expect(source.eventHighWaterMark).toBe(3);
  const copy = (await open(fixture.directory, join(out, "backup.sqlite"), true))
    .value;
  expect(Number(copy.get("SELECT COUNT(*) AS n FROM state_records")?.n)).toBe(
    3,
  );
  expect(
    copy.get("SELECT key FROM state_records WHERE key='key-99'"),
  ).toBeUndefined();
});

test("a folder that is not empty is refused and left as it was", async () => {
  const fixture = await seeded(1);
  await fixture.writer.close();
  const reader = await open(fixture.directory, fixture.path, true);
  const service = createStoreExport(
    scope,
    new StateOwner(reader.value, { now: () => 1000 }),
  );
  const out = join(fixture.directory, "taken");
  mkdirSync(out);
  writeFileSync(join(out, "keep.txt"), "keep");
  expect(() => service.export({ out })).toThrow("empty folder");
  expect(readdirSync(out)).toEqual(["keep.txt"]);
  expect(readFileSync(join(out, "keep.txt"), "utf8")).toBe("keep");
  expect(() => service.export({ out: join(out, "keep.txt") })).toThrow(
    "empty folder",
  );
  const empty = join(fixture.directory, "empty");
  mkdirSync(empty);
  service.export({ out: empty });
  expect(readdirSync(empty).sort()).toEqual(["backup.sqlite", "source.json"]);
});

test("the store file is byte-identical after an export", async () => {
  const fixture = await seeded(4);
  await fixture.writer.close();
  const before = digest(fixture.path);
  const reader = await open(fixture.directory, fixture.path, true);
  createStoreExport(
    scope,
    new StateOwner(reader.value, { now: () => 1000 }),
  ).export({ out: join(fixture.directory, "out") });
  expect(digest(fixture.path)).toBe(before);
});

test("a missing store, a missing effect and a missing folder name are refused", async () => {
  const fixture = await seeded(1);
  const owner = fixture.owner;
  const out = join(fixture.directory, "out");
  expect(() => createStoreExport(scope, undefined).export({ out })).toThrow(
    "no Forge store",
  );
  expect(() =>
    createStoreExport({ ...scope, effects: [] }, owner).export({ out }),
  ).toThrow("files:write");
  expect(() => createStoreExport(scope, owner).export({})).toThrow(
    "out folder",
  );
  expect(readdirSync(fixture.directory)).not.toContain("out");
});

test("the converter reads the exported pair and records only its own four keys", async () => {
  const fixture = await seeded(0);
  await fixture.writer.close();
  const reader = await open(fixture.directory, fixture.path, true);
  const out = join(fixture.directory, "out");
  createStoreExport(
    scope,
    new StateOwner(reader.value, { now: () => 1000 }),
  ).export({ out });
  const source = readSource(out);
  const bundle = await converter.convert({
    backup: join(out, "backup.sqlite"),
    manifest: join(out, "source.json"),
    out: join(fixture.directory, "bundle"),
  });
  expect(bundle.source).toEqual({
    at: source.at,
    eventHighWaterMark: source.eventHighWaterMark,
    records: source.records,
    sha256: source.sha256,
  });
}, 60_000);
