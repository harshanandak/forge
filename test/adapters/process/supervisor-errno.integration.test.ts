import { beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

setDefaultTimeout(5000);

interface Failure {
  code: string;
  message: string;
  causeCode?: string;
}
let outcomes: { missing: Failure; denied?: Failure };
beforeAll(() => {
  const run = spawnSync(
    "node",
    [join(import.meta.dirname, "supervisor-errno.fixture.ts")],
    {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    },
  );
  if (run.status !== 0)
    throw Error(`errno fixture failed: ${run.stderr || run.error?.message}`);
  outcomes = JSON.parse(run.stdout) as typeof outcomes;
}, 35000);

test("a real supervised missing command preserves ENOENT", () => {
  expect(outcomes.missing).toMatchObject({
    code: "SPAWN_FAILED",
    causeCode: "ENOENT",
  });
}, 5000);

test.skipIf(process.platform === "win32")(
  "a real supervised non-executable file preserves EACCES, distinct from ENOENT (POSIX mode bits)",
  () => {
    expect(outcomes.denied).toMatchObject({
      code: "SPAWN_FAILED",
      causeCode: "EACCES",
    });
  },
  5000,
);
