import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as windowsAcl from "../../src/adapters/process/windows-acl.ts";
import {
  copyPrivateFile,
  securedFileOps,
  writePrivateFile,
} from "../../src/adapters/store-sqlite/file-ops.ts";
import * as sqlite from "../../src/adapters/store-sqlite/index.ts";
import { privateFileGuard } from "../../src/adapters/store-sqlite/private-files.ts";
import { stateMigrations } from "../../src/core/state/migrations.ts";
import { buildIdentity } from "../../src/version.ts";
import { convert, digest } from "../../tools/import-current.ts";
import * as f from "./import-current-state.fixture.ts";

setDefaultTimeout(30_000);
const entry = new URL("../../tools/prepare-tracker-input.ts", import.meta.url);
const windows = process.platform === "win32";
const prefix = stateMigrations.slice(0, 8);

async function prepareTool() {
  expect(await Bun.file(entry).exists(), "the preparation helper exists").toBe(
    true,
  );
  const { prepare } = (await import(entry.href)) as {
    prepare: (options: {
      backup: string;
      manifest: string;
      out: string;
    }) => Promise<unknown>;
  };
  return prepare;
}

function fixture() {
  const source = f.source(6, false, false, undefined, prefix);
  const old = String(source.db.get("PRAGMA database_list")!.file);
  const root = realpathSync(dirname(old));
  const raw = join(root, "raw");
  const backup = join(raw, "backup.sqlite");
  const manifest = join(raw, "source.json");
  mkdirSync(raw, { mode: 0o700 });
  const guard = windows
    ? privateFileGuard(windowsAcl.windowsPrivateFiles())
    : undefined;
  guard?.directory(raw, true);
  const ops = guard ? securedFileOps(guard) : undefined;
  copyPrivateFile(old, backup, ops);
  writePrivateFile(manifest, Buffer.from(JSON.stringify(source.manifest)), ops);
  return {
    root,
    backup,
    manifest,
    out: join(root, "retained"),
    pinned: source.manifest,
  };
}

test("the CLI retains a private upgraded input that the converter accepts", async () => {
  const input = fixture();
  const result = Bun.spawnSync([
    process.execPath,
    fileURLToPath(entry),
    "--backup",
    input.backup,
    "--manifest",
    input.manifest,
    "--out",
    input.out,
  ]);
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const backup = join(input.out, "backup.sqlite");
  const manifest = join(input.out, "source.json");
  const report = join(input.out, "preparation.json");
  const hash = await digest(backup);
  expect(hash).not.toBe(input.pinned.sha256);
  expect(readdirSync(input.out).sort()).toEqual([
    "backup.sqlite",
    "preparation.json",
    "source.json",
  ]);
  const guard = windows
    ? privateFileGuard(windowsAcl.windowsPrivateFiles(), {
        protectDirectories: false,
      })
    : undefined;
  guard?.directory(input.out);
  if (!windows) expect(statSync(input.out).mode & 0o777).toBe(0o700);
  for (const file of [backup, manifest, report]) {
    guard?.file(file);
    if (!windows) expect(statSync(file).mode & 0o777).toBe(0o600);
  }
  const bundle = await convert({
    backup,
    manifest,
    out: join(input.root, "converted"),
  });
  expect(bundle.source.sha256).toBe(hash);
  expect(await digest(backup)).toBe(hash);
  expect(await digest(input.backup)).toBe(input.pinned.sha256);
  expect(readFileSync(input.manifest, "utf8")).toBe(
    JSON.stringify(input.pinned),
  );

  const db = f.database(backup, true);
  const records = Number(db.get("SELECT COUNT(*) AS n FROM state_records")!.n);
  const eventHighWaterMark = Number(
    db.get("SELECT MAX(sequence) AS n FROM state_events")!.n,
  );
  expect(db.all("SELECT id FROM state_migrations ORDER BY rowid")).toEqual(
    stateMigrations.map(({ id }) => ({ id })),
  );
  expect(JSON.parse(readFileSync(manifest, "utf8")) as unknown).toEqual({
    sha256: hash,
    at: input.pinned.at,
    records,
    eventHighWaterMark,
  });
  expect(JSON.parse(readFileSync(report, "utf8")) as unknown).toMatchObject({
    rawSha256: input.pinned.sha256,
    upgradedSha256: hash,
    build: buildIdentity,
    appliedMigrations: stateMigrations.slice(prefix.length).map(({ id }) => id),
    reconciliation: {
      records: { before: input.pinned.records, after: records },
      eventHighWaterMark: {
        before: input.pinned.eventHighWaterMark,
        after: eventHighWaterMark,
      },
    },
  });
});

test.skipIf(!windows)(
  "source parent and file ACLs are checked before the first SQLite open",
  async () => {
    const prepare = await prepareTool();
    const input = fixture();
    const native = windowsAcl.windowsPrivateFiles();
    const read = spyOn(native, "read");
    const acl = spyOn(windowsAcl, "windowsPrivateFiles").mockReturnValue(
      native,
    );
    const create = sqlite.createSqliteStore;
    const opened = spyOn(sqlite, "createSqliteStore").mockImplementation(
      (...args) => {
        const checked = read.mock.calls.map(([path]) => path);
        expect(checked).toContain(dirname(input.backup));
        expect(checked).toContain(input.backup);
        return create(...args);
      },
    );
    try {
      await prepare(input);
      expect(opened).toHaveBeenCalled();
    } finally {
      opened.mockRestore();
      acl.mockRestore();
    }
  },
);

test.each(["wrong hash", "sidecar", "hard-link alias"] as const)(
  "a %s is refused before SQLite opens and leaves no success manifest",
  async (bad) => {
    const prepare = await prepareTool();
    const input = fixture();
    if (bad === "wrong hash")
      writeFileSync(
        input.manifest,
        JSON.stringify({ ...input.pinned, sha256: "0".repeat(64) }),
      );
    if (bad === "sidecar") writeFileSync(input.backup + "-wal", "");
    if (bad === "hard-link alias")
      linkSync(input.backup, join(dirname(input.backup), "alias.sqlite"));
    const opened = spyOn(sqlite, "createSqliteStore");
    try {
      await expect(prepare(input)).rejects.toThrow();
      expect(opened).not.toHaveBeenCalled();
      expect(existsSync(join(input.out, "source.json"))).toBe(false);
      expect(await digest(input.backup)).toBe(input.pinned.sha256);
    } finally {
      opened.mockRestore();
    }
  },
);

test.skipIf(!windows)(
  "a broad backup ACL is refused before SQLite opens",
  async () => {
    const prepare = await prepareTool();
    const input = fixture();
    const native = windowsAcl.windowsPrivateFiles();
    native.protect(input.backup, "D:P(A;;FA;;;" + native.sid + ")(A;;FR;;;WD)");
    const opened = spyOn(sqlite, "createSqliteStore");
    try {
      await expect(prepare(input)).rejects.toThrow();
      expect(opened).not.toHaveBeenCalled();
      expect(existsSync(join(input.out, "source.json"))).toBe(false);
    } finally {
      opened.mockRestore();
    }
  },
);
