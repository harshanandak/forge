import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalState } from "../../src/assembly/state.ts";
import type { StorePort } from "../../src/ports/store.ts";

test("failed store open releases the recovery reservation for a retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-reinit-open-"));
  const path = join(root, "state.sqlite");
  const store: StorePort = {
    open: () =>
      Promise.resolve({
        ok: false,
        unavailable: {
          kind: "unavailable",
          reason: "injected open failure",
          remedy: "retry",
        },
      }),
  };
  const state = new LocalState(path, store);
  try {
    await rejects(
      state.create(async () => {
        await state.acquire(true);
      }),
      /injected open failure/,
    );
    expect(existsSync(path)).toBe(false);
    expect(await state.create(() => Promise.resolve("retry succeeded"))).toBe(
      "retry succeeded",
    );
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("failed recovery never removes a replacement file", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-reinit-replaced-"));
  const path = join(root, "state.sqlite");
  const state = new LocalState(path);
  try {
    await rejects(
      state.create(() => {
        renameSync(path, join(root, "reserved.sqlite"));
        writeFileSync(path, "someone else's store");
        return Promise.reject(new Error("injected recovery failure"));
      }),
      /injected recovery failure/,
    );
    expect(readFileSync(path, "utf8")).toBe("someone else's store");
    await rejects(
      state.create(() => Promise.resolve()),
      /already exists/,
    );
    expect(readFileSync(path, "utf8")).toBe("someone else's store");
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
