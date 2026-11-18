import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson } from "../src/core/config/pointer.ts";
import { parseRestoreJson } from "../src/core/state/restore-json.ts";
import type { StateEvent, StateRecord } from "../src/generated/types.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import { PAGE_FORMAT, parseDump, type Page } from "../cloud/src/dump.ts";
import { KEYS, TABLES, type Table } from "../cloud/conformance/digest.ts";
import { digest, isolatedBackup } from "./import-current.ts";
import { ordinaryKey, workRecords } from "./import-current-state.ts";

const namespace = "forge/work";
interface Identity {
  id: string;
  projectId: string | null;
}
const tableReasons: Record<string, string> = {
  state_events:
    "history is not carried back; applying a record derives its event locally",
  state_leases: "lease authority resets on the move; holders reacquire locally",
  state_requests: "request receipts are cloud replay state with no local twin",
  domain_cloud_requests: "cloud-only replay table with no local twin",
  domain_cloud_command_receipts: "cloud-only audit table with no local twin",
};
const floorReason =
  "derived number floor; the local store recomputes it from keys and events when records are applied";
const lostReason =
  "no local counterpart in the forward converter's mapping; records created in the cloud after the move are not in the pre-cutover snapshot and are lost on rollback unless carried by hand";
const fieldsReason =
  "cloud assigns these on every write; the local store assigns its own when the delta is applied";

function invalid(reason: string): never {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: `Invalid cloud-to-local delta input: ${reason}`,
    retry: "never",
  });
}
export interface Options {
  dump: string;
  backup: string;
  manifest: string;
  out: string;
}
function readPages(directory: string): Page[] {
  const number = (name: string) => Number(/\d+/.exec(name)![0]);
  const names = fs
    .readdirSync(directory)
    .filter((name) => /^page-\d{4,}\.json$/.test(name))
    .sort((a, b) => number(a) - number(b));
  if (names.length === 0) invalid("page sequence");
  return names.map((name, index) => {
    const page = parseDump(
      fs.readFileSync(join(directory, name), "utf8"),
    ) as Page;
    if (
      page.format !== PAGE_FORMAT ||
      page.page !== index ||
      page.last !== (index === names.length - 1)
    )
      invalid("page sequence");
    return page;
  });
}
type Key = unknown[];
const compare = (a: Key, b: Key): number => {
  if (a.length !== b.length) return 1;
  for (const [index, x] of a.entries())
    if (x !== b[index])
      return typeof x === "number"
        ? x - Number(b[index])
        : Buffer.compare(Buffer.from(String(x)), Buffer.from(String(b[index])));
  return 0;
};
function edge(page: Page, last: boolean) {
  const found = Object.entries(page.tables).filter(([, rows]) => rows.length);
  const [table, rows] = (last ? found.at(-1) : found[0]) ?? [];
  if (!table || !rows) return undefined;
  const row = last ? rows.at(-1)! : rows[0]!;
  return {
    table: TABLES.indexOf(table as Table),
    key: KEYS[table as Table].map((column) => row[column]),
  };
}
function chained(pages: Page[]): void {
  let watermark: string | undefined;
  for (const [index, page] of pages.entries()) {
    if (page.next === null) continue;
    let cursor: { p: number; t: number; k: Key; w: string };
    try {
      cursor = JSON.parse(page.next) as typeof cursor;
    } catch {
      return invalid("cursor chain");
    }
    const tail = edge(page, true),
      head = edge(pages[index + 1]!, false);
    if (
      !tail ||
      !head ||
      !Array.isArray(cursor.k) ||
      cursor.p !== index + 1 ||
      cursor.t !== tail.table ||
      compare(cursor.k, tail.key) !== 0 ||
      (watermark ??= cursor.w) !== cursor.w ||
      head.table < cursor.t ||
      (head.table === cursor.t && compare(head.key, cursor.k) <= 0)
    )
      invalid("cursor chain");
  }
}
function sameProject(pages: Page[], first: string | undefined, at: string) {
  const event = pages
    .flatMap((page) => page.tables.state_events ?? [])
    .find((row) => row.sequence === 1);
  const body = event && (parseRestoreJson(String(event.body)) as StateEvent);
  if (first !== undefined && (!body || body.key !== first || body.at !== at))
    invalid("dump is from a different project");
}
async function localRecords(path: string, pin: string) {
  isolatedBackup(path);
  if ((await digest(path)) !== pin)
    invalid("backup hash differs from source.json");
  const opened = await createSqliteStore(process.cwd()).open({
    path: resolve(path),
    readOnly: true,
  });
  if (!opened.ok) invalid("backup cannot be opened read-only");
  const records = new Map<string, StateRecord>();
  let first: string | undefined;
  let project: Identity | null = null;
  try {
    for (const record of workRecords(opened.handle.value)) {
      first ??= record.key;
      if (!record.key.startsWith("allocation:"))
        records.set(record.key, record);
    }
    const row = opened.handle.value.get(
      "SELECT body FROM state_records WHERE namespace=? AND key=?",
      ["forge/core-project", "identity"],
    );
    if (row) {
      const { id, projectId } = (
        parseRestoreJson(String(row.body)) as {
          value: { id?: unknown; projectId?: unknown };
        }
      ).value;
      if (typeof id !== "string") invalid("backup project identity");
      project = {
        id,
        projectId: typeof projectId === "string" ? projectId : null,
      };
    }
  } finally {
    await opened.handle.close();
  }
  if ((await digest(path)) !== pin) invalid("backup changed while read");
  return { records, first, project };
}
export async function compute(options: Options) {
  const { sha256: pin, at } = JSON.parse(
    fs.readFileSync(options.manifest, "utf8"),
  ) as { sha256?: unknown; at?: unknown };
  if (
    typeof pin !== "string" ||
    !/^[a-f0-9]{64}$/.test(pin) ||
    typeof at !== "string"
  )
    invalid("source.json needs sha256 and at");
  if (fs.existsSync(options.out)) invalid("output exists");
  const pages = readPages(options.dump);
  chained(pages);
  const {
    records: local,
    first,
    project,
  } = await localRecords(options.backup, pin);
  sameProject(pages, first, at);
  const cloud = new Map<string, StateRecord>();
  const seen = new Set<string>();
  const left = new Map<
    string,
    {
      scope: string;
      reason: string;
      count: number;
      keys?: { namespace: string; key: string }[];
    }
  >();
  const note = (
    scope: string,
    reason: string,
    count = 1,
    record?: StateRecord,
  ) => {
    const entry = left.get(scope) ?? { scope, reason, count: 0 };
    entry.count += count;
    if (record)
      (entry.keys ??= []).push({
        namespace: record.namespace,
        key: record.key,
      });
    left.set(scope, entry);
  };
  for (const page of pages)
    for (const [table, rows] of Object.entries(page.tables)) {
      if (table !== "state_records") {
        note(table, tableReasons[table] ?? lostReason, rows.length);
        continue;
      }
      for (const row of rows) {
        const record = parseRestoreJson(String(row.body)) as StateRecord;
        if (record.namespace !== row.namespace || record.key !== row.key)
          invalid("record does not match its row");
        const id = JSON.stringify([record.namespace, record.key]);
        if (seen.has(id)) invalid("duplicate key");
        seen.add(id);
        const family = record.key.split(":")[0]!;
        if (
          record.key.startsWith("allocation:") &&
          record.namespace === namespace
        )
          note(`${namespace}:allocation:*`, floorReason);
        else if (ordinaryKey(record.namespace, record.key)) {
          cloud.set(record.key, record);
        } else if (record.namespace === namespace)
          note(`${namespace}:${family}:*`, lostReason, 1, record);
        else note(`${record.namespace}:*`, lostReason, 1, record);
      }
    }
  note(
    "state_records fields revision, updatedAt, updatedBy",
    fieldsReason,
    cloud.size,
  );
  const delta = [...cloud.keys()].sort().flatMap((key) => {
    const after = cloud.get(key)!,
      before = local.get(key);
    if (before && canonicalJson(before.value) === canonicalJson(after.value))
      return [];
    return [
      {
        namespace,
        key,
        kind: key.split(":")[0]!,
        change: before ? "changed" : "new",
        beforeRevision: before?.revision ?? null,
        after: after.value,
      },
    ];
  });
  const absentInCloud = [...local.keys()]
    .filter((key) => !cloud.has(key))
    .sort();
  const report = {
    format: "forge-cloud-to-local-delta/1",
    source: {
      sha256: pin,
      project,
    },
    pages: pages.length,
    counts: {
      cloudRecords: cloud.size,
      localRecords: local.size,
      new: delta.filter((entry) => entry.change === "new").length,
      changed: delta.filter((entry) => entry.change === "changed").length,
      absentInCloud: absentInCloud.length,
    },
    delta,
    absentInCloud,
    notCarriedBack: [...left.values()].sort((a, b) =>
      a.scope < b.scope ? -1 : 1,
    ),
  };
  try {
    fs.writeFileSync(options.out, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    invalid("output cannot be created");
  }
  return report;
}
export async function run(options: Options) {
  try {
    const report = await compute(options);
    return respond(
      success("cloud-to-local-delta", {
        out: options.out,
        counts: report.counts,
      }),
    );
  } catch (error) {
    return respond(
      failure(
        error instanceof ForgeFailure ? error.error.code : "UNAVAILABLE",
        "Cloud-to-local delta refused; nothing applied",
      ),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const names = ["dump", "backup", "manifest", "out"];
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        names.map((name) => [name, { type: "string", multiple: true }]),
      ),
    });
    const one = (name: string) => {
      const found = values[name];
      return Array.isArray(found) && found.length === 1
        ? found[0]!
        : invalid("arguments");
    };
    const reply = await run({
      dump: one("dump"),
      backup: one("backup"),
      manifest: one("manifest"),
      out: one("out"),
    });
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  } catch {
    const reply = respond(
      failure(
        "INPUT_INVALID",
        "Expected --dump, --backup, --manifest and --out",
      ),
    );
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  }
}
