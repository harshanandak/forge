import * as fs from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { workFamilyPolicy } from "../src/blocks/work/state-families.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { canonicalJson, isObject } from "../src/core/config/pointer.ts";
import { StateOwner } from "../src/core/state/index.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import { ordinaryKey } from "./import-current-state.ts";

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
    !("project" in source) ||
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
  const opened = await createSqliteStore(process.cwd()).open({
    path: resolve(options.store),
    readOnly: !options.write,
  });
  if (!opened.ok) invalid("store cannot be opened");
  try {
    const owner = new StateOwner(
      opened.handle.value,
      { now: () => Date.now() },
      [workFamilyPolicy],
    );
    const identity = owner.get("forge/core-project", "identity")?.value as
      { id?: unknown; projectId?: unknown } | undefined;
    const here =
      identity === undefined
        ? null
        : { id: identity.id, projectId: identity.projectId ?? null };
    if (canonicalJson(here) !== canonicalJson(report.source.project))
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
    if (options.write && report.delta.length > 0) {
      owner.initialize();
      owner.putMany(
        namespace,
        report.delta.map((entry) => ({
          key: entry.key,
          value: entry.after,
          expectRevision: entry.beforeRevision ?? 0,
        })),
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
