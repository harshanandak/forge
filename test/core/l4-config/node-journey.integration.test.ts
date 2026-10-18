// Integration (Node subprocess): the published package runs on Node, so the config journey is also
// run under Node itself, over the real file system and the real YAML adapter.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const program = fileURLToPath(
  new URL("../../node-fixtures/config/journey.ts", import.meta.url),
);

test("integration: under Node, the adaptive, set, conflict, revert and template journey holds", () => {
  const run = spawnSync("node", [program], {
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(run.stderr).not.toContain("Error");
  expect(run.status).toBe(0);
  expect(JSON.parse(run.stdout.trim())).toEqual({
    runtime: "node",
    adaptive: { configured: false, instances: 0, values: 4 },
    stale: "REVISION_CONFLICT",
    overridden: ["project", ["project:true", "derived:false"]],
    unknown: "INPUT_INVALID",
    revertedToNothing: true,
    kept: 15,
    left: ["pr"],
    backToAdaptive: true,
  });
}, 90_000);
