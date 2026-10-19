import { runChild } from "./child-runner.ts";
import { inheritRunnerGroup, readRunnerPolicy } from "./runner-policy.ts";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suite = process.argv[2];
if (
  (suite !== "unit" &&
    suite !== "integration" &&
    suite !== "integration-rest" &&
    suite !== "all") ||
  process.argv[3] !== "--timeout" ||
  !/^\d+$/.test(process.argv[4] ?? "")
) {
  throw new Error(
    "select unit, integration, integration-rest or all, with --timeout <ms>",
  );
}
const timeout = process.argv[4]!;
const policy = readRunnerPolicy();
const scope = new AbortController();
const stepDeadline = performance.now() + policy.stepTimeoutMs;
const stepTimer = setTimeout(
  () => scope.abort(new Error("test suite step deadline exceeded")),
  policy.stepTimeoutMs,
);

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

const files = testFiles(join(root, "test")).sort();
async function run(
  kind: "unit" | "integration" | "integration-rest",
): Promise<void> {
  const selected = files.filter((file) =>
    kind === "unit"
      ? !file.endsWith(".integration.test.ts")
      : file.endsWith(".integration.test.ts") &&
        (kind !== "integration-rest" ||
          ![
            "test/node-fixtures/state/packed.integration.test.ts",
            "test/node-fixtures/memory/packed.integration.test.ts",
            "test/integration/packed.integration.test.ts",
            "test/assembly/providers/packed.integration.test.ts",
          ].includes(file.replaceAll("\\", "/"))),
  );
  if (selected.length === 0) throw new Error(`the ${kind} test suite is empty`);
  console.log(`${kind}: ${selected.length} test files`);
  await runChild(
    `test suite ${kind}`,
    process.execPath,
    [
      "test",
      "--timeout",
      timeout,
      ...(kind === "unit" ? ["--parallel"] : []),
      ...selected.map((file) => `./${file}`),
    ],
    {
      cwd: root,
      inheritProcessGroup: inheritRunnerGroup(),
      timeoutMs: Math.max(
        1,
        Math.min(
          policy.childTimeoutMs,
          Math.floor(stepDeadline - performance.now()),
        ),
      ),
      cleanupTimeoutMs: policy.cleanupTimeoutMs,
      maxOutputBytes: policy.maxOutputBytes,
      signal: scope.signal,
    },
  );
}
try {
  if (suite === "unit" || suite === "all") await run("unit");
  if (suite === "integration" || suite === "all") await run("integration");
  if (suite === "integration-rest") await run("integration-rest");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(stepTimer);
}
