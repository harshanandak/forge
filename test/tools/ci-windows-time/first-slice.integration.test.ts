import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtures } from "../../integration/fixtures/run.ts";

test("positive fixtures overlap and preserve each captured result", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-positive-barrier-"));
  try {
    const script = join(work, "barrier.mjs");
    writeFileSync(
      script,
      `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [root, index] = process.argv.slice(2);
writeFileSync(join(root, index), "ready");
const started = performance.now();
while (!["0", "1", "2"].every(name => existsSync(join(root, name)))) {
  if (performance.now() - started > 2000) throw new Error("fixtures did not overlap");
  await new Promise(resolve => setTimeout(resolve, 10));
}
console.log(index);
`,
    );
    expect(
      await runFixtures(
        [0, 1, 2].map((index) => ({
          label: `barrier ${index}`,
          command: process.execPath,
          args: [script, work, String(index)],
          cwd: work,
          env: process.env,
        })),
      ),
    ).toEqual(["0\n", "1\n", "2\n"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 10000);

for (const failure of ["exit", "spawn"] as const)
  test(`positive fixture ${failure} failure drains its successful sibling`, async () => {
    const work = mkdtempSync(join(tmpdir(), "forge-positive-failure-"));
    try {
      const finished = join(work, "finished");
      const slow = join(work, "slow.mjs");
      writeFileSync(
        slow,
        `import { writeFileSync } from "node:fs"; await new Promise(resolve => setTimeout(resolve, 100)); writeFileSync(process.argv[2], "finished");`,
      );
      let failed = false;
      try {
        await runFixtures([
          {
            label: "fails",
            command:
              failure === "exit"
                ? process.execPath
                : join(work, "missing-runtime"),
            args: ["-e", "process.exit(7)"],
            cwd: work,
            env: process.env,
          },
          {
            label: "finishes",
            command: process.execPath,
            args: [slow, finished],
            cwd: work,
            env: process.env,
          },
        ]);
      } catch (error) {
        failed = true;
        expect(error).toBeInstanceOf(AggregateError);
      }
      expect(failed).toBe(true);
      expect(existsSync(finished)).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 10000);
