import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { packedConsumer } from "../../../integration/packed-consumer.ts";

test("focused packed review proofs run only their relevant surface operations", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-focused-review-"));
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node runtime required");
    const consumer = packedConsumer();
    const installed = join(consumer, "node_modules/forge-workflow");
    const preload = join(work, "trace.mjs");
    const trace = join(work, "launches.jsonl");
    writeFileSync(
      preload,
      `import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
for (const name of ["spawn", "spawnSync"]) {
  const original = childProcess[name];
  childProcess[name] = function(executable, args, ...rest) {
    if (args[0]?.endsWith("forge.js"))
      appendFileSync(${JSON.stringify(trace)}, JSON.stringify(args.slice(1, 3)) + "\\n");
    return original.call(this, executable, args, ...rest);
  };
}
syncBuiltinESMExports();
`,
    );
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
    for (const [scenario, operations] of [
      ["snapshot", [["check", "run"]]],
      [
        "parser",
        [
          ["check", "run"],
          ["check", "run"],
        ],
      ],
      ["bindings", [["check", "run"], ["check", "run"], ["--mcp"]]],
    ] as const) {
      writeFileSync(trace, "");
      const result = spawnSync(
        node,
        [
          "--import",
          pathToFileURL(preload).href,
          join(import.meta.dirname, "../surfaces.mjs"),
          installed,
          `review:${scenario}`,
        ],
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
      const launches = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      expect(
        launches,
        `${scenario} runs only its relevant CLI/MCP operations`,
      ).toEqual(operations.map((operation) => [...operation]));
      expect(result.stdout.trim()).toBe(
        `PASS packed final review: ${scenario}`,
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 300000);
