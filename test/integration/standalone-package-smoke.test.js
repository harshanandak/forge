"use strict";

const { afterEach, describe, expect, test } = require("bun:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "../..");
const created = [];

function npm(args, cwd) {
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
}

function pack(packageDirectory, destination) {
  const result = npm(["pack", "--json", "--pack-destination", destination], packageDirectory);
  expect(result.status, result.stderr).toBe(0);
  return path.join(destination, JSON.parse(result.stdout)[0].filename);
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

afterEach(() => {
  for (const directory of created.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("standalone product packages", () => {
  test("packs and installs Flow with public Memory contracts in a fresh package", () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "forge-products-"));
    created.push(temporary);
    fs.writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ private: true }));
    const contractsTarball = pack(path.join(ROOT, "packages", "memory-contracts"), temporary);
    const flowTarball = pack(path.join(ROOT, "packages", "flow"), temporary);

    const install = npm(["install", "--ignore-scripts", contractsTarball, flowTarball], temporary);
    expect(install.status, install.stderr).toBe(0);

    const platformNode = resolvePlatformNode();
    expect(platformNode.version.major).toBeGreaterThanOrEqual(22);
    expect(platformNode.version.major > 22 || platformNode.version.minor >= 16).toBe(true);
    expect(path.basename(platformNode.executable).toLowerCase()).not.toContain("bun");

    const probe = spawnSync(platformNode.executable, ["-e", "require('@forge/memory-contracts'); require('@forge/flow')"], {
      cwd: temporary,
      encoding: "utf8",
    });
    expect(probe.status, probe.stderr).toBe(0);
  }, 30000);
});
