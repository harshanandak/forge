import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

const timeout = 30_000;

test(
  "CT5 importing main in a fresh process exposes entry points without process or HTTP effects",
  () => {
    const source = new URL("../../src/main.ts", import.meta.url).href;
    const probe = `
      import { deepStrictEqual, strictEqual } from "node:assert/strict";
      import http from "node:http";
      import { syncBuiltinESMExports } from "node:module";

      const effects = [];
      process.on = () => {
        effects.push("process.on");
        return process;
      };
      process.exit = () => {
        effects.push("process.exit");
        throw new Error("Unexpected exit during import");
      };
      http.createServer = () => {
        effects.push("http.createServer");
        throw new Error("Unexpected server creation during import");
      };
      syncBuiltinESMExports();

      const loaded = await import(${JSON.stringify(source)});
      for (const name of ["main", "mainWithServices", "runService"])
        strictEqual(typeof loaded[name], "function", name);
      deepStrictEqual(effects, []);
      process.stdout.write("hub import checked");
    `;
    const result = spawnSync("node", ["--input-type=module", "--eval", probe], {
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
    if (result.error) throw result.error;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("hub import checked");
  },
  timeout,
);
