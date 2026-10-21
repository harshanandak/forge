import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import {
  environmentWithoutBun,
  resolveBun,
} from "../../../tools/pack-smoke/environment.ts";

test("the absolute Bun runner starts with a Bun-free consumer environment", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-pack-env-"));
  try {
    const bun = join(folder, process.platform === "win32" ? "bun.exe" : "bun");
    symlinkSync(process.execPath, bun, "file");
    const original = { Path: `${folder}${delimiter}`, BUN_INSTALL: folder };
    const runner = resolveBun(original);
    expect(runner).toBe(bun);
    const nodeDirectory = join(folder, "node-only");
    const node = Bun.which("node");
    if (node === null)
      throw new Error("Node is required for the consumer environment");
    const env = environmentWithoutBun(nodeDirectory, node, original);
    expect(env.Path).toBe(nodeDirectory);
    expect(env.BUN_INSTALL).toBeUndefined();
    expect(original.BUN_INSTALL).toBe(folder);
    const result = spawnSync(
      runner,
      [
        "-e",
        "console.log(JSON.stringify({path:process.env.Path ?? process.env.PATH, install:process.env.BUN_INSTALL ?? null}))",
      ],
      { env, encoding: "utf8", timeout: 10000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      path: nodeDirectory,
      install: null,
    });
    expect(resolveBun({ ...original, npm_execpath: bun })).toBe(bun);
    expect(
      resolveBun({ ...original, npm_execpath: join(folder, "missing", "bun") }),
    ).toBe(bun);
    expect(() => resolveBun({ PATH: "" })).toThrow(
      "bun is not resolvable on PATH",
    );
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);

test("colocated Node and Bun leave node and npm exec working without exposing Bun", () => {
  const folder = mkdtempSync(join(tmpdir(), "forge-colocated-env-"));
  const node = Bun.which("node");
  if (node === null)
    throw new Error("Node is required for the consumer environment");
  const npmCli = [
    join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
    join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
  ].find(existsSync);
  if (npmCli === undefined)
    throw new Error("npm is required for the consumer environment");
  const run = (command: string, args: string[], env: NodeJS.ProcessEnv) => {
    const result = spawnSync(command, args, {
      cwd: folder,
      env,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    return result.stdout.trim();
  };
  try {
    const colocated = join(folder, "tools");
    mkdirSync(colocated);
    const nodeName = process.platform === "win32" ? "node.exe" : "node";
    const colocatedNode = join(colocated, nodeName);
    copyFileSync(node, colocatedNode);
    symlinkSync(
      process.execPath,
      join(colocated, process.platform === "win32" ? "bun.exe" : "bun"),
      "file",
    );
    const key =
      Object.keys(process.env).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    const system =
      process.platform === "win32"
        ? join(process.env.SystemRoot!, "System32")
        : join(folder, "system");
    if (process.platform !== "win32") {
      mkdirSync(system);
      symlinkSync("/bin/sh", join(system, "sh"));
    }
    const original = {
      ...process.env,
      [key]: `${colocated}${delimiter}${system}`,
      BUN_INSTALL: colocated,
    };
    const nodeDirectory = join(folder, "node-only");
    const env = environmentWithoutBun(nodeDirectory, colocatedNode, original);
    const consumerNode = join(nodeDirectory, nodeName);
    const modules = join(folder, "node_modules");
    const fixture = join(modules, "smoke-bin");
    const bins = join(modules, ".bin");
    mkdirSync(fixture, { recursive: true });
    mkdirSync(bins);
    writeFileSync(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "smoke-bin",
        version: "1.0.0",
        bin: { "smoke-bin": "cli.cjs" },
      }),
    );
    writeFileSync(
      join(fixture, "cli.cjs"),
      `#!/usr/bin/env node
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
assert.equal(process.versions.bun, undefined);
assert.equal(process.env.BUN_INSTALL, undefined);
const node = spawnSync('node', ['-p', 'process.versions.bun === undefined'], {encoding:'utf8'});
assert.equal(node.status, 0);
assert.equal(node.stdout.trim(), 'true');
assert.ok(spawnSync('bun', ['--version']).error, 'Bun must stay unavailable');
console.log('consumer on Node');
`,
    );
    writeFileSync(
      join(folder, "package.json"),
      JSON.stringify({ name: "consumer", version: "1.0.0", private: true }),
    );
    // Use the local-bin layout npm exec consumes; no registry or install is needed.
    if (process.platform === "win32")
      writeFileSync(
        join(bins, "smoke-bin.cmd"),
        '@node "%~dp0\\..\\smoke-bin\\cli.cjs" %*\r\n',
      );
    else {
      chmodSync(join(fixture, "cli.cjs"), 0o755);
      symlinkSync(join(fixture, "cli.cjs"), join(bins, "smoke-bin"));
    }
    expect(
      run(consumerNode, [npmCli, "exec", "--no", "--", "smoke-bin"], env),
    ).toBe("consumer on Node");
    expect(env[key]).not.toContain(colocated);
    expect(original.BUN_INSTALL).toBe(colocated);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);
