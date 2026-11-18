import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { windowsPrivateFiles } from "../src/adapters/process/windows-acl.ts";
import * as files from "../src/adapters/store-sqlite/file-ops.ts";
import {
  privateFileGuard,
  type PrivateFileGuard,
} from "../src/adapters/store-sqlite/private-files.ts";
import { StateOwner } from "../src/core/state/index.ts";
import {
  identifier,
  migrate,
  stateMigrations,
} from "../src/core/state/migrations.ts";
import type { OwnedHandle } from "../src/ports/lifetime.ts";
import type { SqlDatabase, SqlValue } from "../src/ports/store.ts";
import { packageRoot, version } from "../src/version.ts";
import { gitExecutable } from "./git-executable.ts";
import * as converter from "./import-current.ts";
import { verifySource, verifySourceSchema } from "./import-current-state.ts";

function privateEntry(
  path: string,
  directory: boolean,
  acl?: PrivateFileGuard,
) {
  const stat = fs.lstatSync(path, { bigint: true });
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) ||
    relative(path, fs.realpathSync(path)) !== ""
  )
    throw new Error("Preparation path is aliased or has the wrong type");
  if (acl) {
    if (directory) acl.directory(path);
    else acl.file(path);
  } else if (
    stat.uid !== BigInt(process.getuid!()) ||
    (stat.mode & 0o077n) !== 0n
  )
    throw new Error("Preparation path is accessible to other users");
  return stat;
}

function standalone(path: string, acl?: PrivateFileGuard) {
  privateEntry(dirname(path), true, acl);
  const stat = privateEntry(path, false, acl);
  if (
    ["-wal", "-shm", "-journal"].some((suffix) =>
      fs.lstatSync(path + suffix, { throwIfNoEntry: false }),
    )
  )
    throw new Error("Preparation backup has a SQLite sidecar");
  converter.isolatedBackup(path);
  return stat;
}

function build() {
  const executable = gitExecutable();
  const git = (...args: string[]) =>
    execFileSync(executable, ["-C", fileURLToPath(packageRoot), ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    }).trim();
  const commit = git("rev-parse", "--verify", "HEAD");
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Preparation requires a recorded source commit");
  return {
    version,
    commit,
    dirty: git("status", "--porcelain", "--untracked-files=no") !== "",
  };
}

function tableDigest(db: SqlDatabase, name: string) {
  const select = "SELECT rowid AS migration_rowid,* FROM " + identifier(name);
  const hash = createHash("sha256");
  let rows = 0;
  let cursor: SqlValue | undefined;
  for (;;) {
    const where = cursor === undefined ? "" : " WHERE rowid>?";
    const page = db.all(
      select + where + " ORDER BY rowid LIMIT 128",
      cursor === undefined ? [] : [cursor],
    );
    for (const row of page)
      hash
        .update(
          JSON.stringify(row, (_key, value: unknown) =>
            typeof value === "bigint" ? { integer: value.toString() } : value,
          ),
        )
        .update("\n");
    rows += page.length;
    if (page.length < 128) break;
    cursor = page.at(-1)!.migration_rowid!;
  }
  return { rows, sha256: hash.digest("hex") };
}

function snapshot(db: SqlDatabase) {
  const schema = db.all(
    "SELECT type,name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name",
  );
  const tables = Object.fromEntries(
    schema
      .filter(({ type }) => type === "table")
      .map(({ name }) => [String(name), tableDigest(db, String(name))]),
  );
  const select = tables.state_retention
    ? "SELECT sequence AS n FROM state_retention WHERE id=1"
    : "SELECT COALESCE(MAX(sequence),0) AS n FROM state_events";
  const eventHighWaterMark = Number(db.get(select)?.n);
  return {
    metrics: { records: tables.state_records!.rows, eventHighWaterMark },
    tables,
    schema,
  };
}

export async function prepare(
  paths: Pick<converter.Options, "backup" | "manifest" | "out">,
) {
  const backup = resolve(paths.backup);
  const manifestPath = resolve(paths.manifest);
  const out = resolve(paths.out);
  const acl =
    process.platform === "win32"
      ? privateFileGuard(windowsPrivateFiles(), {
          protectDirectories: false,
          requireOwner: true,
        })
      : undefined;
  privateEntry(dirname(manifestPath), true, acl);
  privateEntry(manifestPath, false, acl);
  const raw = standalone(backup, acl);
  const pin = converter.sourceManifest(manifestPath);
  const at = Date.parse(pin.at);
  if (
    typeof pin.at !== "string" ||
    !Number.isFinite(at) ||
    new Date(at).toISOString() !== pin.at ||
    (await converter.digest(backup)) !== pin.sha256
  )
    throw new Error("Invalid source date or backup hash");
  const identity = build();
  privateEntry(dirname(out), true, acl);
  fs.mkdirSync(out, { mode: 0o700 });
  acl?.directory(out, true);
  privateEntry(out, true, acl);
  const copy = join(out, "backup.sqlite");
  const ops = acl ? files.securedFileOps(acl) : undefined;
  files.copyPrivateFile(backup, copy, ops);
  standalone(copy, acl);
  if ((await converter.digest(copy)) !== pin.sha256)
    throw new Error("Private copy does not match the source hash");

  const handles: OwnedHandle<SqlDatabase>[] = [];
  const clock = { now: () => at };
  const { before, after, appliedMigrations } = await (async () => {
    const source = await converter.opened(copy, true, handles, acl);
    const integrity = source.all("PRAGMA integrity_check");
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok")
      throw new Error("Copy failed SQLite integrity check");
    const migrations = converter.migrationPrefix(source);
    const schema = await converter.opened(":memory:", false, handles);
    migrate(schema, migrations);
    verifySourceSchema(source, schema);
    const before = snapshot(source);
    if (
      before.metrics.records !== pin.records ||
      before.metrics.eventHighWaterMark !== pin.eventHighWaterMark
    )
      throw new Error("Source metadata disagrees with the pinned backup");
    const pending = stateMigrations.slice(migrations.length);
    if (pending.length > 0) {
      const writable = await converter.opened(copy, false, handles, acl);
      converter.migrateVerifiedCopy(writable, schema, clock);
    }
    new StateOwner(schema, clock).initialize();
    const after = snapshot(source);
    if (
      ["state_records", "state_events"].some(
        (table) => before.tables[table]?.sha256 !== after.tables[table]?.sha256,
      )
    )
      throw new Error("Pinned migrations changed record or event rows");
    verifySource(source, { ...pin, ...after.metrics }, schema);
    return { before, after, appliedMigrations: pending.map(({ id }) => id) };
  })().finally(async () => {
    await Promise.all(handles.reverse().map(async (handle) => handle.close()));
  });

  standalone(copy, acl);
  const fd = fs.openSync(copy, "r+");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const sha256 = await converter.digest(copy);
  const source = { ...after.metrics, sha256, at: pin.at };
  const report = {
    rawSha256: pin.sha256,
    upgradedSha256: sha256,
    build: identity,
    appliedMigrations,
    reconciliation: {
      records: { before: before.metrics.records, after: after.metrics.records },
      eventHighWaterMark: {
        before: before.metrics.eventHighWaterMark,
        after: after.metrics.eventHighWaterMark,
      },
      tables: { before: before.tables, after: after.tables },
      schema: { before: before.schema, after: after.schema },
    },
  };
  files.writePrivateFolder(
    out,
    { "preparation.json": Buffer.from(JSON.stringify(report)) },
    acl,
  );
  const finalRaw = standalone(backup, acl);
  if (
    finalRaw.dev !== raw.dev ||
    finalRaw.ino !== raw.ino ||
    (await converter.digest(backup)) !== pin.sha256
  )
    throw new Error("Raw backup changed during preparation");
  const staging = ".source.json.tmp";
  files.writePrivateFolder(
    out,
    { [staging]: Buffer.from(JSON.stringify(source)) },
    acl,
  );
  const manifest = join(out, "source.json");
  fs.renameSync(join(out, staging), manifest);
  try {
    files.syncParentDirectory(manifest, ops);
  } catch (error) {
    files.removeDurable(manifest, { force: true }, ops);
    throw error;
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      options: {
        backup: { type: "string", multiple: true },
        manifest: { type: "string", multiple: true },
        out: { type: "string", multiple: true },
      },
    });
    const one = (flag?: string[]) => {
      if (flag?.length !== 1 || !flag[0]) throw new Error("Expected a path");
      return flag[0];
    };
    await prepare({
      backup: one(values.backup),
      manifest: one(values.manifest),
      out: one(values.out),
    });
  } catch {
    process.stderr.write(
      "Tracker input preparation refused. Check the source, manifest and private output path.\n",
    );
    process.exitCode = 1;
  }
}
