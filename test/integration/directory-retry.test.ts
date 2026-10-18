import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { LocalState } from "../../src/assembly/state.ts";
import { sqliteStore } from "../../src/adapters/store-sqlite/index.ts";
import type { DirectoryCreatePort } from "../../src/adapters/store-sqlite/file-ops.ts";

test("a retry syncs the existing directory left by a failed parent sync before acknowledging state", async () => {
  const root = resolve("directory-retry");
  const known = new Set<string>();
  for (let path = root; ; path = dirname(path)) {
    known.add(path);
    if (dirname(path) === path) break;
  }
  const descriptors = new Map<number, string>();
  const events: string[] = [];
  let next = 0,
    failed = false,
    opens = 0;
  const fs: DirectoryCreatePort = {
    platform: "linux",
    statSync(path) {
      if (!known.has(path))
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { isDirectory: () => true };
    },
    mkdirSync(path, options) {
      expect(options.mode).toBe(0o700);
      known.add(path);
    },
    openSync(path) {
      const fd = ++next;
      descriptors.set(fd, path);
      return fd;
    },
    fsyncSync(fd) {
      const parent = descriptors.get(fd)!;
      if (parent === root && !failed) {
        failed = true;
        throw new Error("injected parent sync failure");
      }
      events.push(`sync:${parent}`);
    },
    closeSync(fd) {
      expect(descriptors.delete(fd)).toBe(true);
    },
  };
  const state = new LocalState(
    join(root, "a/b/c/state.sqlite"),
    {
      async open() {
        expect(
          events,
          "retry must re-sync the failed parent before opening storage",
        ).toContain(`sync:${root}`);
        opens++;
        events.push("store-open");
        return sqliteStore.open({ path: ":memory:", readOnly: false });
      },
    },
    fs,
  );
  try {
    await rejects(state.acquire(true), /injected parent sync failure/);
    expect(known.has(join(root, "a"))).toBe(true);
    expect(opens).toBe(0);
    expect(descriptors.size).toBe(0);
    events.length = 0;
    const lease = await state.acquire(true);
    try {
      expect(
        lease.value!.put(
          "example.org/retry",
          "first",
          {},
          { kind: "human", id: "test" },
          { expectRevision: 0 },
        ).revision,
      ).toBe(1);
      events.push("acknowledged");
      expect(events.indexOf(`sync:${root}`)).toBeLessThan(
        events.indexOf("store-open"),
      );
      expect(events.indexOf("store-open")).toBeLessThan(
        events.indexOf("acknowledged"),
      );
      expect(opens).toBe(1);
    } finally {
      await lease.close();
    }
    expect(descriptors.size).toBe(0);
  } finally {
    await state.close();
  }
}, 30000);
