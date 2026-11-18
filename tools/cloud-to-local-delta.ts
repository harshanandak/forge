import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { windowsPrivateFiles } from "../src/adapters/process/windows-acl.ts";
import { copyPrivateFile } from "../src/adapters/store-sqlite/file-ops.ts";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { privateFileGuard } from "../src/adapters/store-sqlite/private-files.ts";
import { validateDeclaredWorkRecord } from "../src/blocks/work/state-families.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson, isObject } from "../src/core/config/pointer.ts";
import { parseRestoreJson } from "../src/core/state/restore-json.ts";
import type { StateEvent, StateRecord } from "../src/generated/types.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import { PAGE_FORMAT, parseDump, type Page } from "../cloud/src/dump.ts";
import { KEYS, TABLES, type Table } from "../cloud/conformance/digest.ts";
import { digest, isolatedBackup } from "./import-current.ts";
import {
  importFloorBaseline,
  ordinaryKey,
  workRecords,
} from "./import-current-state.ts";

const namespace = "forge/work";
const projectName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha256 = /^[a-f0-9]{64}$/;
const exportWatermark = /^[a-f0-9]{32}\.[0-9]{19}$/;
const tableReasons: Record<string, string> = {
  state_events:
    "history is not carried back; applying a record derives its event locally",
  state_leases: "lease authority resets on the move; holders reacquire locally",
  state_requests: "request receipts are cloud replay state with no local twin",
  domain_cloud_requests: "cloud-only replay table with no local twin",
  domain_cloud_command_receipts: "cloud-only audit table with no local twin",
};
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
  dumpManifest: string;
  project: string;
}
function readJson(path: string, reason: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as unknown;
  } catch {
    return invalid(reason);
  }
}
function readPages({ dump, dumpManifest, project }: Options): Page[] {
  if (typeof project !== "string" || !projectName.test(project))
    invalid("expected a cloud project name");
  const receipt = readJson(dumpManifest, "trusted dump provenance is required");
  if (
    !isObject(receipt) ||
    typeof receipt.project !== "string" ||
    !Array.isArray(receipt.pages)
  )
    invalid("invalid dump provenance");
  if (receipt.project !== project) invalid("dump is from a different project");
  const pins: unknown[] = receipt.pages;
  const number = (name: string) => Number(/\d+/.exec(name)![0]);
  const names = fs
    .readdirSync(dump)
    .filter((name) => /^page-\d{4,}\.json$/.test(name))
    .sort((a, b) => number(a) - number(b));
  if (names.length === 0 || names.length !== pins.length)
    invalid("page sequence");
  return names.map((name, index) => {
    const bytes = fs.readFileSync(join(dump, name));
    const page = parseDump(bytes.toString("utf8")) as Page;
    if (
      page.format !== PAGE_FORMAT ||
      page.page !== index ||
      page.last !== (index === names.length - 1)
    )
      invalid("page sequence");
    const pin = pins[index];
    if (
      !isObject(pin) ||
      pin.name !== name ||
      pin.sha256 !== createHash("sha256").update(bytes).digest("hex")
    )
      invalid("page hash does not match trusted dump provenance");
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
    let cursor: unknown;
    try {
      cursor = JSON.parse(page.next) as unknown;
    } catch {
      return invalid("cursor chain");
    }
    const tail = edge(page, true),
      head = edge(pages[index + 1]!, false);
    if (
      !tail ||
      !head ||
      !isObject(cursor) ||
      !Array.isArray(cursor.k) ||
      cursor.p !== index + 1 ||
      cursor.t !== tail.table ||
      canonicalJson(cursor.k) !== canonicalJson(tail.key) ||
      typeof cursor.w !== "string" ||
      !exportWatermark.test(cursor.w) ||
      (watermark ??= cursor.w) !== cursor.w ||
      head.table < tail.table ||
      (head.table === tail.table && compare(head.key, tail.key) <= 0)
    )
      invalid("cursor chain");
  }
}
function sameProject(pages: Page[], first: string | undefined, at: string) {
  const event = pages
    .flatMap((page) => page.tables.state_events ?? [])
    .find((row) => row.sequence === 1);
  const body = event && (parseRestoreJson(String(event.body)) as StateEvent);
  if (!body || body.key !== first || body.at !== at)
    invalid("dump is from a different project");
}
async function localRecords(
  path: string,
  pin: string,
  eventHighWaterMark: number,
) {
  isolatedBackup(path);
  const directory = fs.mkdtempSync(join(tmpdir(), ".forge-delta-"));
  try {
    if (process.platform === "win32")
      privateFileGuard(windowsPrivateFiles()).directory(directory, true);
    const copy = join(directory, ".source.sqlite");
    copyPrivateFile(path, copy);
    if ((await digest(copy)) !== pin)
      invalid("backup hash differs from source.json");
    isolatedBackup(copy);
    const opened = await createSqliteStore(process.cwd()).open({
      path: copy,
      readOnly: true,
    });
    if (!opened.ok) invalid("backup cannot be opened read-only");
    const db = opened.handle.value;
    const records = new Map<string, { value: unknown; revision?: number }>();
    let first: string | undefined;
    try {
      for (const record of workRecords(db)) {
        first ??= record.key;
        records.set(record.key, record);
      }
      const localCount = records.size;
      for (const [key, value] of importFloorBaseline(db, eventHighWaterMark)) {
        first ??= key;
        if (!records.has(key)) records.set(key, { value });
      }
      return { records, first, localCount };
    } finally {
      await opened.handle.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
}
export async function compute(options: Options) {
  const source = readJson(options.manifest, "invalid source.json");
  if (
    !isObject(source) ||
    typeof source.sha256 !== "string" ||
    !sha256.test(source.sha256) ||
    typeof source.at !== "string" ||
    typeof source.eventHighWaterMark !== "number" ||
    !Number.isSafeInteger(source.eventHighWaterMark) ||
    source.eventHighWaterMark < 0
  )
    invalid("source.json needs sha256, at and eventHighWaterMark");
  const { sha256: pin, at, eventHighWaterMark } = source;
  if (fs.existsSync(options.out)) invalid("output exists");
  const pages = readPages(options);
  chained(pages);
  const {
    records: local,
    first,
    localCount,
  } = await localRecords(options.backup, pin, eventHighWaterMark);
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
          record.namespace === namespace &&
          family === "allocation" &&
          validateDeclaredWorkRecord(record.key, record.value) !== undefined
        )
          invalid("allocation floor does not match its declared shape");
        if (ordinaryKey(record.namespace, record.key)) {
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
        ...(key.startsWith("allocation:") && { before: before?.value ?? null }),
        after: after.value,
      },
    ];
  });
  const absentInCloud = [...local.keys()]
    .filter((key) => !cloud.has(key))
    .sort();
  const report = {
    format: "forge-cloud-to-local-delta/1",
    source: { sha256: pin, project: options.project },
    pages: pages.length,
    counts: {
      cloudRecords: cloud.size,
      localRecords: localCount,
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
  const names = [
    "dump",
    "backup",
    "manifest",
    "out",
    "dump-manifest",
    "project",
  ];
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
      dumpManifest: one("dump-manifest"),
      project: one("project"),
    });
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  } catch {
    const reply = respond(
      failure(
        "INPUT_INVALID",
        "Expected --dump, --backup, --manifest, --out, --dump-manifest and --project",
      ),
    );
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  }
}
