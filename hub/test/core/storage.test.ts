import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectStorage, createPrivateFile } from "../../src/core/index.ts";
import { refuseNetworkPath } from "../../src/core/storage.ts";
import { closeDb, fixture } from "./fixture.ts";

const timeout = 30_000;

test(
  "Q3: doctor checks preserve the DB bytes",
  async () => {
    const { config, db, path, root } = await fixture();
    const rows = (dataDir = config.dataDir) =>
      inspectStorage({ ...config, dataDir });
    const check = (name: string, snapshot = rows()) =>
      snapshot.find((row) => row.check === name);
    const before = await readFile(path);
    const privateDir = "The data directory is private.";
    const compatible = "The database schema is compatible.";
    const absent = "The effect worker lock file is absent.";
    const initial = rows();
    expect(initial).toHaveLength(4);
    expect(check("data_directory", initial)).toMatchObject({
      status: "ok",
      detail: privateDir,
    });
    expect(check("storage_placement", initial)?.status).toMatch(
      /^(ok|skipped)$/,
    );
    expect(check("schema_version", initial)).toMatchObject({
      status: "ok",
      detail: compatible,
    });
    expect(check("service_lock", initial)).toMatchObject({
      status: "ok",
      detail: absent,
    });
    expect(await readFile(path)).toEqual(before);

    const lock = await createPrivateFile(path + ".worker.lock");
    if (!lock) throw new Error("Could not create the fixture lock file");
    await lock.close();
    expect(check("service_lock")).toMatchObject({
      status: "skipped",
      detail: "Cannot tell whether the effect worker lock is held.",
    });
    db.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    const unsupported = await readFile(path);
    expect(check("schema_version")).toMatchObject({
      status: "action",
      detail: "The database schema is incompatible.",
    });
    expect(await readFile(path)).toEqual(unsupported);
    db.exec("UPDATE meta SET value = '1'; DROP TABLE chat_kv");
    const incomplete = rows();
    expect(check("schema_version", incomplete)?.status).toBe("action");
    expect(JSON.stringify(incomplete)).not.toContain(config.dataDir);
    if (process.platform !== "win32") {
      const sidecar = await stat(path + "-shm").catch(() => undefined);
      if (sidecar) expect(sidecar.mode & 0o077).toBe(0);
    }
    const missing = check("data_directory", rows(join(root, "missing")));
    expect(missing).toMatchObject({
      status: "action",
      detail: "The data directory is missing.",
    });
    closeDb(db);
    await unlink(path);
    const schema = check("schema_version");
    expect(schema).toMatchObject({
      status: "skipped",
      detail: "The database is not initialised.",
    });
  },
  timeout,
);

test(
  "Q3: doctor refuses a sidecar with broad permissions",
  async () => {
    const { config, path } = await fixture();
    const sidecar = path + "-journal";
    await writeFile(sidecar, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      const root = process.env.SystemRoot ?? "C:\\Windows";
      const icacls = join(root, "System32", "icacls.exe");
      execFileSync(icacls, [sidecar, "/grant", "*S-1-1-0:R"], {
        stdio: "ignore",
        timeout,
        windowsHide: true,
      });
    } else {
      await chmod(sidecar, 0o644);
    }
    expect(inspectStorage(config)).toContainEqual({
      check: "schema_version",
      status: "action",
      detail: "A sidecar is not private.",
    });
  },
  timeout,
);

test(
  "Q4: refuse UNC and the most specific network mount",
  () => {
    const refusal = "The data directory must be on a local filesystem.";
    const local = "/dev/sda1 / ext4 rw 0 0";
    const nfs = "host:/e / nfs rw 0 0";
    for (const [path, mounts] of [
      ["\\\\server\\share\\hub", undefined],
      ["//server/share/x", undefined],
      ["/data/hub", "host:/e /data nfs4 rw 0 0"],
      ["/mnt/s/hub", "//srv/s /mnt/s cifs rw 0 0"],
      ["/mnt/x/hub", "h:/p /mnt/x fuse.sshfs rw 0 0"],
      ["/mnt/s w/hub", "//srv/s /mnt/s\\040w smb3 rw 0 0"],
    ] as const)
      expect(refuseNetworkPath(path, mounts)).toBe(refusal);
    const nested = nfs + "\n/dev/sda1 /data ext4 rw 0 0";
    const sibling = local + "\nhost:/e /data nfs rw 0 0";
    for (const [path, mounts] of [
      ["/var/hub", local],
      ["/data/hub", nested],
      ["/database/hub", sibling],
      ["/missing", ""],
    ] as const)
      expect(refuseNetworkPath(path, mounts)).toBeUndefined();
  },
  timeout,
);
