import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runFixtures } from "../fixtures/run.ts";

test("account guard refuses linked-worktree hook overrides before install and on retry", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const output = await runFixtures(
    [
      {
        label: "account worktree hook isolation",
        command: node,
        args: [
          resolve(
            import.meta.dirname,
            "../../node-fixtures/github-accounts/worktree-hooks.mjs",
          ),
        ],
        cwd: resolve(import.meta.dirname, "../../.."),
        env: process.env,
      },
    ],
    1,
    "Accounts",
  );
  expect(output[0]).toContain("PASS worktree-hooks");
}, 90000);
