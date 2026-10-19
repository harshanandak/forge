// [integration] The real npm (a .cmd shim on Windows) run through the real process adapter.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPackageManagerPort } from "../../../src/adapters/package-manager/index.ts";
import { createProcessPort } from "../../../src/adapters/process/index.ts";

let project: string;

beforeAll(() => {
  project = realpathSync.native(mkdtempSync(join(tmpdir(), "forge-pm-")));
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      name: "pm-fixture",
      version: "1.0.0",
      scripts: { hello: "node hello.js" },
    }),
  );
  writeFileSync(join(project, "package-lock.json"), "{}");
  writeFileSync(
    join(project, "hello.js"),
    "process.stdout.write('args=' + process.argv.slice(2).join(','));process.exit(5);\n",
  );
}, 30_000);

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
}, 30_000);

test("a declared script runs with the user's real npm and returns its output and exit code", async () => {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  const port = createPackageManagerPort({
    process: createProcessPort({
      supervision: {
        cleanupTimeoutMs: 5000,
        pollIntervalMs: 25,
        drainTimeoutMs: 250,
        maxConcurrent: 1,
      },
    }),
    env,
    maxOutputBytes: 1_000_000,
  });
  const detected = await port.detect(project);
  expect(detected).toMatchObject({ kind: "detected", name: "npm" });
  const result = await port.runScript(project, "hello", ["a", "b c"], 120_000);
  if ("kind" in result) {
    throw new Error(`npm could not be run: ${result.reason}. ${result.remedy}`);
  }
  expect(result.exitCode).toBe(5);
  expect(result.stdout).toContain("args=a,b c");
  expect(result.timedOut).toBe(false);
}, 150_000);
