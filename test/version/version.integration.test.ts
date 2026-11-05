import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { version } from "../../src/index.ts";

const root = new URL("../../", import.meta.url);

test("the library exports the package.json version", () => {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  expect(version).toBe((pkg as { version: string }).version);
}, 10_000);

test("the command bin prints the version, discovers its catalog and refuses unknown commands", () => {
  const bin = fileURLToPath(new URL("bin/forge.ts", root));
  const ok = Bun.spawnSync([process.execPath, bin, "--version"]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString().trim()).toBe(version);
  for (const args of [[], ["--help"]]) {
    const help = Bun.spawnSync([process.execPath, bin, ...args]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toStartWith("Usage: forge");
    expect(help.stderr.toString()).not.toContain("Store filesystem warning");
  }
  const bad = Bun.spawnSync([process.execPath, bin, "unknown-command"]);
  expect(bad.exitCode).toBe(3);
  expect(JSON.parse(bad.stdout.toString())).toMatchObject({
    ok: false,
    error: { code: "UNKNOWN_COMMAND" },
  });
}, 30_000);
