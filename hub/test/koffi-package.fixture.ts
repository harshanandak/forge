import { equal, match, ok, rejects } from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { binaryName, nativeName } from "./koffi-load.fixture.ts";

const exec = promisify(execFile);
const temp = process.env.RUNNER_TEMP;
ok(temp);
equal(process.platform, "win32");
equal(process.arch, "x64");
const cwd = join(temp, "hub-acl-proof");
const env: NodeJS.ProcessEnv = { ...process.env, KOFFI_ACL_FIXTURE: cwd };
for (const key of ["NODE_PATH", "NODE_OPTIONS", "UV_THREADPOOL_SIZE"])
  delete env[key];
const options = { encoding: "utf8", env, timeout: 20_000 } as const;
const powershell = join(
  env.SystemRoot ?? "C:/Windows",
  "System32/WindowsPowerShell/v1.0/powershell.exe",
);
if (process.argv[2] === "inventory") {
  const [packed] = JSON.parse(
    readFileSync(join(cwd, "inventory.json"), "utf8"),
  ) as [{ name: string; files: { path: string }[] }];
  equal(packed.name, "forge-hub");
  const paths = packed.files.map(({ path }) => "/" + path);
  for (const file of [
    "koffi/package.json",
    "koffi/LICENSE.txt",
    `${nativeName}/package.json`,
    `${nativeName}/${binaryName}`,
  ])
    ok(
      paths.some((path) => path.endsWith("/node_modules/" + file)),
      `Hub tarball must bundle ${file}`,
    );
  process.exit(0);
}

const fixture = join(cwd, "fixture.txt");
writeFileSync(fixture, "ACL proof\n");
const offline = join(cwd, "offline");
const normal = join(cwd, "normal");
for (const consumer of [offline, normal]) {
  const installed = join(consumer, "node_modules/forge-hub");
  for (const name of ["koffi", nativeName]) {
    const paths = globSync(`**/node_modules/${name}/package.json`, {
      cwd: installed,
    });
    equal(paths.length, 1, `installed ${name}`);
    const metadata = JSON.parse(
      readFileSync(join(installed, paths[0]!), "utf8"),
    ) as { version: string };
    equal(metadata.version, "3.3.3");
  }
  equal(globSync("**/CMakeCache.txt", { cwd: installed }).length, 0);
}

const node = [process.execPath, "--expose-gc"] as const;
const bun = ["bun.exe"] as const;
const runtimes = Object.entries({ Node: node, Bun: bun });
const loadFixture = fileURLToPath(
  new URL("./koffi-load.fixture.ts", import.meta.url),
);
const deadlineFixture = fileURLToPath(
  new URL("./koffi-deadline.fixture.ts", import.meta.url),
);
async function run(
  [exe, ...args]: readonly [string, ...string[]],
  command: string[],
  where = offline,
) {
  const start = Date.now();
  const { stdout, stderr } = await exec(exe, [...args, ...command], {
    ...options,
    cwd: where,
  });
  equal(stderr, "");
  const ended = Date.now();
  return { stdout, elapsed: ended - start, ended };
}

const failures: Error[] = [];
const summary: string[] = [];
function collect(label: string, probe: () => Promise<void>) {
  return probe().catch((error: unknown) => {
    failures.push(new Error(label, { cause: error }));
  });
}

const broken = join(cwd, "missing-native");
cpSync(offline, broken, { recursive: true });
const [binary, ...extra] = globSync(`**/${binaryName}`, { cwd: broken });
ok(binary && !extra.length);
rmSync(join(broken, binary));

for (const [label, runtime] of runtimes) {
  const command = [loadFixture, "load", cwd];
  for (const consumer of [offline, normal]) {
    const name = `${label} ${basename(consumer)}`;
    await collect(name, async () => {
      const { stdout, elapsed } = await run(runtime, command, consumer);
      match(stdout, /^load, Win32 calls and GC \d+(?:\.\d+)? ms$/m);
      console.log(`${name}: exit 0 in ${elapsed} ms\n${stdout}`);
    });
  }
  await collect(`${label} missing .node`, async () => {
    await rejects(run(runtime, command, broken), {
      code: 1,
      stderr:
        /Cannot find the native Koffi module|Cannot find module .*koffi\.node/,
    });
    console.log(`${label} missing .node: refused`);
  });
}

const cold = [
  ...runtimes.map(
    ([label, runtime]) => [label, runtime, [loadFixture, "cold", cwd]] as const,
  ),
  [
    "PowerShell",
    [powershell, "-NoProfile", "-NonInteractive", "-Command"],
    [
      "$ErrorActionPreference = 'Stop'; Get-Acl -LiteralPath $env:KOFFI_ACL_FIXTURE | Out-Null",
    ],
  ] as const,
];
const trials = Array.from({ length: 20 * cold.length }).keys();
console.log(`Cold start concurrency: ${availableParallelism()}`);
await Promise.all([
  ...Array.from({ length: availableParallelism() }, async () => {
    for (const index of trials) {
      const [label, runtime, command] = cold[index % cold.length]!;
      const sample = `${label} cold sample ${Math.floor(index / cold.length) + 1}`;
      await collect(sample, async () => {
        const { elapsed } = await run(runtime, [...command]);
        console.log(`${sample}: ${elapsed} ms`);
      });
    }
  }),
  ...runtimes.flatMap(([label, runtime]) =>
    ["pool", "worker", "unref"].map((probe) =>
      collect(`${label} ${probe}`, async () => {
        const { stdout, elapsed, ended } = await run(runtime, [
          deadlineFixture,
          probe,
          fixture,
        ]);
        console.log(`${label} ${probe}: process exit ${elapsed} ms\n${stdout}`);
        if (probe === "unref") {
          const marker = /^UNREF (\d+) after (250) ms$/m.exec(stdout);
          ok(marker, "Missing native-entry verdict");
          const shutdown = ended - Number(marker[1]);
          ok(shutdown >= 0 && shutdown <= elapsed);
          summary.push(
            `MEASURED (c) ${label}: exit ${shutdown} ms after unref, ${marker[2]} ms native-entry dwell, 5000 ms limit: ${shutdown <= 5_000 ? "FEASIBLE" : "NOT FEASIBLE"}`,
          );
        } else if (probe === "worker") {
          const verdicts = [
            ...stdout.matchAll(
              /^MEASURED \(([abd])\) (\d+(?:\.\d+)? ms(?:, bound 5050 ms)?: PASSED)$/gm,
            ),
          ];
          equal(
            verdicts.map((v) => v[1]).join(""),
            "abd",
            "Missing worker verdicts",
          );
          ok(verdicts[1]?.[2]?.includes("bound 5050 ms"));
          summary.push(
            ...verdicts.map((v) => `MEASURED (${v[1]}) ${label}: ${v[2]}`),
          );
        } else match(stdout, /^MEASURED pool: PASSED$/m);
      }),
    ),
  ),
]);
console.log(`Feasibility summary\n${summary.sort().join("\n")}`);
if (failures.length)
  throw new AggregateError(failures, "Windows ACL proof malfunction");
