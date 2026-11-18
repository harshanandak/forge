import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { limitsFrom } from "../../cloud/src/dump.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import * as converter from "../../tools/import-current.ts";
import * as f from "./import-current-state.fixture.ts";
export const limits = { ...limitsFrom({}), pageBytes: 2048 };

export const project = {
  id: "0123456789abcdef",
  name: "fixture",
  projectId: "5b9d0a42-1c3e-4f6a-9d2b-7e8f1a2b3c4d",
};
export const acknowledged = (manifest: object) =>
  createHash("sha256")
    .update(
      canonicalJson({
        format: "forge-current-left-behind/1",
        source: manifest,
        records: [
          { namespace: "forge/core-project", shape: "identity", count: 1 },
        ],
        liveLeases: 0,
      }),
    )
    .digest("hex");
export async function moved(identity = true) {
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
    if (identity)
      state.put("forge/core-project", "identity", project, f.actor, {
        expectRevision: 0,
      });
  });
  const backup = String(source.db.all("PRAGMA database_list")[0]!.file),
    root = dirname(backup);
  const manifest = join(root, "source.json"),
    dump = join(root, "bundle");
  writeFileSync(manifest, JSON.stringify(source.manifest));
  const acknowledgeLeftBehind = identity
    ? acknowledged(source.manifest)
    : undefined;
  await converter.convert({
    backup,
    manifest,
    out: dump,
    limits,
    acknowledgeLeftBehind,
  });
  const again = async (name: string, at: string) => {
    const other = join(root, `${name}.json`),
      out = join(root, name);
    const changed = { ...source.manifest, at };
    writeFileSync(other, JSON.stringify(changed));
    await converter.convert({
      backup,
      manifest: other,
      out,
      limits,
      acknowledgeLeftBehind: identity ? acknowledged(changed) : undefined,
    });
    return out;
  };
  return {
    source,
    dump,
    root,
    again,
    options: { dump, backup, manifest, out: join(root, "delta.json") },
  };
}
export type Row = { key: string; body: string; revision: number };
export type Doc = {
  next: string | null;
  tables: Record<string, Row[]> & { state_records: Row[] };
};
export const pageNames = (dump: string) =>
  readdirSync(dump)
    .filter((name) => name.startsWith("page-"))
    .sort();
export function editPage(
  dump: string,
  index: number,
  edit: (page: Doc) => void,
) {
  const file = join(dump, pageNames(dump)[index]!),
    page = JSON.parse(readFileSync(file, "utf8")) as Doc;
  edit(page);
  writeFileSync(file, JSON.stringify(page));
}
export function editCloud(
  dump: string,
  edit: (rows: Row[], first: boolean) => void,
) {
  expect(pageNames(dump).length).toBeGreaterThan(1);
  pageNames(dump).forEach((_name, index) =>
    editPage(dump, index, (page) =>
      edit(page.tables.state_records, index === 0),
    ),
  );
}
export const cloudRow = (key: string, namespace: string, value: object): Row =>
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
export function cloudWrites(dump: string) {
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
        cloudRow("issue:work-9", f.ns, f.issueValue("work-9", "cloud only")),
      );
  });
}
