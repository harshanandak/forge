import * as fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { workFamilyPolicy } from "../src/blocks/work/state-families.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson, isObject } from "../src/core/config/pointer.ts";
import { allocationFloorNumber } from "../src/core/state/allocation-floor.ts";
import { StateOwner } from "../src/core/state/index.ts";
import { stateMigrations } from "../src/core/state/migrations.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import { identityOf } from "./cloud-to-local-delta.ts";
import { numbered, ordinaryKey } from "./import-current-state.ts";

const namespace = "forge/work";
const actor = { kind: "agent", id: "cloud-rollback-apply" } as const;
function invalid(reason: string): never {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: `Invalid cloud-to-local apply input: ${reason}`,
    retry: "never",
  });
}
export interface Options {
  report: string;
  manifest: string;
  store: string;
  write: boolean;
  step?: (name: string) => void;
}
interface Entry {
  namespace: string;
  key: string;
  beforeRevision: number | null;
  after: unknown;
}
interface Report {
  source: { sha256: string; project: unknown };
  delta: Entry[];
  notCarriedBack: {
    scope: string;
    keys?: { namespace: string; key: string }[];
  }[];
}
function readJson(path: string, what: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
    if (isObject(value)) return value;
  } catch {
    return invalid(what);
  }
  return invalid(what);
}
function readReport(path: string): Report {
  const report = readJson(path, "report");
  const { source, delta, notCarriedBack } = report;
  if (
    report.format !== "forge-cloud-to-local-delta/1" ||
    !isObject(source) ||
    typeof source.sha256 !== "string" ||
    identityOf(source.project) === undefined ||
    !Array.isArray(delta) ||
    !Array.isArray(notCarriedBack) ||
    !delta.every(
      (entry) =>
        isObject(entry) &&
        typeof entry.namespace === "string" &&
        typeof entry.key === "string" &&
        (entry.beforeRevision === null ||
          Number.isSafeInteger(entry.beforeRevision)) &&
        "after" in entry,
    )
  )
    return invalid("report");
  return report as unknown as Report;
}
function numberOf(key: string) {
  const prefix = key.startsWith(numbered.prefix)
    ? numbered.prefix
    : numbered.family(key);
  const rest = prefix === undefined ? "" : key.slice(prefix.length);
  return prefix !== undefined && /^[1-9][0-9]*$/.test(rest)
    ? { prefix, number: Number(rest) }
    : undefined;
}
export async function apply(options: Options) {
  const report = readReport(options.report);
  if (readJson(options.manifest, "source.json").sha256 !== report.source.sha256)
    invalid("report is from a different backup");
  const barred = new Set(
    report.notCarriedBack.flatMap((left) => [
      left.scope,
      ...(left.keys ?? []).map((k) => JSON.stringify([k.namespace, k.key])),
    ]),
  );
  for (const entry of report.delta)
    if (
      entry.namespace !== namespace ||
      entry.key.startsWith("allocation:") ||
      !ordinaryKey(entry.namespace, entry.key) ||
      barred.has(`${entry.namespace}:${entry.key.split(":")[0]}:*`) ||
      barred.has(JSON.stringify([entry.namespace, entry.key]))
    )
      invalid("report lists a record that is not carried back");
  if (!fs.existsSync(options.store)) invalid("store does not exist");
  const path = resolve(options.store);
  const store = createSqliteStore(process.cwd(), {
    step: (name) => {
      options.step?.(name);
      if (name === "identity-checked" && !fs.existsSync(path))
        invalid("store does not exist");
    },
  });
  const opened = await store.open({
    path,
    readOnly: !options.write,
  });
  if (!opened.ok) invalid("store cannot be opened");
  try {
    const applied = opened.handle.value
      .all("SELECT id FROM state_migrations ORDER BY id")
      .map((row) => String(row.id));
    if (
      canonicalJson(applied) !==
      canonicalJson(stateMigrations.map((migration) => migration.id).sort())
    )
      invalid("store migrations differ from the expected set");
    const owner = new StateOwner(
      opened.handle.value,
      { now: () => Date.now() },
      [workFamilyPolicy],
    );
    const here = identityOf(owner.get("forge/core-project", "identity")?.value);
    if (!here) invalid("store has no project identity");
    if (
      canonicalJson(here) !== canonicalJson(identityOf(report.source.project))
    )
      invalid("report is from a different project");
    for (const entry of report.delta)
      if (
        (owner.get(namespace, entry.key)?.revision ?? 0) !==
        (entry.beforeRevision ?? 0)
      )
        invalid(`local store changed since the backup at ${entry.key}`);
    const created = report.delta.filter(
      (e) => e.beforeRevision === null,
    ).length;
    const highest = new Map<string, number>();
    for (const entry of report.delta) {
      const found =
        entry.beforeRevision === null ? numberOf(entry.key) : undefined;
      if (found)
        highest.set(
          found.prefix,
          Math.max(highest.get(found.prefix) ?? 0, found.number),
        );
    }
    const floors = [...highest].flatMap(([prefix, number]) => {
      const key = `allocation:${prefix}`;
      const record = owner.get(namespace, key);
      if (!record) return [];
      const held = allocationFloorNumber(record.value, prefix);
      if (held === undefined) invalid(`allocation floor ${key} is malformed`);
      return number > held
        ? [{ key, value: { prefix, number }, expectRevision: record.revision }]
        : [];
    });
    if (options.write && report.delta.length > 0) {
      options.step?.("preflighted");
      owner.putMany(
        namespace,
        [
          ...report.delta.map((entry) => ({
            key: entry.key,
            value: entry.after,
            expectRevision: entry.beforeRevision ?? 0,
          })),
          ...floors,
        ],
        actor,
      );
    }
    return {
      mode: options.write ? ("applied" as const) : ("dry-run" as const),
      new: created,
      changed: report.delta.length - created,
    };
  } finally {
    await opened.handle.close();
  }
}
export async function run(options: Options) {
  try {
    return respond(success("cloud-to-local-apply", await apply(options)));
  } catch (error) {
    return respond(
      failure(
        error instanceof ForgeFailure ? error.error.code : "UNAVAILABLE",
        "Cloud-to-local apply refused; nothing applied",
      ),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        report: { type: "string" },
        manifest: { type: "string" },
        store: { type: "string" },
        write: { type: "boolean" },
      },
    });
    if (!values.report || !values.manifest || !values.store)
      invalid("arguments");
    const reply = await run({
      report: values.report,
      manifest: values.manifest,
      store: values.store,
      write: values.write === true,
    });
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  } catch {
    const reply = respond(
      failure("INPUT_INVALID", "Expected --report, --manifest, --store"),
    );
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  }
}
