import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";

test("canonical store paths under a symlinked sync root are refused", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-sync-root-"));
  const prior = process.env.OneDrive;
  try {
    const target = join(work, "target");
    const alias = join(work, "alias");
    mkdirSync(target);
    symlinkSync(
      target,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    process.env.OneDrive = alias;
    const store = createSqliteStore(realpathSync(target));
    for (const name of ["state.db", "missing/state.db"]) {
      const path = join(realpathSync(target), name);
      const opened = await store.open({ path, readOnly: false });
      if (opened.ok) await opened.handle.close();
      expect(opened.ok).toBe(false);
      if (!opened.ok) expect(opened.unavailable.reason).toContain("cloud");
      expect(existsSync(path)).toBe(false);
    }
  } finally {
    if (prior === undefined) delete process.env.OneDrive;
    else process.env.OneDrive = prior;
    rmSync(work, { recursive: true, force: true });
  }
}, 30000);
