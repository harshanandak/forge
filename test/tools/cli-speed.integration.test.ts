// [integration] Run the real benchmark against copies of the built CLI.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

test.each([false, true])(
  "same-source builds share their load path; retained growth=%p still fails",
  (growth) => {
    const folder = mkdtempSync(join(tmpdir(), "forge-speed-proof-"));
    try {
      const trace = join(folder, "loads.jsonl");
      const output = join(folder, "samples.json");
      cpSync(join(root, "tools/bench"), join(folder, "tools/bench"), {
        recursive: true,
      });
      for (const side of ["", "base"]) {
        const pkg = join(folder, side);
        mkdirSync(pkg, { recursive: true });
        cpSync(join(root, "package.json"), join(pkg, "package.json"));
        cpSync(join(root, "dist"), join(pkg, "dist"), { recursive: true });
        symlinkSync(
          join(root, "node_modules"),
          join(pkg, "node_modules"),
          "junction",
        );
        // Both sides get identical tracing. Record only the command the gate compares.
        appendFileSync(
          join(pkg, "dist/bin/forge.js"),
          `\nif (process.argv[2] === "issue" && process.argv[3] === "show") {
  (await import("node:fs")).appendFileSync(${JSON.stringify(trace)}, JSON.stringify(import.meta.url) + "\\n");
}\n`,
        );
      }
      if (growth)
        appendFileSync(
          join(folder, "dist/bin/forge.js"),
          `\nif (process.argv[2] === "issue" && process.argv[3] === "show") {
  const retained = Buffer.alloc(8 * 1024 * 1024, 1);
  process.on("exit", () => { if (retained[0] !== 1) throw new Error("allocation lost"); });
}\n`,
        );
      // Nothing is injected into the benchmark's result or its decision function.
      const result = spawnSync(
        "node",
        [
          join(folder, "tools/bench/cli-speed.ts"),
          "--gate",
          "--pull-request",
          "--base",
          join(folder, "base/dist"),
          "--json",
          output,
        ],
        { cwd: folder, encoding: "utf8", timeout: 110_000, windowsHide: true },
      );
      expect(result.error).toBeUndefined();
      console.log(
        `Speed acceptance: retained growth=${growth}\n${result.stdout}`,
      );
      const loads = readFileSync(trace, "utf8").trim().split("\n");
      expect(loads).toHaveLength(32); // one warm-up and 15 runs per side
      expect(new Set(loads).size).toBe(1);
      const report = JSON.parse(readFileSync(output, "utf8")) as {
        rows: { command: string; peaksMb: number[] }[];
      };
      for (const command of ["issue show", "issue show (origin/main build)"])
        expect(
          report.rows.find((row) => row.command === command)?.peaksMb,
        ).toHaveLength(15);
      expect(result.status, result.stdout + result.stderr).toBe(growth ? 1 : 0);
      if (growth) {
        expect(result.stderr).toContain("issue show peak is");
        expect(result.stderr).toContain("more than the 1.5 MB limit");
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  120_000,
);
