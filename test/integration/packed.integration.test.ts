import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
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

const root = resolve(import.meta.dirname, "../..");
function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 90000,
  });
  if (result.status !== 0)
    throw new Error(
      `${result.error?.message ?? "process failed"}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}
function withoutBun(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const path =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[path] = (env[path] ?? "")
    .split(delimiter)
    .filter(
      (dir) =>
        !["bun", "bun.exe", "bun.cmd", "bunx", "bunx.exe"].some((name) =>
          existsSync(join(dir, name)),
        ),
    )
    .join(delimiter);
  delete env.BUN_INSTALL;
  return env;
}

test("packed first slice: npm detection, human admission, CLI/MCP parity and competing revisions", () => {
  const work = mkdtempSync(join(tmpdir(), "forge-first-slice-"));
  try {
    run(process.execPath, ["run", "build"], root);
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    const npm = [
      join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
      join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
    ].find((path) => existsSync(path));
    if (!npm) throw new Error("npm CLI is required");
    const packed = JSON.parse(
      run(
        node,
        [npm, "pack", "--json", "--ignore-scripts", "--pack-destination", work],
        root,
      ),
    ) as { filename: string }[];
    const consumer = join(work, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"packed-consumer","version":"1.0.0","private":true,"type":"module"}',
    );
    const env = withoutBun();
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
      env,
    );
    for (const name of [
      "journey",
      "writer",
      "review",
      "mutation-proof",
      "review-two",
    ])
      copyFileSync(
        join(import.meta.dirname, `fixtures/${name}.mjs`),
        join(consumer, `${name}.mjs`),
      );
    const runtimes = [
      ...new Set(
        [node, process.env.FORGE_NODE26].filter((runtime): runtime is string =>
          Boolean(runtime),
        ),
      ),
    ];
    for (const runtime of runtimes)
      expect(
        run(runtime, [join(consumer, "journey.mjs")], consumer, env),
      ).toContain("PASS all");
    for (const runtime of runtimes)
      expect(
        run(runtime, [join(consumer, "review.mjs")], consumer, env),
      ).toContain("PASS package-roots");
    for (const runtime of runtimes)
      expect(
        run(runtime, [join(consumer, "review-two.mjs")], consumer, env),
      ).toContain("PASS lifetime");
    const installed = join(consumer, "node_modules/forge-workflow/dist");
    const mutations = [
      {
        file: "src/assembly/index.js",
        from: "const reason = error instanceof Error",
        to: "throw error; const reason = error instanceof Error",
        mode: "bad-docs",
        fixture: "review-two",
        evidence: "config show:",
      },
      {
        file: "src/assembly/index.js",
        from: "const namespace = current.blocks.get(instance).manifest.id;",
        to: "if (context.variant !== 'project') continue; const namespace = current.blocks.get(instance).manifest.id;",
        mode: "bindings",
        fixture: "review-two",
        evidence: "required service must be available",
      },
      {
        file: "src/assembly/state.js",
        from: "if (--entry.refs !== 0)",
        to: "if (false)",
        mode: "lifetime",
        fixture: "review-two",
        evidence: "first invocation cannot close",
      },
      {
        file: "src/assembly/state.js",
        from: "const result = this.#queue.then(work);",
        to: "const result = work();",
        mode: "lifetime",
        fixture: "review-two",
        evidence: "concurrent first opens must be serialized",
      },

      {
        file: "src/assembly/index.js",
        from: "const reason = error instanceof Error",
        to: "throw error; const reason = error instanceof Error",
        mode: "missing-sources",
        fixture: "review",
        evidence: "config show:",
      },
      {
        file: "src/assembly/capture.js",
        from: "const candidate = join(directory, source.package);",
        to: 'const candidate = resolve(require.resolve(`${source.package}/package.json`), "..");',
        mode: "package-roots",
        fixture: "review",
        evidence: "block check hidden-block",
      },

      {
        file: "src/assembly/index.js",
        from: "detectProject(createFolderFiles(root)).observations",
        to: "[]",
        mode: "detection",
        evidence: "derived npm command",
      },
      {
        file: "src/core/runtime/index.js",
        from: "this.#trust.check(block.digest, declaration.effects);",
        to: "void 0;",
        mode: "admission",
        evidence: "unadmitted agent call",
      },
      {
        file: "bin/forge.js",
        from: "catalog: assembly.catalog",
        to: "catalog: { list: () => [], invoke: assembly.catalog.invoke }",
        mode: "all",
        evidence: "Unknown operation: config.show",
      },
      {
        file: "src/assembly/index.js",
        from: "structuredClone(value)",
        to: "value",
        mode: "all",
        evidence: "State values must be plain JSON",
      },
      ...["all", "race"].map((mode) => ({
        file: "src/assembly/index.js",
        from: "expectRevision: options.expectRevision",
        to: "expectRevision: owner.get(namespace, key)?.revision ?? 0",
        mode,
        evidence: mode === "race" ? "one writer wins" : "semver mark 1.6.0 0",
      })),
    ];
    for (const mutation of mutations) {
      const path = join(installed, mutation.file);
      const original = readFileSync(path, "utf8");
      expect(original).toContain(mutation.from);
      try {
        const changed = original.replaceAll(mutation.from, mutation.to);
        expect(changed).not.toBe(original);
        writeFileSync(path, changed);
        expect(readFileSync(path, "utf8")).toBe(changed);
        const hash = createHash("sha256").update(changed).digest("hex");
        const proof = join(consumer, "mutation-proof.jsonl");
        writeFileSync(proof, "");
        const mutationEnv = {
          ...env,
          NODE_OPTIONS:
            `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(consumer, "mutation-proof.mjs")).href}`.trim(),
          FORGE_MUTATION_TARGET: realpathSync(path),
          FORGE_MUTATION_HASH: hash,
          FORGE_MUTATION_PROOF: proof,
        };
        const result = spawnSync(
          node,
          [
            join(consumer, `${mutation.fixture ?? "journey"}.mjs`),
            mutation.mode,
          ],
          {
            cwd: consumer,
            env: mutationEnv,
            encoding: "utf8",
            windowsHide: true,
            timeout: 45000,
          },
        );
        const loaded = readFileSync(proof, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { target: string; hash: string });
        expect(
          loaded.some(
            (entry) =>
              entry.target === realpathSync(path) && entry.hash === hash,
          ),
          `child must load the mutated ${mutation.file}`,
        ).toBe(true);
        expect(
          result.status,
          `${mutation.fixture ?? "journey"}:${mutation.mode} must detect the mutation in ${mutation.file}`,
        ).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          mutation.evidence,
        );
        console.log(
          `Counterfactual ${mutation.fixture ?? "journey"}:${mutation.mode}: loaded mutated bytes, expected failure observed`,
        );
      } finally {
        writeFileSync(path, original);
      }
    }
    console.log(
      `Packed first slice: ${runtimes.length} Node runtimes, 5 acceptance items, ${mutations.length} remove-the-fix checks`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 180000);
