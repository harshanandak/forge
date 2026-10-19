import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runFixtures } from "../fixtures/run.ts";

test("account unbinding preserves native config bytes and helper order across includes", async () => {
  const node = Bun.which("node");
  if (!node) throw new Error("Node is required");
  const output = await runFixtures(
    [
      {
        label: "account config restoration",
        command: node,
        args: [
          resolve(
            import.meta.dirname,
            "../../node-fixtures/github-accounts/config-restoration.mjs",
          ),
        ],
        cwd: resolve(import.meta.dirname, "../../.."),
        env: process.env,
      },
    ],
    1,
    "Accounts",
  );
  expect(output[0]).toContain("PASS config-restoration");
}, 90000);
