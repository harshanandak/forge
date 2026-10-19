import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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
test("installed async ABI: supervised cleanup, strict containment, service revocation and CLI/MCP", () => {
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
    copyFileSync(
      join(root, "test/integration/fixtures/mutation-proof.mjs"),
      join(privateCopy, "mutation-proof.mjs"),
    );
    const mutations = [
      ...(process.platform === "win32"
        ? [
            {
              file: "adapters/process/windows-job.js",
              from: "if (api.terminateJobObject(job, 1) === 0)",
              to: "if (true)",
              mode: "job-termination",
              evidence: "typed interruption",
            },
          ]
        : []),
      {
        file: "core/runtime/index.js",
        from: "await scope.prepare(handle?.value);",
        to: "void 0;",
        mode: "strict-refusal",
        evidence: "strict containment must refuse before activation",
      },
      {
        file: "adapters/process/run.js",
        from: "stoppedPids = await container.stop();",
        to: "stoppedPids = [];",
        mode: "default-cleanup",
        evidence: "root exit must complete after tree cleanup",
      },
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
        from: ".run(executable, args, {",
        to: ".run(executable, args, {",
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
      {
        file: "core/runtime/services.js",
        from: "this.check();",
        to: "void 0;",
        mode: "leased",
        evidence: "settled leased client must not write",
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
        const changed =
          mutation.mode === "timeout"
            ? original.replace(
                /\.run\(executable, args, \{[\s\S]*?\}\)/,
                ".run(executable, args, options)",
              )
            : original.replaceAll(mutation.from, mutation.to);
        expect(changed).not.toBe(original);
        writeFileSync(file, changed);
        const proof = join(privateCopy, "mutation-proof.jsonl");
        writeFileSync(proof, "");
        const hash = createHash("sha256").update(changed).digest("hex");
        const mutationEnv = {
          ...env,
          NODE_OPTIONS:
            `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(privateCopy, "mutation-proof.mjs")).href}`.trim(),
          FORGE_MUTATION_TARGET: realpathSync(file),
          FORGE_MUTATION_HASH: hash,
          FORGE_MUTATION_PROOF: proof,
        };
        const result = run(
          node,
          [join(privateCopy, "async-journey.mjs"), mutation.mode],
          consumer,
          mutationEnv,
          15000,
        );
        const loaded = readFileSync(proof, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { target: string; hash: string });
        expect(
          loaded.some(
            (entry) =>
              entry.target === realpathSync(file) && entry.hash === hash,
          ),
          "counterfactual must load mutated bytes",
        ).toBe(true);
        expect(
          readFileSync(join(installed, "dist/src", mutation.file), "utf8"),
        ).toBe(original);
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
