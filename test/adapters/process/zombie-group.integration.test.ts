import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const posixTest = process.platform === "win32" ? test.skip : test;
posixTest(
  "a real zombie-only group stops before its non-reaping parent collects it",
  () => {
    const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
    if (python.status !== 0) {
      console.log(
        "NOT_EXERCISED: zombie-group fixture requires runner python3 for a non-reaping parent",
      );
      return;
    }
    const fixture = fileURLToPath(
      new URL(
        "../../node-fixtures/process/zombie-group.fixture.ts",
        import.meta.url,
      ),
    );
    const result = spawnSync(
      "node",
      ["--disable-warning=ExperimentalWarning", fixture],
      {
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      zombieStillUnreaped: true,
      reaped: true,
      code: 0,
    });
  },
  15_000,
);
