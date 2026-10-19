import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
test("packed stock providers: declared capabilities, generated CLI/MCP, bounded clone files, snapshot and scoped processes", () => {
  const shared = process.env.FORGE_PACKED_CONSUMER;
  const work = mkdtempSync(
    join(shared ?? tmpdir(), shared ? "ap-" : "forge-providers-"),
  );
  const node = Bun.which("node");
  if (!node) throw Error("Node is required");
  const env = withoutBun();
  const successful = (
    command: string,
    args: string[],
    cwd: string,
    childEnv = env,
  ): string => {
    const result = run(command, args, cwd, childEnv);
    expect(
      result.status,
      `${result.error?.message ?? ""} ${result.stdout} ${result.stderr}`,
    ).toBe(0);
    return result.stdout;
  };
  try {
    const consumer = shared ? work : join(work, "consumer");
    if (!shared) mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"private":true,"type":"module"}',
    );
    if (!shared) {
      successful(process.execPath, ["run", "build"], root, process.env);
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find(existsSync);
      if (!npm) throw Error("npm CLI is required");
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
    }
    for (const file of ["journey.mjs", "entry.cjs"])
      copyFileSync(
        join(root, "test/node-fixtures/assembly-providers", file),
        join(consumer, file),
      );
    for (const runtime of new Set(
      [node, process.env.FORGE_NODE26].filter((value): value is string =>
        Boolean(value),
      ),
    ))
      expect(
        successful(runtime, [join(consumer, "journey.mjs")], consumer),
      ).toContain("PASS assembly-providers all");

    const installed = join(shared ?? consumer, "node_modules/forge-workflow");
    const isolated = join(
      consumer,
      "node_modules/forge-provider-counterfactual",
    );
    cpSync(installed, isolated, {
      recursive: true,
      filter: (file) => !file.endsWith(".map") && !file.endsWith(".ts"),
    });
    for (const file of ["journey.mjs", "entry.cjs"])
      copyFileSync(join(consumer, file), join(isolated, file));
    copyFileSync(
      join(root, "test/integration/fixtures/mutation-proof.mjs"),
      join(isolated, "mutation-proof.mjs"),
    );
    const mutations = [
      {
        file: "adapters/fs/clone-files.js",
        from: "if (!sameCapturedFile(",
        to: "if (false && !sameCapturedFile(",
        mode: "conditional-race",
        evidence: "a concurrent target replacement must be refused",
      },
      {
        file: "assembly/index.js",
        from: 'declaration.effects.includes(`${op.split(".")[0]}:write`)',
        to: "declaration.effects.length > 0",
        mode: "stateless",
        evidence:
          "a stateless operation with only non-state effects must compose",
      },
      {
        file: "assembly/index.js",
        from: "storage.acquire(scope.effects.includes(`${noun}:write`))",
        to: "storage.acquire(scope.effects.length > 0)",
        mode: "state-read",
        evidence: "non-state effects must not open writable project state",
      },
      {
        file: "assembly/providers.js",
        from: '!scope.effects.includes("external:process")',
        to: "false",
        mode: "process-effect",
        evidence: "process launch must require a declared launch effect",
      },
      {
        file: "assembly/providers.js",
        from: '!scope.effects.includes("environment:read")',
        to: "false",
        mode: "environment-effect",
        evidence: "environment selection must require its declared effect",
      },
      {
        file: "adapters/fs/clone-files.js",
        from: "if (!options.read)",
        to: "if (false)",
        mode: "files-effect",
        evidence: "file reads must require their declared effect",
      },
      {
        file: "adapters/fs/clone-files.js",
        from: "condition.expected",
        to: "undefined",
        mode: "files-cas",
        evidence: "compare before replace must preserve user content",
      },
      {
        file: "adapters/fs/clone-files.js",
        from: "bytes?.byteLength ?? null",
        to: "bytes?.byteLength ?? 0",
        mode: "snapshot",
        evidence: "missing and empty selected inputs have different identities",
      },
      {
        file: "adapters/fs/clone-files.js",
        from: "hash.update(bytes);",
        to: "hash.update(new Uint8Array(bytes.byteLength));",
        mode: "snapshot",
        evidence: "snapshot hashes actual selected input bytes",
      },
    ];
    for (const mutation of selectShard(
      mutations,
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180000);
