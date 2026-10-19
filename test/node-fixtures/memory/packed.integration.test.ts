import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { counterfactuals } from "./counterfactuals.ts";

const root = resolve(import.meta.dirname, "../../..");
const fixture = join(import.meta.dirname, "journeys.mjs");

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120_000,
  });
  if (result.status !== 0)
    throw new Error(
      `${command}: ${result.error?.message ?? result.stderr}\n${result.stdout}`,
    );
  return result.stdout;
}
function launch(args: string[], cwd: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (done) => {
      const child = spawn(nodeBinary(), args, {
        cwd,
        windowsHide: true,
        timeout: 90_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      child.on("close", (status) => done({ status, stdout, stderr }));
    },
  );
}
function nodeBinary(): string {
  const node = Bun.which("node");
  if (!node) throw new Error("Node runtime required for packed integration");
  return node;
}
function pattern(text: string): RegExp {
  return new RegExp(
    text
      .split(/\s+/)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+"),
  );
}

// Labelled integration: the packed, installed package on Node without Bun; each key journey is then
// shown to fail with its fix removed from the installed copy.
test("integration: packed memory journeys, each failing with its fix removed", async () => {
  const work = mkdtempSync(join(tmpdir(), "forge-packed-memory-"));
  try {
    const node = nodeBinary();
    // Pack smoke installs the package once and shares it; run alone, build, pack and install here.
    let consumer = process.env.MEMORY_PACKED_CONSUMER ?? "";
    if (consumer === "") {
      consumer = join(work, "consumer");
      run(process.execPath, ["run", "build"]);
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find((path) => existsSync(path));
      if (!npm)
        throw new Error("Cannot locate the Node installation's npm CLI");
      const packed = JSON.parse(
        run(node, [
          npm,
          "pack",
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          work,
        ]),
      ) as { filename: string }[];
      mkdirSync(consumer);
      writeFileSync(
        join(consumer, "package.json"),
        '{"name":"memory-consumer","version":"1.0.0","private":true}',
      );
      run(
        node,
        [
          npm,
          "install",
          join(work, packed[0]!.filename),
          "--no-audit",
          "--no-fund",
        ],
        consumer,
      );
    }
    const installed = join(consumer, "node_modules/forge-workflow");

    const passed = await launch([fixture, installed, "all"], consumer);
    if (passed.status !== 0)
      throw new Error(`journeys failed\n${passed.stdout}\n${passed.stderr}`);
    for (const journey of ["device", "fence"])
      expect(passed.stdout).toContain(`PASS ${journey}`);

    // Each worker mutates its own copy of the installed package.
    await Promise.all(
      [0, 1].map(async (worker) => {
        const isolated = join(
          consumer,
          "node_modules",
          `forge-memory-cf-${worker}`,
        );
        cpSync(installed, isolated, {
          recursive: true,
          filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
        });
        for (const mutation of counterfactuals.filter(
          (_, i) => i % 2 === worker,
        )) {
          const path = join(isolated, "dist/src", mutation.file);
          const original = readFileSync(path, "utf8");
          const find = pattern(mutation.from);
          expect(
            original,
            `${mutation.file} still contains ${mutation.from}`,
          ).toMatch(find);
          try {
            const changed = mutation.all
              ? original.replace(new RegExp(find.source, "g"), mutation.to)
              : original.replace(find, mutation.to);
            expect(changed).not.toBe(original);
            writeFileSync(path, changed);
            const result = await launch(
              [fixture, isolated, mutation.journey],
              consumer,
            );
            if (result.status === 0)
              throw new Error(
                `Counterfactual survived: ${mutation.journey}: ${mutation.from}\n${result.stdout}`,
              );
            expect(result.stderr).toContain(mutation.evidence);
          } finally {
            writeFileSync(path, original);
          }
        }
      }),
    );
    console.log(
      `Packed memory: 2 journeys, ${counterfactuals.length} remove-the-fix checks`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 240_000);
