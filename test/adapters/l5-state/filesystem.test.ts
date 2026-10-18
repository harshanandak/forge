import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  probeFilesystem,
  type FilesystemProbe,
} from "../../../src/adapters/store-sqlite/filesystem.ts";
import { classifyFilesystem } from "../../../src/core/state/fs-class.ts";

function fake(
  platform: string,
  type: number,
  target = "Z:\\state",
): FilesystemProbe {
  return { platform, statfs: () => ({ type }), realpath: () => target };
}

test("mounted remote filesystems are refused before creating or opening SQLite", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-mount-probe-")));
  try {
    for (const [platform, type] of [
      ["linux", 0x6969],
      ["linux", 0xff534d42],
      ["linux", 0x517b],
      ["linux", 0xfe534d42],
      ["linux", 0x5346414f],
      ["linux", 0x6b414653],
      ["linux", 0x00c36400],
      ["linux", 0x73757245],
      ["linux", 0x564c],
      ["linux", 0x01021997],
      ["darwin", 2],
    ] as const) {
      const calls: string[] = [];
      const filesystem: FilesystemProbe = {
        ...fake(platform, type),
        statfs(parent) {
          calls.push(parent);
          return { type };
        },
      };
      const path = join(work, "state.db");
      const steps: string[] = [];
      const opened = await createSqliteStore(work, {
        filesystem,
        step: (step) => steps.push(step),
      }).open({ path, readOnly: false });
      if (opened.ok) await opened.handle.close();
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.unavailable.reason).toContain("network");
      expect(calls).toEqual([work]);
      expect(steps).toEqual([]);
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("a Windows mapped drive resolved to UNC is refused before SQLite opens", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-mapped-probe-")));
  try {
    const filesystem = fake("win32", 0, "\\\\server\\share\\state");
    const path = join(work, "state.db");
    const opened = await createSqliteStore(work, { filesystem }).open({
      path,
      readOnly: false,
    });
    if (opened.ok) await opened.handle.close();
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.unavailable.reason).toContain("network");
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("local ext4, APFS and NTFS stores remain usable; ambiguous types stay warnings", async () => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "forge-local-probe-")));
  try {
    for (const filesystem of [
      fake("linux", 0xef53),
      fake("darwin", 25),
      fake("win32", 0),
      fake("linux", 0x5346544e),
      fake("linux", 0x65735546),
      fake("linux", 0xdeadbeef),
    ]) {
      const opened = await createSqliteStore(work, { filesystem }).open({
        path: join(work, "state.db"),
        readOnly: false,
      });
      if (!opened.ok) throw new Error(opened.unavailable.reason);
      try {
        expect(Number(opened.handle.value.get("SELECT 1 AS n")?.n)).toBe(1);
      } finally {
        await opened.handle.close();
      }
    }
    for (const filesystem of [
      fake("darwin", 25),
      fake("win32", 0),
      fake("linux", 0x65735546),
      fake("linux", 0xdeadbeef),
    ]) {
      expect(
        classifyFilesystem({
          path: "/state.db",
          platform: filesystem.platform,
          ...probeFilesystem(work, filesystem),
        }),
      ).toEqual({ kind: "unknown", risk: "warn" });
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);

test("probe failure is unknown and Linux magic numbers are not interpreted on macOS", () => {
  expect(
    probeFilesystem("/state", {
      ...fake("linux", 0),
      statfs() {
        throw new Error("unsupported");
      },
    }),
  ).toEqual({ driveType: "unknown" });
  expect(probeFilesystem("/state", fake("darwin", 0x6969))).toEqual({
    driveType: "unknown",
  });
  expect(probeFilesystem("Z:\\state", fake("win32", 0))).toEqual({
    driveType: "unknown",
  });
}, 30000);
