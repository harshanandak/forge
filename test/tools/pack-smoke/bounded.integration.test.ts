import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithin } from "../../../tools/pack-smoke/bounded.ts";

for (const state of ["vanished", "present"])
  test(`a failed group inspection requires OS proof that the group is ${state}`, () => {
    const node = Bun.which("node");
    if (node === null)
      throw new Error("Node is required for cleanup fault injection");
    const result = spawnSync(
      node,
      [join(import.meta.dirname, "inspection.fixture.ts"), state],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`PASS inspection ${state}`);
  }, 15000);

test("a runner stuck before descendant startup fails naming its phase", async () => {
  const started = performance.now();
  let caught: unknown;
  try {
    await runWithin(
      "packed journeys",
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { cwd: tmpdir() },
      2000,
    );
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe(
    "packed journeys timed out after 2000 ms; its process tree was killed",
  );
  expect(performance.now() - started).toBeLessThan(15000);
}, 30000);

for (const mode of process.platform === "win32"
  ? ["timeout"]
  : ["timeout", "SIGTERM", "SIGINT", "failure", "success"])
  test(`a ready resistant descendant is stopped before ${mode} settles`, () => {
    const node = Bun.which("node");
    if (node === null)
      throw new Error("Node is required for process-tree integration");
    const result = spawnSync(
      node,
      [
        "--disable-warning=ExperimentalWarning",
        join(import.meta.dirname, "descendants.fixture.ts"),
        mode,
      ],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      `PASS ${mode}: resistant descendant stopped; listeners restored`,
    );
  }, 30000);

test("a runner that exits non-zero fails naming its phase", async () => {
  const failure = await runWithin(
    "packed journeys",
    process.execPath,
    ["-e", "process.exit(3)"],
    { cwd: tmpdir() },
    10000,
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect((failure as Error).message).toBe("packed journeys failed: exit 3");
  await runWithin(
    "packed journeys",
    process.execPath,
    ["-e", "process.exit(0)"],
    { cwd: tmpdir() },
    10000,
  );
}, 30000);
