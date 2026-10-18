import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suite = process.argv[2];
if (
  (suite !== "unit" && suite !== "integration" && suite !== "all") ||
  process.argv[3] !== "--timeout" ||
  !/^\d+$/.test(process.argv[4] ?? "")
) {
  throw new Error("select unit, integration or all, with --timeout <ms>");
}
const timeout = process.argv[4]!;

function testFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.test\.ts$/.test(entry.name) ? [relative(root, path)] : [];
  });
}

const files = testFiles(join(root, "test")).sort();
async function run(kind: "unit" | "integration"): Promise<void> {
  const selected = files.filter((file) =>
    kind === "integration"
      ? file.endsWith(".integration.test.ts")
      : !file.endsWith(".integration.test.ts"),
  );
  if (selected.length === 0) throw new Error(`the ${kind} test suite is empty`);
  console.log(`${kind}: ${selected.length} test files`);
  // This artifact test has private installs and stores, so it can overlap the
  // remaining serial integration files after the parallel unit lane has ended.
  const packed = selected.find((file) =>
    file
      .replaceAll("\\", "/")
      .endsWith("node-fixtures/state/packed.integration.test.ts"),
  );
  const packedRun =
    packed === undefined
      ? undefined
      : Bun.spawn([process.execPath, "test", "--timeout", timeout, packed], {
          cwd: root,
          stdout: "inherit",
          stderr: "inherit",
        });
  const result = spawnSync(
    process.execPath,
    [
      "test",
      "--timeout",
      timeout,
      ...(kind === "unit" ? ["--parallel"] : []),
      ...selected.filter((file) => file !== packed),
    ],
    { cwd: root, stdio: "inherit", windowsHide: true },
  );
  // A failure in either process must still drain the other before exiting.
  const packedStatus = await packedRun?.exited;
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  if (packedStatus !== undefined && packedStatus !== 0)
    process.exit(packedStatus);
}
if (suite === "unit" || suite === "all") await run("unit");
if (suite === "integration" || suite === "all") await run("integration");
