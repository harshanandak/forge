import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson } from "../src/core/config/pointer.ts";
import { parseRestoreJson } from "../src/core/state/restore-json.ts";
import type { StateRecord } from "../src/generated/types.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import { PAGE_FORMAT, parseDump, type Page } from "../cloud/src/dump.ts";
import { digest } from "./import-current.ts";
import {
  importDispositions,
  ordinaryKey,
  workRecords,
} from "./import-current-state.ts";

const namespace = "forge/work";
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
const unmappedReason =
  "no local counterpart in the forward converter's mapping";
const fieldsReason =
  "cloud assigns these on every write; the local store assigns its own when the delta is applied";

function invalid(): never {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Invalid cloud-to-local delta input",
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
  if (names.length === 0) invalid();
  return names.map((name, index) => {
    const page = parseDump(
      fs.readFileSync(join(directory, name), "utf8"),
    ) as Page;
    if (
      page.format !== PAGE_FORMAT ||
      page.page !== index ||
      page.last !== (index === names.length - 1)
    )
      invalid();
    return page;
  });
}
async function localRecords(path: string, pin: string) {
  if ((await digest(path)) !== pin) invalid();
  const opened = await createSqliteStore(process.cwd()).open({
    path: resolve(path),
    readOnly: true,
  });
  if (!opened.ok) invalid();
  const records = new Map<string, StateRecord>();
  try {
    for (const record of workRecords(opened.handle.value))
      if (!record.key.startsWith("allocation:"))
        records.set(record.key, record);
  } finally {
    await opened.handle.close();
  }
  if ((await digest(path)) !== pin) invalid();
  return records;
}
export async function compute(options: Options) {
  const pin = (
    JSON.parse(fs.readFileSync(options.manifest, "utf8")) as {
      sha256?: unknown;
    }
  ).sha256;
  if (typeof pin !== "string" || !/^[a-f0-9]{64}$/.test(pin)) invalid();
  if (fs.existsSync(options.out)) invalid();
  const pages = readPages(options.dump);
  const local = await localRecords(options.backup, pin);
  const cloud = new Map<string, StateRecord>();
  const left = new Map<
    string,
    { scope: string; reason: string; count: number }
  >();
  const note = (scope: string, reason: string, count = 1) => {
    const entry = left.get(scope) ?? { scope, reason, count: 0 };
    entry.count += count;
    left.set(scope, entry);
  };
  for (const page of pages)
    for (const [table, rows] of Object.entries(page.tables)) {
      if (table !== "state_records") {
        note(table, tableReasons[table] ?? unmappedReason, rows.length);
        continue;
      }
      for (const row of rows) {
        const record = parseRestoreJson(String(row.body)) as StateRecord;
        if (record.namespace !== row.namespace || record.key !== row.key)
          invalid();
        const family = record.key.split(":")[0]!;
        if (
          record.key.startsWith("allocation:") &&
          record.namespace === namespace
        )
          note(`${namespace}:allocation:*`, floorReason);
        else if (ordinaryKey(record.namespace, record.key)) {
          if (cloud.has(record.key)) invalid();
          cloud.set(record.key, record);
        } else if (record.namespace === namespace)
          note(
            `${namespace}:${family}:*`,
            importDispositions[family]?.reason ?? unmappedReason,
          );
        else note(`${record.namespace}:*`, unmappedReason);
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
    source: { sha256: pin },
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
    invalid();
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
      return Array.isArray(found) && found.length === 1 ? found[0]! : invalid();
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
