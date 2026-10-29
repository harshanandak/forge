import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { counterfactuals } from "./counterfactuals.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(
  executable: string,
  args: string[],
  cwd: string,
  timeout = 30000,
  env = process.env,
) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout,
    env,
  });
}
function success(result: ReturnType<typeof run>): string {
  if (result.error || result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "command failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

test("packed Node check journeys and sharded remove-the-fix proofs", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-packed-check-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const consumer = packedConsumer();
    const installed = join(consumer, "node_modules/forge-workflow");
    const artifactEnv = { ...process.env };
    const pathKey =
      Object.keys(artifactEnv).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    artifactEnv[pathKey] = (artifactEnv[pathKey] ?? "")
      .split(delimiter)
      .filter(
        (directory) =>
          !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
            existsSync(join(directory, name)),
          ),
      )
      .join(delimiter);
    delete artifactEnv.BUN_INSTALL;
    // Node cannot strip TypeScript here, so the journeys get the shared
    // state-aware probe as plain JS.
    const liveness = join(work, "liveness.mjs");
    writeFileSync(
      liveness,
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        readFileSync(
          join(root, "test/node-fixtures/process/liveness.ts"),
          "utf8",
        ),
      ),
    );
    artifactEnv.CHECK_LIVENESS_PROBE = liveness;
    expect(
      run("bun", ["--version"], consumer, 5000, artifactEnv).error,
    ).toBeDefined();
    const fixture = join(import.meta.dirname, "journeys.mjs");
    console.log(
      success(
        run(
          node,
          [join(import.meta.dirname, "surfaces.mjs"), installed],
          consumer,
          90000,
          artifactEnv,
        ),
      ),
    );
    const report = JSON.parse(
      success(run(node, [fixture, installed], consumer, 90000, artifactEnv)),
    ) as {
      passed: string[];
      ecosystem: { passed: string[]; skipped: string[] };
    };
    expect(report.passed).toEqual([
      "budget",
      "pytest",
      "cancellation",
      "handler",
      "unknown",
      "zero",
      "malformed",
      "nothing",
      "environment",
      "timeout",
      "receipt",
    ]);
    for (const reason of report.ecosystem.skipped)
      console.log(`SKIP ${reason}`);
    console.log(
      `Real ecosystem journeys: ${report.ecosystem.passed.join(", ") || "none installed"}`,
    );
    const isolated = join(work, "counterfactual");
    cpSync(installed, isolated, {
      recursive: true,
      filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
    });
    symlinkSync(
      join(consumer, "node_modules"),
      join(isolated, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const leg = process.env.STATE_NODE_LEG;
    if (leg !== undefined && leg !== "24" && leg !== "26")
      throw new Error("STATE_NODE_LEG must be 24 or 26");
    const mutations = counterfactuals.filter(
      (_, index) => leg === undefined || index % 2 === (leg === "24" ? 0 : 1),
    );
    for (const mutation of mutations) {
      const file = join(isolated, "dist/src", mutation.file);
      const original = readFileSync(file, "utf8");
      expect(original.split(mutation.from)).toHaveLength(2);
      writeFileSync(file, original.replace(mutation.from, mutation.to));
      try {
        const result = run(
          node,
          ["surfaces", "mcp", "bindings", "review"].includes(
            mutation.journey,
          ) || mutation.journey.startsWith("review:")
            ? [
                join(import.meta.dirname, "surfaces.mjs"),
                isolated,
                mutation.journey,
              ]
            : [fixture, isolated, mutation.journey],
          consumer,
          mutation.journey === "surfaces" ? 90000 : 30000,
          artifactEnv,
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(mutation.evidence);
      } finally {
        writeFileSync(file, original);
      }
    }
    console.log(
      `Packed check: ${report.passed.length} journeys; ${mutations.length} remove-the-fix failures verified`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 900000);
