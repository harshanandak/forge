import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

for (const runtime of [process.execPath, Bun.which("node")!]) {
  for (const method of [
    ...["exec", "run", "get", "all", "transaction"].flatMap((method) => [
      `${method}:gap`,
      `${method}:queued`,
    ]),
    "forced",
  ]) {
    test(`integration: restore/writer invariant (${runtime}, ${method})`, () => {
      const result = spawnSync(
        runtime,
        [
          join(
            import.meta.dirname,
            "../../node-fixtures/state/restore-writer.mjs",
          ),
          method,
        ],
        {
          encoding: "utf8",
          windowsHide: true,
          timeout: 20000,
        },
      );
      expect(`${result.stdout}\n${result.stderr}`).toContain(`PASS ${method}`);
      expect(result.status).toBe(0);
    }, 30000);
  }
}
