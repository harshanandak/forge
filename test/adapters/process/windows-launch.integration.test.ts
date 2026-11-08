// [integration] The Windows launcher starts a command inside its job and builds what Node's spawn builds.
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  corpus,
  fixturePath,
  grandchildScenario,
  launchedCase,
  planFor,
  relativeScenario,
  type Case,
  withoutHostCopies,
  type Echo,
  type GrandchildReport,
} from "./windows-launch.fixture.ts";

const windows = process.platform === "win32";
const dir = windows
  ? realpathSync.native(mkdtempSync(join(tmpdir(), "forge-launch-")))
  : "";
afterAll(() => {
  if (windows) rmSync(dir, { recursive: true, force: true });
}, 30_000);

interface NodeRun {
  readonly results: readonly {
    readonly name: string;
    readonly launched: Echo;
    readonly reference: Echo;
  }[];
  readonly grandchild: GrandchildReport;
  readonly relative: ReturnType<typeof relativeScenario>;
}

const nodePath = windows ? (Bun.which("node") ?? "") : "";
let nodeRun: NodeRun | undefined;
function underNode(): NodeRun {
  if (nodeRun !== undefined) return nodeRun;
  const run = spawnSync(nodePath, [fixturePath, "run", dir], {
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.status !== 0)
    throw new Error(`node run failed: ${run.stderr || run.error?.message}`);
  nodeRun = JSON.parse(run.stdout) as NodeRun;
  return nodeRun;
}

function expectedEcho(testCase: Case, echo: Echo): void {
  expect(echo.argv, testCase.name).toEqual([...testCase.args]);
  const seen = new Map(echo.env.map(([k, v]) => [k.toUpperCase(), v]));
  // Names that differ only by case collapse to the first in sorted order, as in Node.
  const kept = new Map<string, string>();
  for (const key of Object.keys(testCase.env).sort())
    if (!kept.has(key.toUpperCase())) kept.set(key.toUpperCase(), key);
  for (const [folded, key] of kept)
    expect(seen.get(folded), `${testCase.name} ${key}`).toBe(testCase.env[key]);
}

function expectGrandchild(report: GrandchildReport): void {
  expect(report.whileParentRuns).toContain(report.child);
  expect(report.whileParentRuns).toContain(report.grandchild);
  expect(report.parentGone).toBe(true);
  // The parent's exit is proven by `parentGone` (an exit-code probe). The pid list is not used
  // for it: Windows keeps an exited process listed in the job until its object is released, and
  // other holders (the console host) can keep it, so absence from the list is not guaranteed.
  expect(report.afterParentExit).toContain(report.grandchild);
  expect(report.stopped).toContain(report.grandchild);
  expect(report.grandchildGone).toBe(true);
}

function expectRefused(report: ReturnType<typeof relativeScenario>): void {
  expect(report.refused.map((entry) => entry.code)).toEqual(
    report.refused.map(() => "INVALID_OPTIONS"),
  );
  expect(report.refused.every((entry) => entry.started === 0)).toBe(true);
}

describe.skipIf(!windows)("windows launcher", () => {
  test("under node, a detached grandchild is in the job and ends with it", () => {
    expectGrandchild(underNode().grandchild);
  }, 150_000);

  test("under bun, a detached grandchild is in the job and ends with it", async () => {
    expectGrandchild(await grandchildScenario(nodePath, dir, "bun-gc"));
  }, 60_000);

  test("under node, the corpus matches Node spawn byte for byte", () => {
    const { results } = underNode();
    expect(results.length).toBe(corpus().length);
    for (const [index, result] of results.entries()) {
      const testCase = corpus()[index] as Case;
      expectedEcho(testCase, result.reference);
      expect(result.launched, result.name).toEqual(
        withoutHostCopies(result.reference, testCase.env),
      );
    }
  }, 150_000);

  test("under bun, the corpus matches what Node spawn gave", async () => {
    const { results } = underNode();
    for (const [index, testCase] of corpus().entries()) {
      const { plan, out } = planFor(testCase, index, dir, "bun", nodePath);
      const launched = await launchedCase(testCase, plan, out);
      expect(launched, testCase.name).toEqual(
        withoutHostCopies(
          (results[index] as NodeRun["results"][number]).reference,
          testCase.env,
        ),
      );
    }
  }, 150_000);

  test("a relative program path is refused and nothing starts", () => {
    expectRefused(underNode().relative);
    expectRefused(relativeScenario());
  }, 150_000);
});
