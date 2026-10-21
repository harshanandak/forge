import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  packedCoverage,
  selectShard,
} from "../../node-fixtures/state/counterfactuals.ts";
import { providerCounterfactuals } from "../../node-fixtures/assembly-providers/counterfactuals.ts";
import { runFixtures } from "../../integration/fixtures/run.ts";
import { packedConsumer } from "../../integration/packed-consumer.ts";

const root = resolve(import.meta.dirname, "../../..");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 90000,
) {
  const started = performance.now();
  try {
    return spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout,
    });
  } finally {
    const label = args[0]?.endsWith("journey.mjs")
      ? (args[1] ?? "all")
      : (args[1] ?? args[0] ?? command);
    console.log(
      `Packed providers child ${label}: ${Math.round(performance.now() - started)} ms`,
    );
  }
}
function withoutBun(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key =
    Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  env[key] = (env[key] ?? "")
    .split(delimiter)
    .filter(
      (directory) =>
        !["bun", "bun.exe", "bunx", "bunx.exe"].some((name) =>
          existsSync(join(directory, name)),
        ),
    )
    .join(delimiter);
  delete env.BUN_INSTALL;
  return env;
}
test("packed stock providers: declared capabilities, generated CLI/MCP, bounded clone files, snapshot and scoped processes", async () => {
  const started = performance.now();
  let phaseStarted = started;
  function phase(name: string, detail = "") {
    console.log(
      `Packed providers ${name}: ${Math.round(performance.now() - phaseStarted)} ms${detail}`,
    );
    phaseStarted = performance.now();
  }
  const shared = packedConsumer();
  const work = mkdtempSync(join(shared, "ap-"));
  const node = Bun.which("node");
  if (!node) throw Error("Node is required");
  const env = withoutBun();
  try {
    const consumer = work;
    writeFileSync(
      join(consumer, "package.json"),
      '{"private":true,"type":"module"}',
    );
    const runtimes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((value): value is string =>
          Boolean(value),
        ),
      ),
    ];
    // Node cannot strip TypeScript inside the installed package, so the
    // journey gets the shared state-aware liveness probe as plain JS.
    const liveness = new Bun.Transpiler({ loader: "ts" }).transformSync(
      readFileSync(
        join(root, "test/node-fixtures/process/liveness.ts"),
        "utf8",
      ),
    );
    const positives = runtimes.map((runtime) => {
      const cwd = mkdtempSync(join(consumer, "p-"));
      for (const file of ["journey.mjs", "entry.cjs"])
        copyFileSync(
          join(root, "test/node-fixtures/assembly-providers", file),
          join(cwd, file),
        );
      writeFileSync(join(cwd, "liveness.mjs"), liveness);
      return {
        label: `all (${runtime})`,
        command: runtime,
        args: [join(cwd, "journey.mjs")],
        cwd,
        env,
      };
    });
    const outputs = await runFixtures(positives, 2, "Packed providers");
    for (const output of outputs)
      expect(output).toContain("PASS assembly-providers all");
    phase("positive fixtures");

    const installed = join(shared, "node_modules/forge-workflow");
    const isolated = join(
      consumer,
      "node_modules/forge-provider-counterfactual",
    );
    cpSync(installed, isolated, {
      recursive: true,
      filter: (file) => !file.endsWith(".map") && !file.endsWith(".ts"),
    });
    for (const file of ["journey.mjs", "entry.cjs"])
      copyFileSync(
        join(root, "test/node-fixtures/assembly-providers", file),
        join(isolated, file),
      );
    writeFileSync(join(isolated, "liveness.mjs"), liveness);
    copyFileSync(
      join(root, "test/integration/fixtures/mutation-proof.mjs"),
      join(isolated, "mutation-proof.mjs"),
    );
    phase("copy");
    for (const mutation of selectShard(
      providerCounterfactuals,
      packedCoverage(process.env.STATE_NODE_LEG).shard,
    )) {
      const file = join(isolated, "dist/src", mutation.file);
      const original = readFileSync(file, "utf8");
      expect(original, mutation.mode).toContain(mutation.from);
      try {
        const changed = original.replaceAll(mutation.from, mutation.to);
        writeFileSync(file, changed);
        const hash = createHash("sha256").update(changed).digest("hex");
        const proof = join(isolated, "mutation-proof.jsonl");
        writeFileSync(proof, "");
        const result = run(
          node,
          [join(isolated, "journey.mjs"), mutation.mode],
          consumer,
          {
            ...env,
            NODE_OPTIONS:
              `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(isolated, "mutation-proof.mjs")).href}`.trim(),
            FORGE_MUTATION_TARGET: realpathSync(file),
            FORGE_MUTATION_HASH: hash,
            FORGE_MUTATION_PROOF: proof,
          },
          30000,
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
          "the private counterfactual must load the mutated installed bytes",
        ).toBe(true);
        expect(
          readFileSync(join(installed, "dist/src", mutation.file), "utf8"),
          "the shared installation must remain unchanged",
        ).toBe(original);
        expect(result.status, mutation.mode).not.toBe(0);
        expect(`${result.stdout} ${result.stderr}`, mutation.mode).toContain(
          mutation.evidence,
        );
        console.log(
          `Provider counterfactual ${mutation.mode}: loaded mutated bytes, expected failure observed`,
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
      `Packed providers total: ${Math.round(performance.now() - started)} ms`,
    );
  }
}, 180000);
