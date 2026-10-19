import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runFixtures } from "../fixtures/run.ts";

test("account scripts prevent ambient PATH Git from receiving the selected credential", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const output = await runFixtures([
    {
      label: "account router executable isolation",
      command: node,
      args: [resolve(import.meta.dirname, "../../node-fixtures/github-accounts/router-path.mjs")],
      cwd: resolve(import.meta.dirname, "../../.."),
      env: process.env,
    },
  ], 1, "Accounts");
  expect(output[0]).toContain("PASS router-path");
}, 90000);
