import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteStore } from "../src/adapters/store-sqlite/index.ts";
import { hardenPrivatePaths } from "../src/adapters/store-sqlite/private-acl.ts";
import { createProcessPort } from "../src/adapters/process/index.ts";
import { ForgeFailure } from "../src/contract/failure.ts";
import { StateOwner } from "../src/core/state/index.ts";
import type { SqlDatabase } from "../src/ports/store.ts";
import type { OwnedHandle } from "../src/ports/lifetime.ts";
import { success } from "../src/surface/dispatch.ts";
import { failure, respond } from "../src/surface/result.ts";
import {
  limitsFrom,
  parseDump,
  restorePage,
  type Limits,
  type Page,
} from "../cloud/src/dump.ts";
import { domain } from "../cloud/src/project.ts";
import {
  COLUMNS,
  KEYS,
  TABLES,
  digests,
  fold,
  tally,
} from "../cloud/conformance/digest.ts";
import {
  currentState,
  pagesOf,
  type SourceManifest,
} from "./import-current-state.ts";

const invalid = (): never => {
  throw new ForgeFailure({
    code: "INPUT_INVALID",
    message: "Invalid offline import input or readback",
    retry: "never",
  });
};
export async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Uint8Array);
  return hash.digest("hex");
}
function sourceManifest(path: string): SourceManifest {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as SourceManifest;
    if (
      !value ||
      Object.keys(value).sort().join() !==
        "at,eventHighWaterMark,records,sha256"
    )
      invalid();
    return value;
  } catch {
    return invalid();
  }
}
function isolatedBackup(path: string): void {
  const stat = lstatSync(path),
    header = Buffer.alloc(20);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    ["-wal", "-shm", "-journal"].some((suffix) => existsSync(path + suffix))
  )
    invalid();
  const fd = openSync(path, "r");
  try {
    if (readSync(fd, header) !== 20 || header[18] !== 1 || header[19] !== 1)
      invalid();
  } finally {
    closeSync(fd);
  }
}
async function opened(
  path: string,
  readOnly: boolean,
  handles: OwnedHandle<SqlDatabase>[],
) {
  const result = await createSqliteStore(dirname(resolve(path))).open({
    path,
    readOnly,
  });
  if (!result.ok) throw new Error("Cannot open offline scratch or backup");
  handles.push(result.handle);
  return result.handle.value;
}
/** Bounded keyset scans use exactly the dump's column and key order, including empty tables. */
export function imageDigests(db: SqlDatabase) {
  const t = tally();
  for (const table of TABLES) {
    let after: (string | number)[] | undefined;
    for (;;) {
      const keys = KEYS[table].join(",");
      const rows = db.all(
        `SELECT ${COLUMNS[table].join(",")} FROM ${table}${after ? ` WHERE (${keys}) > (${after.map(() => "?").join(",")})` : ""} ORDER BY ${keys} LIMIT 128`,
        after,
      );
      for (const row of rows) {
        const normal = { ...row };
        for (const column of COLUMNS[table])
          if (typeof normal[column] === "bigint")
            normal[column] = Number(normal[column]);
        fold(t, table, normal);
      }
      if (rows.length < 128) break;
      after = KEYS[table].map((key) => {
        const value = rows.at(-1)![key];
        return typeof value === "bigint"
          ? Number(value)
          : (value as string | number);
      });
    }
  }
  return digests(t);
}
export interface Options {
  backup: string;
  manifest: string;
  out: string;
  limits?: Limits;
}
export async function convert(options: Options) {
  const { backup, out } = options,
    manifest = sourceManifest(options.manifest),
    limits = options.limits ?? limitsFrom({});
  const handles: OwnedHandle<SqlDatabase>[] = [];
  const checkPin = async () => {
    if ((await digest(backup)) !== manifest.sha256) invalid();
  };
  try {
    isolatedBackup(backup);
    await checkPin();
    const source = await opened(resolve(backup), true, handles);
    source.exec("BEGIN");
    if (
      JSON.stringify(source.all("PRAGMA integrity_check")) !==
      '[{"integrity_check":"ok"}]'
    )
      invalid();
    const scratch = await opened(":memory:", false, handles);
    new StateOwner(scratch, {
      now: () => Date.parse(manifest.at),
    }).initialize();
    const projected = currentState(source, scratch, manifest, limits);
    const expected = imageDigests(scratch);
    const target = await opened(":memory:", false, handles),
      owner = new StateOwner(target, { now: () => Date.parse(manifest.at) });
    owner.initialize([domain]);
    mkdirSync(out, { mode: 0o700 });
    if (process.platform === "win32")
      await hardenPrivatePaths(
        [out],
        createProcessPort(),
        Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      );
    const pages: { name: string; sha256: string; bytes: number }[] = [];
    for (const page of pagesOf(scratch, limits)) {
      const name = `page-${String(page.page).padStart(4, "0")}.json`,
        file = join(out, name);
      const bytes = JSON.stringify(page);
      writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      const readback = readFileSync(file);
      const sha256 = createHash("sha256").update(readback).digest("hex");
      restorePage(
        target,
        owner,
        parseDump(readback.toString("utf8")) as Page,
        limits,
      );
      pages.push({ name, sha256, bytes: readback.byteLength });
    }
    if (JSON.stringify(imageDigests(target)) !== JSON.stringify(expected))
      invalid();
    isolatedBackup(backup);
    await checkPin();
    const count = (table: string) =>
      Number(source.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
    const bundle = {
      format: "forge-current-bundle/1",
      source: manifest,
      N: projected.records,
      F: projected.floors,
      rows: projected.usage.rows,
      events: projected.events,
      tables: expected,
      stored: projected.usage.bytes,
      limits,
      pages,
      relinquishedLeases: count("state_leases"),
      droppedRequests: count("state_requests"),
      activation: "requires-step-8-stop",
    };
    const file = join(out, "manifest.json"),
      bytes = JSON.stringify(bundle);
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
    try {
      if (JSON.stringify(JSON.parse(readFileSync(file, "utf8"))) !== bytes)
        invalid();
    } catch (error) {
      unlinkSync(file);
      throw error;
    }
    return bundle;
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
}
export async function run(options: Options) {
  try {
    return respond(success("import-current", await convert(options)));
  } catch (error) {
    return respond(
      failure(
        error instanceof ForgeFailure ? error.error.code : "UNAVAILABLE",
        "Offline import refused; no verified complete bundle",
      ),
    );
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values: flags } = parseArgs({
      options: Object.fromEntries(
        [
          "backup",
          "manifest",
          "out",
          "max-rows",
          "max-bytes",
          "page-bytes",
        ].map((name) => [name, { type: "string", multiple: true }]),
      ),
    });
    if (
      Object.values(flags).some(
        (values) => !Array.isArray(values) || values.length !== 1,
      )
    )
      invalid();
    const one = (name: string) => flags[name]?.[0];
    if (!["backup", "manifest", "out"].every(one)) invalid();
    const vars: Record<string, string> = {};
    for (const [flag, key] of [
      ["max-rows", "DUMP_MAX_ROWS"],
      ["max-bytes", "DUMP_MAX_BYTES"],
      ["page-bytes", "DUMP_PAGE_BYTES"],
    ]) {
      const value = one(flag!);
      if (value === undefined) continue;
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
        invalid();
      vars[key!] = value;
    }
    const reply = await run({
      backup: one("backup")!,
      manifest: one("manifest")!,
      out: one("out")!,
      limits: limitsFrom(vars),
    });
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  } catch {
    const reply = respond(
      failure(
        "INPUT_INVALID",
        "Expected --backup, --manifest, --out and optional positive --max-rows, --max-bytes, --page-bytes",
      ),
    );
    process.stdout.write(JSON.stringify(reply.envelope) + "\n");
    process.exitCode = reply.exitCode;
  }
}
