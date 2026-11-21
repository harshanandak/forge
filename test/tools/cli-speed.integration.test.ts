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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");

// These rows exercise the enforced memory gate; other platforms only report measurements.
test
  .skipIf(process.platform !== "linux" && process.platform !== "win32")
  .each([false, true])(
  "same-source builds share their load path; memory growth=%p",
  (growth) => {
    const folder = mkdtempSync(join(tmpdir(), "forge-speed-proof-"));
    try {
      const trace = join(folder, "loads.jsonl");
      const output = join(folder, "samples.json");
      const summary = join(folder, "summary.md");
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
  const retained = Buffer.alloc(32 * 1024 * 1024, 1);
  process.on("exit", () => { if (retained[0] !== 1) throw new Error("allocation lost"); });
}\n`,
        );
      // Nothing is injected into the benchmark's result or its decision function.
      const result = spawnSync(
        "node",
        [
          join(folder, "tools/bench/cli-speed.ts"),
          "--gate",
          "--base",
          join(folder, "base/dist"),
          "--json",
          output,
        ],
        {
          cwd: folder,
          encoding: "utf8",
          timeout: 110_000,
          windowsHide: true,
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
        },
      );
      expect(result.error).toBeUndefined();
      console.log(
        `Speed acceptance: retained growth=${growth}\n${result.stdout}`,
      );
      const loads = readFileSync(trace, "utf8").trim().split("\n");
      expect(loads).toHaveLength(96); // one warm-up and 47 runs per side
      expect(new Set(loads).size).toBe(1);
      const report = JSON.parse(readFileSync(output, "utf8")) as {
        rows: { command: string; peaksMb: number[] }[];
      };
      for (const command of ["issue show", "issue show (origin/main build)"])
        expect(
          report.rows.find((row) => row.command === command)?.peaksMb,
        ).toHaveLength(47);
      // Reallocate the report-only runs; do not add processes to the acceptance time budget.
      expect(report.rows).toHaveLength(10);
      expect(
        report.rows.reduce((sum, row) => sum + row.peaksMb.length, 0),
      ).toBe(102);
      const current = report.rows.find((row) => row.command === "issue show")!;
      const base = report.rows.find(
        (row) => row.command === "issue show (origin/main build)",
      )!;
      const baseMedianPeakMb = [...base.peaksMb].sort((a, b) => a - b)[23]!;
      const headMedianPeakMb = [...current.peaksMb].sort((a, b) => a - b)[23]!;
      const changePercent =
        ((headMedianPeakMb - baseMedianPeakMb) * 100) / baseMedianPeakMb;
      const absoluteCapMb = process.platform === "linux" ? 85 : 70;
      const status = growth
        ? "failure"
        : headMedianPeakMb > absoluteCapMb
          ? "warning"
          : "pass";
      const trend = `speed-memory ${JSON.stringify({
        platform: process.platform,
        command: "issue show",
        baseMedianPeakMb,
        headMedianPeakMb,
        changePercent,
        absoluteCapMb,
        status,
      })}`;
      expect(
        readFileSync(summary, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("speed-memory ")),
      ).toEqual([trend]);
      if (growth) {
        expect(changePercent).toBeGreaterThan(20);
        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(result.stderr).toContain("issue show peak is");
        expect(result.stderr).toContain("more than the 20% limit");
      } else {
        // A loaded integration runner can fail wall time independently of the memory decision.
        expect(result.status === 0 || result.status === 1).toBe(true);
        expect(result.signal).toBeNull();
        expect(changePercent).toBeLessThanOrEqual(10);
        expect(result.stderr).not.toContain("::error::issue show peak");
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  120_000,
);

test
  .skipIf(process.platform !== "linux" && process.platform !== "win32")
  .each(["missing", "failed"])(
  "%s base measurement exits incomplete",
  (base) => {
    const folder = mkdtempSync(join(tmpdir(), "forge-speed-incomplete-"));
    try {
      const summary = join(folder, "summary.md");
      cpSync(join(root, "tools/bench"), join(folder, "tools/bench"), {
        recursive: true,
      });
      mkdirSync(join(folder, "dist/bin"), { recursive: true });
      writeFileSync(join(folder, "package.json"), '{"type":"module"}');
      writeFileSync(
        join(folder, "dist/bin/forge.js"),
        'console.log(JSON.stringify({ result: { id: "bench" } }));',
      );
      if (base === "failed") {
        mkdirSync(join(folder, "base/dist/bin"), { recursive: true });
        writeFileSync(join(folder, "base/package.json"), '{"type":"module"}');
        writeFileSync(
          join(folder, "base/dist/bin/forge.js"),
          "process.exit(2);",
        );
      }
      const result = spawnSync(
        "node",
        [
          "tools/bench/cli-speed.ts",
          "--gate",
          "--base",
          "base/dist",
          "--pairs",
          "1",
        ],
        {
          cwd: folder,
          encoding: "utf8",
          timeout: 20_000,
          windowsHide: true,
          env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
        },
      );
      const expected =
        base === "failed"
          ? "Speed memory comparison incomplete: the base measurement failed."
          : "Speed memory comparison incomplete: the base build was not found";
      expect(result.error).toBeUndefined();
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(readFileSync(summary, "utf8")).toContain(expected);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  },
  30_000,
);
