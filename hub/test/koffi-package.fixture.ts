import { equal, match, ok } from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cpSync,
  existsSync,
  globSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const options = {
  encoding: "utf8",
  env,
  timeout: 60_000,
  maxBuffer: 4 * 1024 * 1024,
} as const;
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
const loadFixture = fileURLToPath(
  new URL("./koffi-load.fixture.ts", import.meta.url),
);
const deadlineFixture = fileURLToPath(
  new URL("./koffi-deadline.fixture.ts", import.meta.url),
);
async function run(
  [exe, ...args]: readonly string[],
  script: string,
  mode: string,
  where: string,
  path = cwd,
) {
  const start = Date.now();
  const { stdout, stderr } = await exec(exe!, [...args, script, mode, path], {
    ...options,
    cwd: where,
    timeout: 20_000,
  });
  equal(stderr, "");
  return { stdout, elapsed: Date.now() - start, ended: Date.now() };
}

for (const [label, runtime] of Object.entries({ Node: node, Bun: bun })) {
  for (const consumer of [offline, normal]) {
    const result = await run(runtime, loadFixture, "load", consumer);
    console.log(
      `${label} ${basename(consumer)}: exit 0 in ${result.elapsed} ms\n${result.stdout}`,
    );
  }
}
const broken = join(cwd, "missing-native");
cpSync(offline, broken, { recursive: true });
const [binary, ...extra] = globSync(`**/${binaryName}`, { cwd: broken });
ok(binary && !extra.length && existsSync(join(broken, binary)));
rmSync(join(broken, binary));
for (const runtime of [node, bun]) {
  const result = await exec(
    runtime[0],
    [...runtime.slice(1), loadFixture, "load", cwd],
    { ...options, cwd: broken },
  ).then(
    () => undefined,
    (error: unknown) => error as { code?: unknown; stderr?: string },
  );
  equal(result?.code, 1);
  match(
    result.stderr ?? "",
    /Cannot find the native Koffi module|Cannot find module .*koffi\.node/,
  );
  console.log(`${basename(runtime[0])} missing .node: refused`);
}

const runtimes = Object.entries({ Node: node, Bun: bun });
const samples = Array.from({ length: 20 }, () => [
  ...runtimes.map(([label, runtime]) => async () => {
    const { elapsed } = await run(runtime, loadFixture, "cold", offline);
    return [label, elapsed] as const;
  }),
  async () => {
    const start = performance.now();
    await exec(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Get-Acl -LiteralPath $env:KOFFI_ACL_FIXTURE | Out-Null",
      ],
      options,
    );
    return ["PowerShell", Math.round(performance.now() - start)] as const;
  },
])
  .flat()
  .entries();
console.log(`Cold start concurrency: ${availableParallelism()}`);
await Promise.all([
  ...Array.from({ length: availableParallelism() }, async () => {
    for (const [index, sample] of samples) {
      const [label, elapsed] = await sample();
      console.log(
        `${label} cold sample ${Math.floor(index / 3) + 1}: ${elapsed} ms`,
      );
    }
  }),
  ...runtimes.flatMap(([label, runtime]) =>
    ["pool", "worker", "unref"].map(async (probe) => {
      try {
        const { stdout, elapsed, ended } = await run(
          runtime,
          deadlineFixture,
          probe,
          offline,
          fixture,
        );
        const unref = /\(c\) unref while blocked (\d+)/.exec(stdout);
        console.log(`${label} ${probe}: process exit ${elapsed} ms\n${stdout}`);
        if (probe === "unref") {
          ok(unref?.[1]);
          const shutdown = ended - Number(unref[1]);
          console.log(
            `${label} (c) ${shutdown < 5_000 ? "passed" : "failed"}: unref to exit ${shutdown} ms`,
          );
        }
      } catch (error) {
        const failure = error as { message: string; stdout?: string };
        console.log(
          `${label} ${probe}: failed\n${failure.stdout ?? ""}${failure.message}`,
        );
      }
    }),
  ),
]);
