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

for (const suite of ["integration", "integration-rest"] as const)
  for (const failing of ["packed", "serial", "neither"] as const) {
    test(`${suite} preserves selected files and the ${failing} outcome`, () => {
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
          // Bun treats bare file arguments as filters and would also discover this shadow.
          const shadow = join(
            work,
            "tmp",
            "test",
            path.slice(join(work, "test").length + 1),
          );
          mkdirSync(dirname(shadow), { recursive: true });
          writeFileSync(
            shadow,
            'throw new Error("unselected shadow test ran");',
          );
        }
        const result = spawnSync(
          process.execPath,
          ["tools/test-suite.ts", suite, "--timeout", "5000"],
          {
            cwd: work,
            encoding: "utf8",
            windowsHide: true,
            timeout: 15000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(
          failing === "serial" ||
            (failing === "packed" && suite === "integration")
            ? 1
            : 0,
        );
        for (const lane of ["packed", "serial"])
          expect(existsSync(join(work, `${lane}.collected`))).toBe(
            lane !== failing && (suite === "integration" || lane !== "packed"),
          );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }, 20000);
  }
