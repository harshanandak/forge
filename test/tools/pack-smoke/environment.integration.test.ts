import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  environmentWithoutBun,
  resolveBun,
} from "../../../tools/pack-smoke/environment.ts";

test("the absolute Bun runner starts with a Bun-free consumer environment", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-pack-env-"));
  try {
    const bun = join(folder, process.platform === "win32" ? "bun.exe" : "bun");
    symlinkSync(process.execPath, bun, "file");
    const original = { Path: `${folder}${delimiter}`, BUN_INSTALL: folder };
    const runner = resolveBun(original);
    expect(runner).toBe(bun);
    const env = environmentWithoutBun(original);
    expect(env.Path).toBe("");
    expect(env.BUN_INSTALL).toBeUndefined();
    expect(original.BUN_INSTALL).toBe(folder);
    const result = spawnSync(
      runner,
      [
        "-e",
        "console.log(JSON.stringify({path:process.env.Path ?? process.env.PATH, install:process.env.BUN_INSTALL ?? null}))",
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ path: "", install: null });
    expect(resolveBun({ ...original, npm_execpath: bun })).toBe(bun);
    expect(
      resolveBun({ ...original, npm_execpath: join(folder, "missing", "bun") }),
    ).toBe(bun);
    expect(() => resolveBun({ PATH: "" })).toThrow(
      "bun is not resolvable on PATH",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);
