import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { test, expect } from "bun:test";
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

const root = resolve(import.meta.dirname, "../..");
function timed<T>(label: string, action: () => T): T {
  const started = performance.now();
  try {
    return action();
  } finally {
    console.log(
      `Packed first slice ${label}: ${Math.round(performance.now() - started)} ms`,
    );
  }
}
function run(
  label: string,
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = timed(label, () =>
    spawnSync(command, args, {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 90000,
    }),
  );
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
  const started = performance.now();
  const sharedConsumer = process.env.FORGE_PACKED_CONSUMER;
  // A child workspace resolves the smoke's install through its ancestors without
  // sharing project files. Counterfactuals still mutate only their private copy.
  const work = mkdtempSync(
    join(
      sharedConsumer ?? tmpdir(),
      sharedConsumer ? "fs-" : "forge-first-slice-",
    ),
  );
  try {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required");
    // Keep project identities below the contract's length limit on macOS's long
    // temporary-directory prefix, including the private mutation workspace.
    const consumer = sharedConsumer ? work : join(work, "consumer");
    if (!sharedConsumer) mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      '{"name":"packed-consumer","version":"1.0.0","private":true,"type":"module"}',
    );
    const env = withoutBun();
    if (sharedConsumer) {
      console.log("Packed first slice: reusing smoke's pack and npm install");
    } else {
      run("build", process.execPath, ["run", "build"], root);
      const npm = [
        ...(process.env.FORGE_SMOKE_NPM_CLI
          ? [process.env.FORGE_SMOKE_NPM_CLI]
          : []),
        join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
        join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
      ].find((path) => existsSync(path));
      if (!npm) throw new Error("npm CLI is required");
      const packed = JSON.parse(
        run(
          "npm pack",
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
      run(
        "npm install",
        node,
        [
          npm,
          "install",
          join(work, packed[0]!.filename),
          "--no-audit",
          "--no-fund",
          "--prefer-offline",
        ],
        consumer,
        env,
      );
    }
    const fixtures = [
      "journey",
      "writer",
      "review",
      "mutation-proof",
      "review-two",
    ];
    for (const name of fixtures)
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
        run(
          `journey (${runtime})`,
          runtime,
          [join(consumer, "journey.mjs")],
          consumer,
          env,
        ),
      ).toContain("PASS all");
    for (const runtime of runtimes)
      expect(
        run(
          `review (${runtime})`,
          runtime,
          [join(consumer, "review.mjs")],
          consumer,
          env,
        ),
      ).toContain("PASS package-roots");
    for (const runtime of runtimes)
      expect(
        run(
          `review-two (${runtime})`,
          runtime,
          [join(consumer, "review-two.mjs")],
          consumer,
          env,
        ),
      ).toContain("PASS lifetime");
    const installed = join(
      sharedConsumer ?? consumer,
      "node_modules/forge-workflow",
    );
    const isolated = join(
      consumer,
      "node_modules/forge-first-slice-counterfactual",
    );
    timed("private mutation copy", () =>
      cpSync(installed, isolated, {
        recursive: true,
        filter: (path) => !path.endsWith(".map") && !path.endsWith(".ts"),
      }),
    );
    // Package self-references resolve from each fixture's location. Keep fixtures
    // inside the private copy so imports, CLI and writer children load that copy.
    for (const name of fixtures)
      copyFileSync(
        join(consumer, `${name}.mjs`),
        join(isolated, `${name}.mjs`),
      );
    const mutations = [
      {
        file: "src/assembly/state.js",
        from: "ensurePrivateDirectory(dirname(this.#path), this.#directories);",
        to: "void 0;",
        mode: "directories",
        fixture: "review-two",
        evidence: "each parent must be synced in order",
      },
      {
        file: "src/adapters/store-sqlite/file-ops.js",
        from: "syncParentDirectory(directory, fs);",
        to: "void 0;",
        mode: "directories",
        fixture: "review-two",
        evidence: "each parent must be synced in order",
      },
      {
        file: "src/adapters/store-sqlite/file-ops.js",
        from: "for (const directory of directories.reverse()) {",
        to: "for (const directory of directories.reverse()) { try { if (fs.statSync(directory).isDirectory()) continue; } catch (error) { if (error.code !== 'ENOENT') throw error; }",
        mode: "directory-retry",
        fixture: "review-two",
        evidence: "retry must re-sync the failed parent before opening storage",
      },
      {
        file: "src/assembly/command.js",
        from: 'argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v")',
        to: "false",
        mode: "bootstrap",
        fixture: "review-two",
        evidence: "version must not open local state",
      },
      {
        file: "src/assembly/command.js",
        from: "const response = respond(",
        to: "throw error; const response = respond(",
        mode: "bootstrap",
        fixture: "review-two",
        evidence: "bootstrap must return a JSON failure",
      },
      {
        file: "src/assembly/index.js",
        from: "readyBindings(active, name);",
        to: "void 0;",
        mode: "implicit-bindings",
        fixture: "review-two",
        evidence: "unsupported implicit bindings must not be advertised",
      },
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
        file: "src/assembly/command.js",
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
      const path = join(isolated, "dist", mutation.file);
      const original = readFileSync(path, "utf8");
      expect(original).toContain(mutation.from);
      try {
        const changed = original.replaceAll(mutation.from, mutation.to);
        expect(changed).not.toBe(original);
        writeFileSync(path, changed);
        expect(readFileSync(path, "utf8")).toBe(changed);
        const hash = createHash("sha256").update(changed).digest("hex");
        const proof = join(isolated, "mutation-proof.jsonl");
        writeFileSync(proof, "");
        const mutationEnv = {
          ...env,
          NODE_OPTIONS:
            `${env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(isolated, "mutation-proof.mjs")).href}`.trim(),
          FORGE_MUTATION_TARGET: realpathSync(path),
          FORGE_MUTATION_HASH: hash,
          FORGE_MUTATION_PROOF: proof,
        };
        const result = timed(
          `counterfactual ${mutation.fixture ?? "journey"}:${mutation.mode}`,
          () =>
            spawnSync(
              node,
              [
                join(isolated, `${mutation.fixture ?? "journey"}.mjs`),
                mutation.mode,
              ],
              {
                cwd: isolated,
                env: mutationEnv,
                encoding: "utf8",
                windowsHide: true,
                timeout: 45000,
              },
            ),
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
          readFileSync(join(installed, "dist", mutation.file), "utf8"),
        ).toBe(original);
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
    timed("cleanup", () => rmSync(work, { recursive: true, force: true }));
    console.log(
      `Packed first slice total: ${Math.round(performance.now() - started)} ms`,
    );
  }
}, 180000);
