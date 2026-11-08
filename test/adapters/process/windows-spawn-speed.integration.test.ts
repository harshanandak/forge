// [integration] On Windows the adapter costs about one bare spawn, with no helper process per command.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  fixturePath,
  MARGIN_MS,
  measureSpawnSpeed,
  type SpeedReport,
} from "./windows-spawn-speed.fixture.ts";

const windows = process.platform === "win32";
const nodePath = windows ? (Bun.which("node") ?? "") : "";

function expectNearBare(report: SpeedReport): void {
  console.log(
    `SPAWN_SPEED ${report.runtime} bareMedian=${report.bareMedian.toFixed(1)}ms adapterMedian=${report.adapterMedian.toFixed(1)}ms bareP90=${report.bareP90.toFixed(1)}ms adapterP90=${report.adapterP90.toFixed(1)}ms`,
  );
  expect(
    report.adapterMedian,
    `${report.runtime}: adapter median ${report.adapterMedian.toFixed(1)} ms against bare ${report.bareMedian.toFixed(1)} ms`,
  ).toBeLessThanOrEqual(report.bareMedian + MARGIN_MS);
}

describe.skipIf(!windows)("windows spawn speed", () => {
  test("under node, the median of 20 adapter runs of git --version is within 25 ms of a bare spawn", () => {
    const run = spawnSync(nodePath, [fixturePath], {
      encoding: "utf8",
      timeout: 120_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (run.status !== 0)
      throw new Error(
        `node speed run failed: ${run.stderr || run.error?.message}`,
      );
    expectNearBare(JSON.parse(run.stdout) as SpeedReport);
  }, 150_000);

  test("under bun, the median of 20 adapter runs of git --version is within 25 ms of a bare spawn", async () => {
    expectNearBare(await measureSpawnSpeed());
  }, 150_000);
});
