"use strict";

// forge-test-resource: exclusive

const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const created = [];
const OUTPUT_LIMIT = 2000;

function runOperation(label, command, args, options) {
  console.error(`[standalone-package] ${label}: start`);
  const started = Date.now();
  const result = spawnSync(command, args, options);
  const diagnostic = {
    label,
    elapsedMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    error: result.error ? { code: result.error.code, message: result.error.message } : null,
    stdout: String(result.stdout || "").slice(-OUTPUT_LIMIT),
    stderr: String(result.stderr || "").slice(-OUTPUT_LIMIT),
  };
  result.diagnostic = diagnostic;
  console.error(`[standalone-package] ${JSON.stringify(diagnostic)}`);
  return result;
}

function npm(args, cwd, invocation, label) {
  return runOperation(label, invocation.command, [...invocation.prefix, ...args], {
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
  const packageName = path.basename(packageDirectory) || "root";
  const result = npm(["pack", "--json", "--ignore-scripts", "--pack-destination", destination], packageDirectory, invocation, `pack:${packageName}`);
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
      const locator = process.platform === "win32" ? "where.exe" : "which";
      const located = path.isAbsolute(executable)
        ? executable
        : spawnSync(locator, [executable], { encoding: "utf8" }).stdout.trim().split(/\r?\n/)[0];
      return { executable: fs.realpathSync.native(located), version };
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

function isolatedEnvironment(root, platformNode) {
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, ".codex"),
    XDG_CONFIG_HOME: path.join(root, ".config"),
    APPDATA: path.join(root, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(root, "AppData", "Local"),
  };
  for (const directory of [env.HOME, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.APPDATA, env.LOCALAPPDATA]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = [path.dirname(platformNode.executable), env[pathKey]].filter(Boolean).join(path.delimiter);
  return env;
}

function runInstalledForge(packageRoot, args, cwd, platformNode, env, label) {
  const shim = path.join(packageRoot, "node_modules", ".bin", process.platform === "win32" ? "forge.cmd" : "forge");
  if (process.platform !== "win32") return runOperation(label, shim, args, { cwd, encoding: "utf8", env });
  const command = `""${shim}" ${args.join(" ")}"`;
  return runOperation(label, process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", command], {
    cwd,
    encoding: "utf8",
    env,
    windowsVerbatimArguments: true,
  });
}

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("standalone product packages", () => {
  test("bounds child operations before the test deadline and preserves diagnostics", () => {
    const timedOut = runOperation("test:timeout", process.execPath, ["-e", "setTimeout(() => {}, 250)"], {
      encoding: "utf8",
      timeout: 50,
    });
    expect(timedOut.status).toBeNull();
    expect(timedOut.error?.code).toBe("ETIMEDOUT");
    expect(timedOut.diagnostic.stdout.length).toBeLessThanOrEqual(OUTPUT_LIMIT);

    const nonzero = runOperation("test:nonzero", process.execPath, ["-e", `process.stdout.write("x".repeat(${OUTPUT_LIMIT + 100})); process.stderr.write("failed"); process.exit(7)`], {
      encoding: "utf8",
      timeout: 2000,
    });
    expect(nonzero.status).toBe(7);
    expect(nonzero.diagnostic.stdout).toHaveLength(OUTPUT_LIMIT);
    expect(nonzero.diagnostic.stderr).toBe("failed");
  }, 3000);

  test("parses npm 10 JSON after package lifecycle output", () => {
    expect(parsePackOutput('sync hooks: ok\n[{"filename":"forge.tgz"}]\n')[0].filename).toBe("forge.tgz");
  });

  test("root prepare skips package packing and retains development hook setup", () => {
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge prepare-"));
    created.push(temporary);
    const sentinel = path.join(temporary, "lefthook-called");
    const mock = path.join(temporary, process.platform === "win32" ? "lefthook.cmd" : "lefthook");
    fs.writeFileSync(mock, process.platform === "win32"
      ? '@echo off\r\n>"%FORGE_PREPARE_SENTINEL%" echo called\r\n'
      : '#!/bin/sh\nprintf called > "$FORGE_PREPARE_SENTINEL"\n');
    if (process.platform !== "win32") fs.chmodSync(mock, 0o755);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
    const runPrepare = (npmCommand) => spawnSync(manifest.scripts.prepare, {
      cwd: ROOT,
      encoding: "utf8",
      shell: true,
      env: {
        ...process.env,
        [pathKey]: [temporary, process.env[pathKey]].filter(Boolean).join(path.delimiter),
        FORGE_PREPARE_SENTINEL: sentinel,
        npm_command: npmCommand,
      },
    });

    const development = runPrepare("install");
    expect(development.status, development.stderr).toBe(0);
    expect(fs.existsSync(sentinel)).toBeTrue();
    fs.rmSync(sentinel);

    const packing = runPrepare("pack");
    expect(packing.status, packing.stderr).toBe(0);
    expect(fs.existsSync(sentinel)).toBeFalse();
  });

  test("exact version aliases exit before loading the command graph", () => {
    const platformNode = resolvePlatformNode();
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge version-"));
    created.push(temporary);
    const guard = path.join(temporary, "reject-lib-load.cjs");
    fs.writeFileSync(guard, `
const Module = require("node:module");
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (String(request).startsWith("../lib/")) throw new Error("version loaded " + request);
  return load.call(this, request, parent, isMain);
};
`);
    const expected = `Forge v${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}\n`;

    for (const alias of ["--version", "-V"]) {
      const result = spawnSync(platformNode.executable, ["--require", guard, path.join(ROOT, "bin", "forge.js"), alias], {
        cwd: ROOT,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(expected);
    }
  });

  test("packs and installs the root CLI with its runtime workspaces", () => {
    const platformNode = resolvePlatformNode();
    const npmInvocation = resolveNpmInvocation(platformNode);
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge root-"));
    created.push(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    const env = isolatedEnvironment(path.join(temporary, "home"), platformNode);
    const rootTarball = pack(ROOT, temporary, npmInvocation);

    const install = npm(["install", "--ignore-scripts", rootTarball], temporary, npmInvocation, "install:root");
    expect(install.status, install.stderr).toBe(0);

    const version = runInstalledForge(temporary, ["--version"], temporary, platformNode, env, "cli:version");
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout).toContain("Forge v");

    const project = path.join(temporary, "project");
    fs.mkdirSync(project);
    const init = spawnSync("git", ["init", "-q"], { cwd: project, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    const setup = runInstalledForge(temporary, ["setup", "--quick", "--yes"], project, platformNode, env, "cli:setup");
    expect(setup.status, `${setup.stdout}\n${setup.stderr}`).toBe(0);
  }, 60000);

  test("packs and installs Flow with public Forge contracts in a fresh package", () => {
    const platformNode = resolvePlatformNode();
    const npmInvocation = resolveNpmInvocation(platformNode);
    const temporary = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "forge products-"));
    created.push(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    const contractsTarball = pack(path.join(ROOT, "packages", "contracts"), temporary, npmInvocation);
    const memoryTarball = pack(path.join(ROOT, "packages", "memory"), temporary, npmInvocation);
    const flowTarball = pack(path.join(ROOT, "packages", "flow"), temporary, npmInvocation);

    const install = npm(["install", "--ignore-scripts", contractsTarball, memoryTarball, flowTarball], temporary, npmInvocation, "install:products");
    expect(install.status, install.stderr).toBe(0);

    for (const [packageName, directory] of [["contracts", "packages/contracts"], ["memory", "packages/memory"], ["flow", "packages/flow"]]) {
      const manifest = JSON.parse(fs.readFileSync(path.join(temporary, "node_modules", "@forge", packageName, "package.json"), "utf8"));
      expect(manifest.license).toBe("MIT");
      expect(manifest.repository).toEqual({
        type: "git",
        url: "git+https://github.com/harshanandak/forge.git",
        directory,
      });
      expect(manifest.publishConfig).toEqual({ access: "public" });
    }

    expect(platformNode.version.major).toBeGreaterThanOrEqual(22);
    expect(platformNode.version.major > 22 || platformNode.version.minor >= 16).toBe(true);
    expect(path.basename(platformNode.executable).toLowerCase()).not.toContain("bun");

    const probe = spawnSync(platformNode.executable, ["-e", "require('@forge/contracts'); require('@forge/memory'); require('@forge/flow')"], {
      cwd: temporary,
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
  }, 30000);
});
