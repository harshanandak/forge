// Pack the built package once, install the tarball with npm on Node with no Bun on PATH, check the
// installed package, then run every packed journey (`packed.integration.test.ts`) with `bun test`
// against that one install. Run it with Node (`bun run test:pack` builds first and does this): the
// point is that a user with only Node and npm can install and run what we publish.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
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
import { dirname, join, resolve } from "node:path";
import { runWithin } from "./bounded.ts";
import { environmentWithoutBun, resolveBun } from "./environment.ts";

const root = resolve(import.meta.dirname, "../..");
// One command that hangs fails with its name instead of stalling the job.
const COMMAND_TIMEOUT_MS = 300_000;
// The whole pack-smoke step took at most 132 s in recent CI (Windows, Node 24); 10 minutes is
// over four times that and still well inside the job's 20-minute ceiling.
const JOURNEYS_TIMEOUT_MS = 600_000;

function fail(message: string): never {
  throw new Error(`pack-smoke: ${message}`);
}

function run(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): SpawnSyncReturns<string> {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: COMMAND_TIMEOUT_MS,
  });
  console.log(
    `  ${[command, ...args].join(" ")}: ${Math.round(performance.now() - started)} ms`,
  );
  return result;
}

function ok(result: SpawnSyncReturns<string>): string {
  if (result.error || result.status !== 0)
    fail(
      `${result.error?.message ?? `exited ${String(result.status)}`}\n${result.stdout}\n${result.stderr}`,
    );
  return result.stdout;
}

async function main(): Promise<void> {
  if (process.versions.bun !== undefined) fail("run this with Node, not Bun");
  const expected = (
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      version?: unknown;
    }
  ).version;
  if (typeof expected !== "string") fail("package.json has no version");
  if (!existsSync(join(root, "dist", "bin", "forge.js")))
    fail("dist/ is missing; run `bun run build` first");

  const bun = resolveBun();
  const env = environmentWithoutBun();
  if (run("bun", ["--version"], root, env).error === undefined)
    fail("bun is still resolvable on PATH; the smoke must run without Bun");
  const npmCli = [
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find((candidate) => existsSync(candidate));
  if (npmCli === undefined)
    fail(`npm-cli.js not found next to ${process.execPath}`);
  const npm = (args: string[], cwd: string): string =>
    ok(run(process.execPath, [npmCli, ...args], cwd, env));
  console.log(
    `- node ${process.version}, npm ${npm(["--version"], root).trim()}, no bun on PATH`,
  );

  const work = mkdtempSync(join(tmpdir(), "forge-pack-smoke-"));
  try {
    const packDir = join(work, "pack");
    const consumer = join(work, "consumer");
    mkdirSync(packDir);
    mkdirSync(consumer);

    const packed: unknown = JSON.parse(
      npm(
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
      "templates/delivery/forge.template.json",
      "templates/delivery/skills/loop/SKILL.md",
    ])
      if (!files.includes(needed)) fail(`tarball is missing ${needed}`);
    const stray = files.filter(
      (file) =>
        !/^(?:dist\/|templates\/|package\.json$|LICENSE$|README\.md$)/.test(
          file,
        ),
    );
    if (stray.length > 0)
      fail(`tarball holds files outside the package: ${stray.join(", ")}`);
    console.log(`- packed ${entry.filename} (${files.length} files)`);

    writeFileSync(
      join(consumer, "package.json"),
      JSON.stringify({ name: "consumer", version: "0.0.0", private: true }),
    );
    npm(
      [
        "install",
        join(packDir, entry.filename),
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
      ],
      consumer,
    );
    console.log("- installed the tarball with npm");

    const installedDir = join(consumer, "node_modules", "forge-workflow");
    const binTarget = (
      JSON.parse(readFileSync(join(installedDir, "package.json"), "utf8")) as {
        bin?: { forge?: unknown };
      }
    ).bin?.forge;
    if (typeof binTarget !== "string")
      fail("installed package has no bin.forge");
    if (
      !["forge", "forge.cmd"].some((name) =>
        existsSync(join(consumer, "node_modules", ".bin", name)),
      )
    )
      fail("npm did not link a forge command into node_modules/.bin");
    const node = (args: string[]): SpawnSyncReturns<string> =>
      run(process.execPath, args, consumer, env);
    for (const [how, printed] of [
      ["npm exec", npm(["exec", "--no", "--", "forge", "--version"], consumer)],
      ["the bin", ok(node([join(installedDir, binTarget), "--version"]))],
      [
        "import",
        ok(
          node([
            "--input-type=module",
            "-e",
            "import { version } from 'forge-workflow'; console.log(version);",
          ]),
        ),
      ],
    ])
      if (printed!.trim() !== expected)
        fail(`${how} printed "${printed!.trim()}", expected "${expected}"`);
    console.log(
      `- forge ${expected} runs through npm exec, its bin and import`,
    );

    const api = join(consumer, "api.mjs");
    copyFileSync(join(root, "tools/pack-smoke/api.mjs"), api);
    // Remove-the-fix: each break of the installed artifact must fail the API journey.
    const packageFile = join(installedDir, "package.json");
    const packageBytes = readFileSync(packageFile, "utf8");
    const packageData = JSON.parse(packageBytes) as {
      exports: Record<string, unknown>;
    };
    delete packageData.exports["./runtime"];
    writeFileSync(packageFile, JSON.stringify(packageData));
    try {
      const missing = node([api]);
      if (
        missing.status === 0 ||
        !missing.stderr.includes("ERR_PACKAGE_PATH_NOT_EXPORTED")
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
        const missing = node([api]);
        if (missing.status === 0 || !missing.stderr.includes("ENOENT"))
          fail(`missing ${asset} did not fail the API journey`);
      } finally {
        renameSync(`${path}.hidden`, path);
      }
    }
    console.log(`- ${ok(node([api])).trim()}; each removed fix fails it`);

    // The packed journeys read the install and mutate private copies, so files run in parallel.
    console.log("- running the packed journeys against this install");
    try {
      await runWithin(
        "packed journeys",
        bun,
        [
          "test",
          "--parallel=2",
          "--timeout",
          "30000",
          "packed.integration.test",
        ],
        {
          cwd: root,
          env: { ...env, FORGE_PACKED_CONSUMER: consumer },
        },
        JOURNEYS_TIMEOUT_MS,
      );
    } catch (error) {
      fail((error as Error).message);
    }
    console.log("pack-smoke: PASS");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

await main();
