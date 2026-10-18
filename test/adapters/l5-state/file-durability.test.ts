import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  adoptPrivateFile,
  makePrivateTempDirectory,
} from "../../../src/adapters/store-sqlite/file-ops.ts";
import { StateOwner } from "../../../src/core/state/index.ts";

const posixTest = process.platform === "win32" ? test.skip : test;

posixTest(
  "new store is private on POSIX (Windows has no POSIX mode bits)",
  async () => {
    const work = realpathSync(
      mkdtempSync(join(tmpdir(), "forge-private-store-")),
    );
    const path = join(work, "state.db");
    const priorUmask = process.umask(0o022);
    try {
      const opened = await createSqliteStore(work).open({
        path,
        readOnly: false,
      });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        expect(statSync(path).mode & 0o777).toBe(0o600);
      } finally {
        await opened.handle.close();
      }
    } finally {
      process.umask(priorUmask);
      rmSync(work, { recursive: true, force: true });
    }
  },
  30000,
);

test("restore syncs its parent after removing the fence", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-fence-sync-")));
  const fence = join(work, "state.db.restore-lock");
  const calls: boolean[] = [];
  const source = await createSqliteStore(work).open({
    path: ":memory:",
    readOnly: false,
  });
  const target = await createSqliteStore(work, {
    fs: {
      platform: "linux",
      openSync(path, flags) {
        expect(path).toBe(work);
        expect(flags).toBe("r");
        return 123;
      },
      fsyncSync(fd) {
        expect(fd).toBe(123);
        calls.push(existsSync(fence));
      },
      closeSync(fd) {
        expect(fd).toBe(123);
      },
      renameSync(from, to) {
        renameSync(from, to);
      },
    },
  }).open({ path: "state.db", readOnly: false });
  if (!source.ok || !target.ok) throw new Error("store open failed");
  try {
    const left = new StateOwner(source.handle.value, { now: () => 1 });
    const right = new StateOwner(target.handle.value, { now: () => 1 });
    left.initialize();
    right.initialize();
    right.restore(left.export());
    expect(existsSync(fence)).toBe(false);
    expect(calls.at(-1)).toBe(false);
  } finally {
    await source.handle.close();
    await target.handle.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

posixTest(
  "SQLite output is adopted privately inside a private temp directory",
  () => {
    const priorUmask = process.umask(0o022);
    try {
      const directory = makePrivateTempDirectory(
        join(tmpdir(), "forge-private-export-"),
      );
      try {
        const path = join(directory, "snapshot.db");
        writeFileSync(path, "snapshot");
        expect(statSync(path).mode & 0o777).toBe(0o644);
        adoptPrivateFile(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(statSync(directory).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    } finally {
      process.umask(priorUmask);
    }
  },
  30000,
);
