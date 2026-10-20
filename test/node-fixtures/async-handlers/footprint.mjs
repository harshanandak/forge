import assert from "node:assert/strict";
import { awaitDeadline } from "./deadline.mjs";
import { windowsFootprint } from "./windows-footprint.mjs";
import childProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

assert.equal(
  process.versions.bun,
  undefined,
  "footprint must be measured on Node",
);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) =>
    ["path", "pathext", "systemroot", "windir", "home", "tmp", "temp"].includes(
      name.toLowerCase(),
    ),
  ),
);
const root = mkdtempSync(join(tmpdir(), "forge-footprint-"));
const pause = (milliseconds) =>
  new Promise((done) => setTimeout(done, milliseconds));
let supervisorStarts = 0;
const trackedSupervisors = new Set();
const originalSpawn = childProcess.spawn;
childProcess.spawn = (...args) => {
  supervisorStarts += 1;
  const child = originalSpawn(...args);
  if (child.pid !== undefined) trackedSupervisors.add(child.pid);
  return child;
};
syncBuiltinESMExports();
const moduleUrl =
  process.argv[2] === "built"
    ? new URL("../../../dist/src/adapters/process/index.js", import.meta.url)
    : process.argv[2] === undefined
      ? new URL("../../../src/adapters/process/index.ts", import.meta.url)
      : new URL(process.argv[2]);
const artifact = moduleUrl.pathname.endsWith(".js") ? "built" : "source";
const { createProcessPort } = await import(moduleUrl);

// Include lazy native dependency loading in the incremental host cost.
const baselineResidentBytes = process.memoryUsage().rss;
const nativeSnapshot =
  process.platform === "win32" ? windowsFootprint() : undefined;
function snapshot() {
  if (nativeSnapshot)
    return nativeSnapshot(process.pid, [...trackedSupervisors].filter(alive));
  return {
    hostResidentBytes: process.memoryUsage().rss,
    hostThreads: "NOT_MEASURED",
    helpers: [],
  };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      return !readFileSync(`/proc/${pid}/stat`, "utf8").includes(") Z ");
    }
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes(error.code)) return false;
    throw error;
  }
}

async function ready(paths) {
  const deadline = performance.now() + 10_000;
  while (!paths.every(existsSync)) {
    assert.ok(
      performance.now() < deadline,
      "supervised commands did not become ready",
    );
    await pause(10);
  }
  return paths.map((path) => {
    const pid = Number(readFileSync(path, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0, "invalid workload PID");
    return pid;
  });
}

function dependencyDisk() {
  const require = createRequire(import.meta.url);
  try {
    const packageRoot = dirname(require.resolve("koffi"));
    const metadata = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    const optionalRoots = Object.keys(metadata.optionalDependencies ?? {})
      .map((name) => join(dirname(packageRoot), name))
      .filter(existsSync);
    const roots = [packageRoot, ...optionalRoots].map((path) =>
      realpathSync(path),
    );
    let fileCount = 0;
    let installedBytes = 0;
    let nativeBytes = 0;
    let nativeFileCount = 0;
    const pending = roots.map((path) => ({ path, depth: 0 }));
    while (pending.length > 0) {
      const directory = pending.pop();
      assert.ok(
        directory.depth <= 16,
        "dependency disk walk exceeded its depth bound",
      );
      for (const entry of readdirSync(directory.path, {
        withFileTypes: true,
      })) {
        const path = join(directory.path, entry.name);
        if (entry.isDirectory()) {
          pending.push({ path, depth: directory.depth + 1 });
          assert.ok(
            pending.length <= 4096,
            "dependency disk walk exceeded its directory bound",
          );
        } else if (entry.isFile()) {
          fileCount += 1;
          assert.ok(
            fileCount <= 4096,
            "dependency disk walk exceeded its file bound",
          );
          const bytes = statSync(path).size;
          installedBytes += bytes;
          if (entry.name.endsWith(".node")) {
            nativeBytes += bytes;
            nativeFileCount += 1;
          }
        }
      }
    }
    return {
      status: "MEASURED",
      installedBytes,
      nativeBytes,
      nativeFileCount,
      fileCount,
      optionalPackageCount: optionalRoots.length,
    };
  } catch (error) {
    return { status: "NOT_MEASURED", reason: error.code ?? error.name };
  }
}

const supervision = {
  cleanupTimeoutMs: 5000,
  pollIntervalMs: 25,
  drainTimeoutMs: 250,
  maxConcurrent: 1,
};
const cleanupBudget =
  supervision.cleanupTimeoutMs * 2 + supervision.drainTimeoutMs;
const controllers = [new AbortController()];
let settled = Promise.resolve([]);
try {
  const port = createProcessPort({
    supervision,
  });
  const before = snapshot();
  before.hostResidentBytes = Math.min(
    before.hostResidentBytes,
    baselineResidentBytes,
  );
  assert.equal(
    before.helpers.length,
    0,
    "a fresh host must have no idle helpers",
  );
  const capability = await awaitDeadline(
    port.containment(),
    supervision.cleanupTimeoutMs,
    "footprint containment preflight",
  );
  if (process.platform === "win32") {
    assert.deepEqual(capability, { available: true, backend: "windows-job" });
  }
  const markers = controllers.map((_, index) => join(root, `ready-${index}`));
  const command = `
    const { writeFileSync, renameSync } = require('node:fs');
    const marker = process.argv[1];
    writeFileSync(marker + '.tmp', String(process.pid));
    renameSync(marker + '.tmp', marker);
    setInterval(() => {}, 1000);
  `;
  const executable = { kind: "resolved", path: process.execPath };
  const options = {
    cwd: root,
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 1024,
    containment: "supervised",
  };
  settled = Promise.allSettled(
    controllers.map((controller, index) =>
      port.run(executable, ["-e", command, markers[index]], {
        ...options,
        signal: controller.signal,
      }),
    ),
  );
  const targetPids = await ready(markers);
  const during = snapshot();
  const startsBeforeRefusal = supervisorStarts;
  const refusedMarker = join(root, "must-not-run");
  await assert.rejects(
    port.run(executable, ["-e", command, refusedMarker], {
      ...options,
      timeoutMs: 3000,
    }),
    { code: "PROCESS_LIMIT_EXCEEDED" },
  );
  assert.equal(
    supervisorStarts,
    startsBeforeRefusal,
    "refusal must precede helper spawn",
  );
  assert.equal(
    existsSync(refusedMarker),
    false,
    "the refused workload must not run",
  );
  assert.equal(supervisorStarts, 1, "only one process may be started");
  if (process.platform === "win32") {
    // The default mode starts the command itself; no helper runs beside it.
    during.helpers = during.helpers.filter(
      (helper) => !targetPids.includes(helper.pid),
    );
    assert.equal(during.helpers.length, 0, "no helper may run beside it");
  }
  // Cleanup may start its own short-lived tool (taskkill on Windows); only starts before it count.
  const startsBeforeCleanup = supervisorStarts;
  for (const controller of controllers) controller.abort();
  const outcomes = await awaitDeadline(
    settled,
    cleanupBudget,
    "footprint cancellation cleanup",
  );
  const reports = outcomes.map((outcome) => {
    assert.equal(
      outcome.status,
      "fulfilled",
      "cancellation cleanup must settle successfully",
    );
    assert.equal(outcome.value.supervision?.confirmed, true);
    return outcome.value.supervision;
  });
  const supervisorPids = reports.map((report) => report.supervisorPid);
  assert.ok(
    [...supervisorPids, ...targetPids].every((pid) => !alive(pid)),
    "cleanup must leave no owned process alive",
  );
  const after = snapshot();
  assert.equal(after.helpers.length, 0, "cleanup must leave no idle helpers");
  if (process.platform !== "win32") {
    during.helpers = reports
      .filter((report) => !targetPids.includes(report.supervisorPid))
      .map((report) => ({
        pid: report.supervisorPid,
        residentBytes: report.supervisorResidentBytes,
        threads: "NOT_MEASURED",
      }));
  }
  const helperResidentBytes = during.helpers.reduce(
    (total, helper) => total + helper.residentBytes,
    0,
  );
  const addedResidentBytes =
    Math.max(0, during.hostResidentBytes - before.hostResidentBytes) +
    helperResidentBytes;
  console.log(
    JSON.stringify({
      schemaVersion: "forge.process-footprint/1",
      platform: process.platform,
      nodeVersion: process.versions.node,
      artifact,
      method:
        process.platform === "win32"
          ? "Windows native working sets and Toolhelp thread counts"
          : "Node RSS and supervisor readiness reports; threads NOT_MEASURED",
      before,
      during,
      after,
      addedResidentBytes,
      supervisorStarts: startsBeforeCleanup,
      rejectedBeforeHelperSpawn: true,
      supervisorPids,
      targetPids,
      allStopped: true,
      dependencyDisk: dependencyDisk(),
    }),
  );
  assert.ok(
    addedResidentBytes < 100_000_000,
    `supervision added ${addedResidentBytes} resident bytes, above the approved 100 MB budget`,
  );
} finally {
  for (const controller of controllers) controller.abort();
  try {
    await awaitDeadline(settled, cleanupBudget, "footprint final cleanup");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
    const temporaryParent = resolve(tmpdir());
    assert.equal(dirname(resolve(root)), temporaryParent);
    assert.ok(basename(root).startsWith("forge-footprint-"));
    rmSync(root, { recursive: true, force: true });
  }
}
