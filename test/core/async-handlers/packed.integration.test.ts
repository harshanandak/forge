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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, delimiter } from "node:path";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { asyncCounterfactuals } from "../../node-fixtures/async-handlers/counterfactuals.ts";
import { runFixtures } from "../../integration/fixtures/run.ts";
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

test("installed async ABI: supervised cleanup, strict containment, service revocation and CLI/MCP", async () => {
  const started = performance.now();
  let phaseStarted = started;
  function phase(name: string, detail = "") {
    console.log(
      `Packed async ${name}: ${Math.round(performance.now() - phaseStarted)} ms${detail}`,
    );
    phaseStarted = performance.now();
  }
  const work = mkdtempSync(join(root, ".async-packed-"));
  const node = Bun.which("node");
  if (!node) throw Error("Node required");
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
    // The smoke keeps its real npm install alive until this process finishes.
    const sharedConsumer = process.env.ASYNC_PACKED_CONSUMER;
    const consumer = sharedConsumer ?? join(work, "consumer");
    if (!sharedConsumer) {
      const npm = [
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw Error("npm required");

      successful(process.execPath, ["run", "build"], root, process.env);
      phase("build");
      const packed = JSON.parse(
        successful(
          node,
          [
            npm,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            work,
          ],
          root,
        ),
      ) as { filename: string }[];
      phase("pack");
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
      phase("install");
    } else {
      phase("build", " (shared consumer)");
      phase("pack", " (shared consumer)");
      phase("install", " (shared consumer)");
    }
    const installed = join(consumer, "node_modules/forge-workflow");
    // Package self-references resolve here; dependency lookup borrows the install.
    // All fixture files and mutations stay inside this suite's private workspace.
    const privateCopy = join(work, "package");
    cpSync(installed, privateCopy, {
      recursive: true,
      filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
    });
    symlinkSync(
      resolve(consumer, "node_modules"),
      join(work, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const [source, target] of [
      ["test/node-fixtures/async-handlers/journey.mjs", "async-journey.mjs"],
      ["test/node-fixtures/async-handlers/deadline.mjs", "deadline.mjs"],
      ["test/integration/fixtures/mutation-proof.mjs", "mutation-proof.mjs"],
    ] as const)
      copyFileSync(join(root, source), join(privateCopy, target));
    // Run the same state-aware probe tested by the source fixtures, as plain JS
    // inside the installed package where Node cannot strip TypeScript.
    writeFileSync(
      join(privateCopy, "liveness.mjs"),
      new Bun.Transpiler({ loader: "ts" }).transformSync(
        readFileSync(
          join(root, "test/node-fixtures/process/liveness.ts"),
          "utf8",
        ),
      ),
    );
    phase("privatecopies");
    const journey = join(privateCopy, "async-journey.mjs");
    const runtimes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    const positives = runtimes.map((runtime) => ({
      label: `async all (${runtime})`,
      command: runtime,
      args: [journey],
      cwd: work,
      env,
    }));
    // Each process creates its own fixture root; drain both before mutating.
    const outputs = await runFixtures(positives, 2, "Packed async");
    for (const output of outputs)
      expect(output).toContain("PASS async-handlers all");
    phase("positives");
    for (const mutation of selectShard(
      asyncCounterfactuals(process.platform),
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
          work,
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
    phase("mutations");
  } finally {
    phaseStarted = performance.now();
    rmSync(work, { recursive: true, force: true });
    phase("cleanup");
    console.log(
      `Packed async total: ${Math.round(performance.now() - started)} ms`,
    );
  }
}, 180000);
