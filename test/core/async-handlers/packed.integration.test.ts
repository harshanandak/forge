import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
const root = resolve(import.meta.dirname, "../../..");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 90000,
) {
  return spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout,
  });
}
test("installed async ABI: child completion, tree interruption, service revocation and CLI/MCP", () => {
  const work = mkdtempSync(join(root, ".async-packed-"));
  const node = Bun.which("node");
  if (!node) throw Error("Node required");
  const npm = [
    join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find(existsSync);
  if (!npm) throw Error("npm required");
  const env = { ...process.env };
  const path =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[path] = (env[path] ?? "")
    .split(delimiter)
    .filter(
      (dir) =>
        !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
          existsSync(join(dir, name)),
        ),
    )
    .join(delimiter);
  delete env.BUN_INSTALL;
  const successful = (
    command: string,
    args: string[],
    cwd: string,
    childEnv = env,
  ) => {
    const result = run(command, args, cwd, childEnv);
    expect(
      result.status,
      `${result.error?.message ?? ""} ${result.stdout} ${result.stderr}`,
    ).toBe(0);
    return result.stdout;
  };
  try {
    successful(process.execPath, ["run", "build"], root, process.env);
    const packed = JSON.parse(
      successful(
        node,
        [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", work],
        root,
      ),
    ) as { filename: string }[];
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"private":true,"type":"module"}',
    );
    successful(
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
    const installed = join(consumer, "node_modules/forge-workflow");
    copyFileSync(
      join(root, "test/node-fixtures/async-handlers/journey.mjs"),
      join(installed, "async-journey.mjs"),
    );
    for (const runtime of new Set(
      [node, process.env.FORGE_NODE26].filter((value): value is string =>
        Boolean(value),
      ),
    ))
      expect(
        successful(runtime, [join(installed, "async-journey.mjs")], consumer),
      ).toContain("PASS async-handlers all");
    const privateCopy = join(consumer, "node_modules/async-counterfactual");
    cpSync(installed, privateCopy, { recursive: true });
    const mutations = [
      {
        file: "adapters/node-runtime/isolation.js",
        from: "Promise.resolve(handler(args))",
        to: "Promise.reject(Error('sync-only ABI'))",
        mode: "async",
        evidence: "async child process must complete",
      },
      {
        file: "core/runtime/services.js",
        from: "this.check();",
        to: "void 0;",
        mode: "scope",
        evidence: "settled services must refuse writes",
      },
      {
        file: "core/runtime/index.js",
        from: "this.#trust.check(block.digest, declaration.effects);",
        to: "void 0;",
        mode: "grants",
        evidence: "async effect needs human grant",
      },
      {
        file: "core/runtime/services.js",
        from: "signal, timeoutMs: Math.min(options.timeoutMs, Math.max(1, this.deadline - Date.now()))",
        to: "signal: options.signal, timeoutMs: options.timeoutMs",
        mode: "timeout",
        evidence: "invocation must stop its entire process tree",
      },
      {
        file: "core/runtime/index.js",
        from: 'code: "INVOCATION_CANCELLED"',
        to: 'code: "INVOCATION_TIMEOUT"',
        mode: "cancel",
        evidence: "typed interruption",
      },
    ];
    for (const mutation of selectShard(
      mutations,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    )) {
      const file = join(privateCopy, "dist/src", mutation.file);
      const original = readFileSync(file, "utf8");
      expect(original).toContain(mutation.from);
      try {
        writeFileSync(file, original.replaceAll(mutation.from, mutation.to));
        const result = run(
          node,
          [join(privateCopy, "async-journey.mjs"), mutation.mode],
          consumer,
          env,
          15000,
        );
        expect(result.status, `counterfactual ${mutation.mode}`).not.toBe(0);
        expect(`${result.stdout} ${result.stderr}`).toContain(
          mutation.evidence,
        );
        console.log(
          `Async counterfactual ${mutation.mode}: expected failure observed`,
        );
      } finally {
        writeFileSync(file, original);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180000);
