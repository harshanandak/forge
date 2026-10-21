// [integration] Actual Node hosts measure bounded supervisor overhead and release every owned process.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ProcessSample {
  readonly hostResidentBytes: number;
  readonly hostThreads: number | "NOT_MEASURED";
  readonly helpers: readonly {
    readonly pid: number;
    readonly residentBytes: number;
    readonly threads: number | "NOT_MEASURED";
  }[];
}

interface FootprintReport {
  readonly artifact: string;
  readonly platform: string;
  readonly nodeVersion: string;
  readonly before: ProcessSample;
  readonly during: ProcessSample;
  readonly after: ProcessSample;
  readonly addedResidentBytes: number;
  readonly supervisorStarts: number;
  readonly rejectedBeforeHelperSpawn: boolean;
  readonly allStopped: boolean;
  readonly dependencyDisk: {
    readonly status: "MEASURED" | "NOT_MEASURED";
    readonly nativeBytes?: number;
    readonly optionalPackageCount?: number;
  };
}

const builtAdapter = resolve(
  import.meta.dirname,
  "../../../dist/src/adapters/process/index.js",
);

// No skip on a missing build: `bun run test:integration` builds first, so an absent dist is a failure.
test("one active built supervisor stays below the approved footprint and leaves no idle helper", () => {
  const node = Bun.which("node");
  if (node === null)
    throw new Error("Node is required for the footprint benchmark.");
  const fixture = resolve(
    import.meta.dirname,
    "../../node-fixtures/async-handlers/footprint.mjs",
  );
  if (!existsSync(builtAdapter)) {
    throw new Error(
      "dist is absent: run bun run build (bun run test:integration builds first).",
    );
  }
  const run = spawnSync(
    node,
    [
      "--disable-warning=ExperimentalWarning",
      fixture,
      pathToFileURL(builtAdapter).href,
    ],
    {
      cwd: resolve(import.meta.dirname, "../../.."),
      encoding: "utf8",
      timeout: 45_000,
      windowsHide: true,
    },
  );
  expect(
    run.status,
    `${run.stderr || run.error?.message || ""}\n${run.stdout}`,
  ).toBe(0);
  const report = JSON.parse(run.stdout) as FootprintReport;
  expect(report.artifact).toBe("built");
  expect(report.supervisorStarts).toBe(1);
  expect(report.rejectedBeforeHelperSpawn).toBe(true);
  expect(report.addedResidentBytes).toBeLessThan(100_000_000);
  // POSIX starts the command itself; Windows keeps one Job Object helper beside it.
  expect(report.during.helpers).toHaveLength(
    process.platform === "win32" ? 1 : 0,
  );
  expect(report.after.helpers).toHaveLength(0);
  expect(report.allStopped).toBe(true);
  console.log(`PROCESS_FOOTPRINT ${JSON.stringify(report)}`);
}, 60_000);
