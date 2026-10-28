import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

test("packed finalization timeouts identify phases and retain durable receipts", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-finalization-proof-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const consumer = packedConsumer();
    const installed = join(consumer, "node_modules/forge-workflow");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      FORGE_DEVICE_ROOT: join(work, "device"),
    };
    const pathKey =
      Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = (env[pathKey] ?? "")
      .split(delimiter)
      .filter(
        (directory) =>
          !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(directory, name)),
          ),
      )
      .join(delimiter);
    delete env.BUN_INSTALL;
    for (const mode of ["lock", "write", "readback"] as const) {
      const result = spawnSync(
        node,
        [join(import.meta.dirname, "../finalization.mjs"), installed, mode],
        {
          cwd: consumer,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        budgetMs: number;
        error: { code: string; message: string };
        readBackBeforeError: boolean;
        durableAfterReopen: boolean;
        receiptStatus: string;
        timings: { writeMs: number; readbackMs: number };
      };
      expect(report.budgetMs).toBe(3000);
      expect(report.error.code).toBe("INVOCATION_TIMEOUT");
      expect(report.error.message).toContain(
        "Check receipt finalization deadline exceeded",
      );
      expect(report.readBackBeforeError).toBe(true);
      expect(report.durableAfterReopen).toBe(true);
      expect(report.receiptStatus).toBe("NOT_EXECUTED");
      expect(
        report.timings[mode === "readback" ? "readbackMs" : "writeMs"],
      ).toBeGreaterThanOrEqual(3500);
      for (const phase of ["snapshotMs", "writeMs", "readbackMs"])
        expect(report.error.message, mode + " reports " + phase).toMatch(
          new RegExp(phase + "=\\d+"),
        );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 120000);
