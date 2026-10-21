import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithin } from "../../../tools/pack-smoke/bounded.ts";

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("a hung runner fails naming its phase and its whole process tree is killed", async () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-pack-bounded-"));
  const pidFile = join(folder, "grandchild.pid");
  try {
    // The runner starts a grandchild that hangs, then hangs itself outside any test callback.
    const script = `const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));
setInterval(() => {}, 1000);`;
    const started = performance.now();
    let caught: unknown;
    try {
      await runWithin(
        "packed journeys",
        process.execPath,
        ["-e", script],
        { cwd: folder },
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
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    for (let i = 0; i < 50 && alive(grandchild); i += 1)
      await new Promise((done) => setTimeout(done, 100));
    expect(alive(grandchild)).toBe(false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
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
