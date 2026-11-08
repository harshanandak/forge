// [integration] Actual Node hosts measure bounded supervisor overhead and release every owned process.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface ProcessSample {
  readonly hostResidentBytes: number;
  readonly hostThreads: number | "NOT_MEASURED";
  /** Direct child processes of the host, read from the Windows process table. */
  readonly children?: readonly {
    readonly pid: number;
    readonly image: string;
  }[];
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
  readonly targetPids: readonly number[];
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
  if (process.platform === "win32") {
    // Measured from the process table: the run adds exactly one child, the command. A child that
    // already existed before the run is not the adapter's, and its image name is in the message.
    const before = new Set(report.before.children?.map((child) => child.pid));
    expect(
      report.during.children
        ?.filter((child) => !before.has(child.pid))
        .map((child) => child.pid),
      JSON.stringify(report.during.children),
    ).toEqual(report.targetPids.toSorted((a, b) => a - b));
  } else {
    // POSIX starts the command through Node's spawn, so that one call is the command.
    expect(report.supervisorStarts).toBe(1);
  }
  expect(report.rejectedBeforeHelperSpawn).toBe(true);
  expect(report.addedResidentBytes).toBeLessThan(100_000_000);
  // No platform keeps a helper beside the command.
  expect(report.during.helpers).toHaveLength(0);
  expect(report.after.helpers).toHaveLength(0);
  expect(report.allStopped).toBe(true);
  console.log(`PROCESS_FOOTPRINT ${JSON.stringify(report)}`);
}, 60_000);
