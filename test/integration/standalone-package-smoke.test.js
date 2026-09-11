"use strict";

// forge-test-resource: exclusive

const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const created = [];

function npm(args, cwd, invocation) {
  return spawnSync(invocation.command, [...invocation.prefix, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
}

function parsePackOutput(output) {
  const jsonStart = String(output).search(/^\[/m);
  if (jsonStart === -1) throw new SyntaxError("npm pack did not return a JSON payload");
  return JSON.parse(output.slice(jsonStart));
}

function pack(packageDirectory, destination, invocation) {
  const result = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], packageDirectory, invocation);
  expect(result.status, result.stderr).toBe(0);
  return path.join(destination, parsePackOutput(result.stdout)[0].filename);
}

function resolvePlatformNode() {
  const candidates = [
    process.env.FORGE_NODE_EXECUTABLE,
    process.platform === "win32" ? "node.exe" : "node",
  ].filter(Boolean);
  for (const executable of candidates) {
    const probe = spawnSync(executable, ["--version"], { encoding: "utf8" });
    const match = probe.status === 0 && probe.stdout.trim().match(/^v(\d+)\.(\d+)\.(\d+)$/);
    if (!match) continue;
    const version = { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
    if (version.major > 22 || (version.major === 22 && version.minor >= 16)) {
      return { executable, version };
    }
  }
  throw new Error("Node.js >=22.16.0 is required for the standalone package smoke test");
}

function resolveNpmInvocation(platformNode) {
  if (process.platform !== "win32") return { command: "npm", prefix: [] };
  const located = spawnSync("where.exe", ["npm.cmd"], { encoding: "utf8" });
  for (const shim of located.status === 0 ? located.stdout.trim().split(/\r?\n/) : []) {
    const cli = path.join(path.dirname(shim), "node_modules", "npm", "bin", "npm-cli.js");
    if (fs.existsSync(cli)) return { command: platformNode.executable, prefix: [cli] };
  }
  throw new Error("Could not resolve npm-cli.js beside the platform Node.js installation");
}

function runInstalledForge(packageRoot, args, cwd) {
  const shim = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "forge.cmd" : "forge");
  if (process.platform !== "win32") return spawnSync(shim, args, { cwd, encoding: "utf8" });
  const command = `""${shim}" ${args.join(" ")}"`;
  return spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    cwd,
    encoding: "utf8",
    windowsVerbatimArguments: true,
  });
}

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("standalone product packages", () => {
  test("parses npm 10 JSON after package lifecycle output", () => {
    expect(parsePackOutput('sync hooks: ok\n[{"filename":"forge.tgz"}]\n')[0].filename).toBe("forge.tgz");
  });

  test("packs and installs the root CLI with its runtime workspaces", () => {
    const platformNode = resolvePlatformNode();
    const npmInvocation = resolveNpmInvocation(platformNode);
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge root-"));
    created.push(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    const rootTarball = pack(ROOT, temporary, npmInvocation);

    const install = npm(["install", "--ignore-scripts", rootTarball], temporary, npmInvocation);
    expect(install.status, install.stderr).toBe(0);

    const version = runInstalledForge(temporary, ["--version"], temporary);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain("Forge v");

    const project = path.join(temporary, "project");
    fs.mkdirSync(project);
    const init = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const setup = runInstalledForge(temporary, ["setup", "--quick", "--yes"], project);
    expect(setup.status, setup.stderr).toBe(0);
  }, 60000);

  test("packs and installs Flow with public Memory contracts in a fresh package", () => {
    const platformNode = resolvePlatformNode();
    const npmInvocation = resolveNpmInvocation(platformNode);
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge products-"));
    created.push(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    const contractsTarball = pack(path.join(ROOT, "packages", "memory-contracts"), temporary, npmInvocation);
    const memoryTarball = pack(path.join(ROOT, "packages", "memory"), temporary, npmInvocation);
    const flowTarball = pack(path.join(ROOT, "packages", "flow"), temporary, npmInvocation);

    const install = npm(["install", "--ignore-scripts", contractsTarball, memoryTarball, flowTarball], temporary, npmInvocation);
    expect(install.status, install.stderr).toBe(0);

    expect(platformNode.version.major).toBeGreaterThanOrEqual(22);
    expect(platformNode.version.major > 22 || platformNode.version.minor >= 16).toBe(true);
    expect(path.basename(platformNode.executable).toLowerCase()).not.toContain("bun");

    const probe = spawnSync(platformNode.executable, ["-e", "require('@forge/memory-contracts'); require('@forge/memory'); require('@forge/flow')"], {
      cwd: temporary,
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
  }, 30000);
});
