// Pack the built package, install the tarball with npm on Node, and run `forge --version`.
// Run it with Node (`node tools/pack-smoke/run.ts`), never Bun: the point is that a user with
// only Node and npm can install and run what we publish. Build first (`bun run build`).
import { spawnSync } from "node:child_process";
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

function timed<T>(label: string, action: () => T): T {
  const started = performance.now();
  try {
    return action();
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

function run(
  label: string,
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): string {
  const result = timed(label, () =>
    spawnSync(command, args, {
      ...options,
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  if (result.error !== undefined) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${label} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

function main(): void {
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
  const probe = timed("no Bun on PATH", () =>
    spawnSync("bun", ["--version"], { env, windowsHide: true }),
  );
  if (probe.error === undefined)
    fail("bun is still resolvable on PATH; the smoke must run without Bun");
  step(`node ${process.version}, no bun on PATH`);

  const npmCli = locateNpmCli();
  const npm = (label: string, args: string[], cwd: string): string =>
    run(label, process.execPath, [npmCli, ...args], { cwd, env });
  step(`npm ${npm("npm --version", ["--version"], root).trim()}`);

  const work = mkdtempSync(join(tmpdir(), "forge-pack-smoke-"));
  try {
    const packDir = join(work, "pack");
    const consumer = join(work, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumer);

    const packed: unknown = JSON.parse(
      npm(
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
    npm(
      "npm install",
      [
        "install",
        join(packDir, entry.filename),
        "--no-audit",
        "--no-fund",
        "--cache",
        join(work, "cache"),
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

    const printed = npm(
      "forge --version (npm exec)",
      ["exec", "--no", "--", "forge", "--version"],
      consumer,
    ).trim();
    if (printed !== expected)
      fail(`forge --version printed "${printed}", expected "${expected}"`);
    step(`forge --version printed ${printed}`);

    const direct = run(
      "node bin",
      process.execPath,
      [join(installedDir, binTarget), "--version"],
      { cwd: consumer, env },
    );
    if (direct.trim() !== expected)
      fail(
        `bin run directly printed "${direct.trim()}", expected "${expected}"`,
      );

    const imported = run(
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
      const missingExport = timed("missing runtime export", () =>
        spawnSync(process.execPath, [join(consumer, "api.mjs")], {
          cwd: consumer,
          env,
          encoding: "utf8",
          windowsHide: true,
        }),
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
        const missingAsset = timed(`missing ${asset}`, () =>
          spawnSync(process.execPath, [join(consumer, "api.mjs")], {
            cwd: consumer,
            env,
            encoding: "utf8",
            windowsHide: true,
          }),
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
      run(
        "public APIs and JSON assets",
        process.execPath,
        [join(consumer, "api.mjs")],
        { cwd: consumer, env },
      ).trim(),
    );
    if (stateBun) {
      step("running packed state checks against the same npm install");
      console.log(
        run(
          "packed state integration",
          stateBun,
          ["test", "./test/node-fixtures/state/packed.integration.test.ts"],
          {
            cwd: root,
            env: { ...process.env, STATE_PACKED_CONSUMER: consumer },
          },
        ),
      );
    }
    console.log("pack-smoke: PASS");
  } finally {
    timed("cleanup", () => rmSync(work, { recursive: true, force: true }));
  }
}

try {
  timed("total", main);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
