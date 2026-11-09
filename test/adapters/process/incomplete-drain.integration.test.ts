// [integration] Transport faults stay inside a separate runtime for each backend.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { ProcessResult } from "../../../src/ports/process.ts";

test.each(["event", "native", "job"])(
  "%s: incomplete drains are truncated",
  (backend) => {
    const run = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "incomplete-drain.fixture.ts"), backend],
      {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
      },
    );
    if (run.status !== 0)
      throw new Error(run.stderr || run.error?.message || "Fixture failed");
    const results = JSON.parse(run.stdout) as {
      capture: boolean;
      held: string;
      result: ProcessResult;
    }[];
    expect(results).toHaveLength(8);
    for (const { capture, held, result } of results) {
      expect(
        result,
        `capture=${capture}, held=${held || "none"}`,
      ).toMatchObject({
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: held !== "",
      });
      if (capture) {
        expect(result.outputEvidence?.stdout.complete).toBe(held === "");
        expect(result.outputEvidence?.stderr.complete).toBe(held === "");
      } else expect(result.outputEvidence).toBeUndefined();
    }
  },
  20_000,
);
