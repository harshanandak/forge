import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { version } from "../../src/index.ts";

const root = new URL("../../", import.meta.url);

test("the library exports the package.json version", () => {
  const pkg: unknown = JSON.parse(
    readFileSync(new URL("package.json", root), "utf8"),
  );
  expect(version).toBe((pkg as { version: string }).version);
}, 10_000);

test("the stub bin prints the version for --version and fails for anything else", () => {
  const bin = new URL("bin/forge.ts", root).pathname.replace(
    /^\/([A-Za-z]:)/,
    "$1",
  );
  const ok = Bun.spawnSync([process.execPath, bin, "--version"]);
  expect(ok.exitCode).toBe(0);
  expect(ok.stdout.toString().trim()).toBe(version);
  const bad = Bun.spawnSync([process.execPath, bin]);
  expect(bad.exitCode).toBe(2);
}, 30_000);
