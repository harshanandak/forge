import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
    for (const name of ["journey", "writer"])
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
    const installed = join(consumer, "node_modules/forge-workflow/dist");
    const mutations = [
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
        to: "expectRevision: client.get(key)?.revision ?? 0",
        mode,
        evidence: mode === "race" ? "one writer wins" : "semver mark 1.6.0 0",
      })),
    ];
    for (const mutation of mutations) {
      const path = join(installed, mutation.file);
      const original = readFileSync(path, "utf8");
      expect(original).toContain(mutation.from);
      try {
        writeFileSync(path, original.replaceAll(mutation.from, mutation.to));
        const result = spawnSync(
          node,
          [join(consumer, "journey.mjs"), mutation.mode],
          {
            cwd: consumer,
            env,
            encoding: "utf8",
            windowsHide: true,
            timeout: 45000,
          },
        );
        expect(result.status).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          mutation.evidence,
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
