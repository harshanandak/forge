/// <reference types="bun" />

import { ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { SECRET_PATTERNS } from "../src/contract/errors.ts";

const timeout = 30_000;
const bin = fileURLToPath(new URL("../bin/forge-hub.mjs", import.meta.url));

function expectEntry(args: string[], status: number, stderr: string): void {
  const result = spawnSync("node", [bin, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HUB_CONFIG: "" },
    windowsHide: true,
    timeout,
  });
  expect(result.status).toBe(status);
  const output = result.stdout + result.stderr;
  ok(
    !SECRET_PATTERNS.some((pattern) => pattern.test(output)),
    "Node entry output matched a secret shape",
  );
  ok(
    result.stdout === "" && result.stderr === stderr,
    "Unexpected Node entry output",
  );
}

test(
  "the built launcher under selected Node prints usage without a secret",
  () => {
    expectEntry([], 2, "usage: forge-hub <command>\n");
  },
  timeout,
);

test(
  "the built launcher reports missing configuration before opening command resources",
  () => {
    for (const args of [
      ["serve"],
      ["token", "create"],
      ["host", "revoke"],
      ["inbox"],
      ["send"],
      ["summary", "post", "--project", "prj_demo"],
    ])
      expectEntry(args, 1, "could not load hub configuration\n");
    expectEntry(["summary", "wrong"], 2, "usage: forge-hub <command>\n");
  },
  timeout,
);
