import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

for (const failing of ["packed", "serial", "neither"] as const) {
  test(`integration runner collects both processes when ${failing} fails`, () => {
    const work = mkdtempSync(join(tmpdir(), "forge-suite-outcomes-"));
    try {
      mkdirSync(join(work, "tools"));
      cpSync(
        resolve(import.meta.dirname, "../../../tools/test-suite.ts"),
        join(work, "tools/test-suite.ts"),
      );
      for (const lane of ["packed", "serial"] as const) {
        const path = join(
          work,
          "test",
          lane === "packed"
            ? "node-fixtures/state/packed.integration.test.ts"
            : "other.integration.test.ts",
        );
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(
          path,
          `import { test, expect } from "bun:test";
test("${lane}", async () => {
  ${failing === lane ? "expect(true).toBe(false);" : `await Bun.sleep(100); await Bun.write(${JSON.stringify(join(work, `${lane}.collected`))}, "finished");`}
}, 5000);
`,
        );
      }
      const result = spawnSync(
        process.execPath,
        ["tools/test-suite.ts", "integration", "--timeout", "5000"],
        {
          cwd: work,
          encoding: "utf8",
          windowsHide: true,
          timeout: 15000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(failing === "neither" ? 0 : 1);
      for (const lane of ["packed", "serial"])
        if (lane !== failing)
          expect(existsSync(join(work, `${lane}.collected`))).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 20000);
}
