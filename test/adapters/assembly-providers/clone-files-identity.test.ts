import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCloneFilesLease } from "../../../src/adapters/fs/clone-files.ts";

test("lock release distinguishes adjacent 64-bit identities and matches identical ones", () => {
  const owned = 2n ** 60n;
  expect(Number(owned)).toBe(Number(owned + 1n));
  for (const difference of [0n, 1n]) {
    const root = fs.realpathSync(
      fs.mkdtempSync(join(tmpdir(), "forge-file-identity-")),
    );
    const path = join(root, "HEAD.lock");
    const lstat = fs.lstatSync;
    const fstat = fs.fstatSync;
    const candidate = spyOn(fs, "lstatSync").mockImplementation(((
      file,
      options,
    ) => {
      const info = lstat(file, options);
      if (file === path && info !== undefined)
        Object.defineProperty(info, "ino", {
          value: options?.bigint
            ? owned + difference
            : Number(owned + difference),
        });
      return info;
    }) as typeof fs.lstatSync);
    const descriptor = spyOn(fs, "fstatSync").mockImplementation(((
      fd,
      options,
    ) => {
      const info = fstat(fd, options);
      Object.defineProperty(info, "ino", {
        value: options?.bigint ? owned : Number(owned),
      });
      return info;
    }) as typeof fs.fstatSync);
    const lease = createCloneFilesLease({
      projectRoot: root,
      gitDirectory: root,
      commonDirectory: root,
      read: true,
      write: true,
      signal: new AbortController().signal,
    });
    try {
      const held = lease.service.lock(["HEAD.lock"]);
      const nonce = fs.readFileSync(path, "utf8");
      held.release();
      expect(fs.existsSync(path)).toBe(difference !== 0n);
      if (difference !== 0n) expect(fs.readFileSync(path, "utf8")).toBe(nonce);
    } finally {
      lease.close();
      candidate.mockRestore();
      descriptor.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 1000);
