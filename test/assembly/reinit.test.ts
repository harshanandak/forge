import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
      state.create(async (staged) => {
        expect(existsSync(path)).toBe(false);
        await staged.acquire(true);
      }),
      /injected open failure/,
    );
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(await state.create(() => Promise.resolve("retry succeeded"))).toBe(
      "retry succeeded",
    );
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("failed recovery never removes a competing public store", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-reinit-replaced-"));
  const path = join(root, "state.sqlite");
  const state = new LocalState(path);
  try {
    await rejects(
      state.create(() => {
        expect(existsSync(path)).toBe(false);
        writeFileSync(path, "someone else's store");
        return Promise.reject(new Error("injected recovery failure"));
      }),
      /injected recovery failure/,
    );
    expect(readFileSync(path, "utf8")).toBe("someone else's store");
    expect(readdirSync(root)).toEqual(["state.sqlite"]);
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

test("successful recovery publishes a fully initialized store without replacing a competing creator", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-reinit-publish-"));
  const path = join(root, "state.sqlite");
  const state = new LocalState(path);
  const actor = { kind: "human" as const, id: "test" };
  try {
    await state.create(async (staged) => {
      expect(existsSync(path)).toBe(false);
      const lease = await staged.acquire(true);
      try {
        lease.value!.put("forge/test", "ready", true, actor, {
          expectRevision: 0,
        });
        expect(existsSync(path)).toBe(false);
      } finally {
        await lease.close();
      }
    });
    const lease = await state.acquire(false);
    try {
      expect(lease.value?.get("forge/test", "ready")?.value).toBe(true);
    } finally {
      await lease.close();
    }
    expect(readdirSync(root)).toEqual(["state.sqlite"]);
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("exclusive publication preserves a store created while recovery was initializing", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-reinit-collision-"));
  const path = join(root, "state.sqlite");
  const state = new LocalState(path);
  try {
    await rejects(
      state.create(() => {
        expect(existsSync(path)).toBe(false);
        writeFileSync(path, "competing store");
        return Promise.resolve();
      }),
      /already exists/,
    );
    expect(readFileSync(path, "utf8")).toBe("competing store");
    expect(readdirSync(root)).toEqual(["state.sqlite"]);
  } finally {
    await state.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
