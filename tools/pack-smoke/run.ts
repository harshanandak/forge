// Pack the built package, install the tarball with npm on Node, and run `forge --version`.
// Run it with Node (`node tools/pack-smoke/run.ts`), never Bun: the point is that a user with
// only Node and npm can install and run what we publish. Build first (`bun run build`).
import { ChildRunError, runChild } from "../child-runner.ts";
import { inheritRunnerGroup, readRunnerPolicy } from "../runner-policy.ts";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const policy = readRunnerPolicy();
const scope = new AbortController();
const deadline = performance.now() + policy.stepTimeoutMs;
const stepTimer = setTimeout(
  () => scope.abort(new Error("pack smoke step deadline exceeded")),
  policy.stepTimeoutMs,
);
function childOptions(cwd: string, env: NodeJS.ProcessEnv) {
  return {
    cwd,
    env,
    inheritProcessGroup: inheritRunnerGroup(),
    timeoutMs: Math.max(
      1,
      Math.min(policy.childTimeoutMs, Math.floor(deadline - performance.now())),
    ),
    cleanupTimeoutMs: policy.cleanupTimeoutMs,
    maxOutputBytes: policy.maxOutputBytes,
    signal: scope.signal,
  };
}
const BUN_FILES = [
  "bun",
  "bun.exe",
  "bun.cmd",
  "bun.ps1",
  "bunx",
  "bunx.exe",
  "bunx.cmd",
];

function fail(message: string): never {
  throw new Error(`pack-smoke: ${message}`);
}

function step(message: string): void {
  console.log(`- ${message}`);
}

async function timed<T>(
  label: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now();
  console.log(`START pack smoke ${label}`);
  try {
    return await action();
  } finally {
    console.log(
      `Pack smoke ${label}: ${Math.round(performance.now() - started)} ms`,
    );
  }
}

/** The current environment with every directory that holds a Bun executable removed from PATH. */
function environmentWithoutBun(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const key =
    Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  const kept = (env[key] ?? "")
    .split(delimiter)
    .filter(
      (dir) =>
        dir !== "" && !BUN_FILES.some((file) => existsSync(join(dir, file))),
    );
  env[key] = kept.join(delimiter);
  delete env.BUN_INSTALL;
  return env;
}

function locateNpmCli(): string {
  const bin = dirname(process.execPath);
  const candidates = [
    ...(process.env.FORGE_SMOKE_NPM_CLI
      ? [process.env.FORGE_SMOKE_NPM_CLI]
      : []),
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? fail(`npm-cli.js not found next to ${process.execPath}`);
}

async function run(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<string> {
  const result = await timed(label, () =>
    runChild(`pack smoke ${label}`, command, args, {
      ...childOptions(options.cwd, options.env),
      // Keep machine-readable stdout intact; failures print its retained tail.
      onOutput: (stream, text) => {
        if (stream === "stderr") process.stderr.write(text);
      },
    }),
  );
  return result.stdout;
}

async function packedIntegration(
  bun: string,
  file: string,
  label: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await timed(label, () =>
    runChild(label, bun, ["test", `./${file}`], {
      ...childOptions(root, env),
      onOutput: (stream, value) => {
        (stream === "stdout" ? process.stdout : process.stderr).write(value);
      },
    }),
  );
}

async function main(): Promise<void> {
  if (process.versions.bun !== undefined) fail("run this with Node, not Bun");
  const stateBun =
    process.argv[2] === "--state-test" ? process.argv[3] : undefined;
  if (process.argv.length !== (stateBun ? 4 : 2))
    fail("usage: run.ts [--state-test <bun-executable>]");
  const pkg: unknown = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  const expected = (pkg as { version?: unknown }).version;
  if (typeof expected !== "string") fail("package.json has no version");
  if (!existsSync(join(root, "dist", "bin", "forge.js")))
    fail("dist/ is missing; run `bun run build` first");

  const env = environmentWithoutBun();
  try {
    await timed("no Bun on PATH", () =>
      runChild("no Bun on PATH", "bun", ["--version"], childOptions(root, env)),
    );
    fail("bun is still resolvable on PATH; the smoke must run without Bun");
  } catch (error) {
    const cause = error instanceof ChildRunError ? error.cause : undefined;
    if (!(
      cause !== null &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ENOENT"
    ))
      throw error;
  }
  step(`node ${process.version}, no bun on PATH`);

  const npmCli = locateNpmCli();
  const npm = (label: string, args: string[], cwd: string): Promise<string> =>
    run(label, process.execPath, [npmCli, ...args], { cwd, env });
  step(`npm ${(await npm("npm --version", ["--version"], root)).trim()}`);

  const work = mkdtempSync(join(tmpdir(), "forge-pack-smoke-"));
  try {
    const packDir = join(work, "pack");
    const consumer = join(work, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumer);

    const packed: unknown = JSON.parse(
      await npm(
        "npm pack",
        ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
        root,
      ),
    );
    const entry = (Array.isArray(packed) ? packed[0] : undefined) as
      { filename?: string; files?: { path: string }[] } | undefined;
    if (entry?.filename === undefined || entry.files === undefined)
      fail("npm pack gave no tarball");
    const files = entry.files.map((file) => file.path);
    for (const needed of [
      "package.json",
      "LICENSE",
      "README.md",
      "dist/bin/forge.js",
      "dist/src/index.js",
      "dist/src/index.d.ts",
    ]) {
      if (!files.includes(needed)) fail(`tarball is missing ${needed}`);
    }
    const stray = files.filter(
      (file) => !/^(?:dist\/|package\.json$|LICENSE$|README\.md$)/.test(file),
    );
    if (stray.length > 0)
      fail(
        `tarball holds files that are not part of the package: ${stray.join(", ")}`,
      );
    step(
      `packed ${entry.filename} (${files.length} files, only the built package)`,
    );

    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", version: "0.0.0", private: true }),
    );
    await npm(
      "npm install",
      [
        "install",
        join(packDir, entry.filename),
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      consumer,
    );
    step("installed the tarball with npm");

    const installedDir = join(consumer, "node_modules", "forge-workflow");
    const installed: unknown = JSON.parse(
      readFileSync(join(installedDir, "package.json"), "utf8"),
    );
    const binTarget = (installed as { bin?: { forge?: unknown } }).bin?.forge;
    if (typeof binTarget !== "string")
      fail("installed package has no bin.forge");
    const shims = ["forge", "forge.cmd"].map((name) =>
      join(consumer, "node_modules", ".bin", name),
    );
    if (!shims.some((shim) => existsSync(shim)))
      fail("npm did not link a forge command into node_modules/.bin");

    const printed = (
      await npm(
        "forge --version (npm exec)",
        ["exec", "--no", "--", "forge", "--version"],
        consumer,
      )
    ).trim();
    if (printed !== expected)
      fail(`forge --version printed "${printed}", expected "${expected}"`);
    step(`forge --version printed ${printed}`);

    const direct = await run(
      "node bin",
      process.execPath,
      [join(installedDir, binTarget), "--version"],
      { cwd: consumer, env },
    );
    if (direct.trim() !== expected)
      fail(
        `bin run directly printed "${direct.trim()}", expected "${expected}"`,
      );

    const imported = await run(
      "import",
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { version } from 'forge-workflow'; console.log(version);",
      ],
      { cwd: consumer, env },
    );
    if (imported.trim() !== expected)
      fail(`import gave "${imported.trim()}", expected "${expected}"`);
    step("the package exports resolve under Node");
    copyFileSync(
      join(root, "tools/pack-smoke/api.mjs"),
      join(consumer, "api.mjs"),
    );
    // Counterfactuals run against the installed artifact, then restore its bytes.
    const packageFile = join(installedDir, "package.json");
    const packageBytes = readFileSync(packageFile, "utf8");
    const packageData = JSON.parse(packageBytes) as {
      exports: Record<string, unknown>;
    };
    delete packageData.exports["./runtime"];
    writeFileSync(packageFile, JSON.stringify(packageData));
    try {
      const missingExport = await timed("missing runtime export", () =>
        runChild(
          "missing runtime export",
          process.execPath,
          [join(consumer, "api.mjs")],
          {
            ...childOptions(consumer, env),
            acceptableExitCodes: null,
          },
        ),
      );
      if (
        missingExport.status === 0 ||
        !missingExport.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")
      )
        fail("missing public export did not fail the API journey");
    } finally {
      writeFileSync(packageFile, packageBytes);
    }
    for (const asset of [
      "dist/src/core/config/operations.json",
      "dist/schemas/config.json",
    ]) {
      const path = join(installedDir, asset);
      renameSync(path, `${path}.hidden`);
      try {
        const missingAsset = await timed(`missing ${asset}`, () =>
          runChild(
            `missing ${asset}`,
            process.execPath,
            [join(consumer, "api.mjs")],
            {
              ...childOptions(consumer, env),
              acceptableExitCodes: null,
            },
          ),
        );
        if (
          missingAsset.status === 0 ||
          !missingAsset.stderr.includes("ENOENT")
        )
          fail(`missing ${asset} did not fail the API journey`);
      } finally {
        renameSync(`${path}.hidden`, path);
      }
    }
    step(
      "remove-the-fix: missing runtime export and both JSON asset sets fail the API journey",
    );
    step(
      (
        await run(
          "public APIs and JSON assets",
          process.execPath,
          [join(consumer, "api.mjs")],
          { cwd: consumer, env },
        )
      ).trim(),
    );
    if (stateBun) {
      step(
        "running packed first slice, state and memory checks against the same npm install",
      );
      // The suites read the base install and mutate private copies. Drain all
      // children before cleanup, including when either suite fails.
      const results = await Promise.allSettled([
        packedIntegration(
          stateBun,
          "test/integration/github-accounts/packed.integration.test.ts",
          "packed GitHub accounts",
          { ...process.env, FORGE_PACKED_CONSUMER: consumer },
        ),
        packedIntegration(
          stateBun,
          "test/assembly/providers/packed.integration.test.ts",
          "packed assembly providers",
          { ...process.env, FORGE_PACKED_CONSUMER: consumer },
        ),
        packedIntegration(
          stateBun,
          "test/integration/packed.integration.test.ts",
          "packed first slice integration",
          { ...process.env, FORGE_PACKED_CONSUMER: consumer },
        ),
        packedIntegration(
          stateBun,
          "test/node-fixtures/state/packed.integration.test.ts",
          "packed state integration",
          { ...process.env, STATE_PACKED_CONSUMER: consumer },
        ),
        packedIntegration(
          stateBun,
          "test/node-fixtures/memory/packed.integration.test.ts",
          "packed memory integration",
          { ...process.env, MEMORY_PACKED_CONSUMER: consumer },
        ),
      ]);
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }
    console.log("pack-smoke: PASS");
  } finally {
    await timed("cleanup", () =>
      rmSync(work, { recursive: true, force: true }),
    );
  }
}

const started = performance.now();
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  clearTimeout(stepTimer);
  console.log(
    `Pack smoke total: ${Math.round(performance.now() - started)} ms`,
  );
}
