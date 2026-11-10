import { expect, test } from "bun:test";
import { readJson } from "./lib/repo.ts";

test("team has a separate build entry without changing the public roots", () => {
  const pkg = readJson("package.json") as { scripts: Record<string, string> };
  expect(pkg.scripts.build).toBe("tsc -p tsconfig.build.json");
  expect(pkg.scripts["build:team"]).toBeString();
  expect(readJson("tsconfig.build.json")).toHaveProperty("include", [
    "bin",
    "src",
  ]);
  expect(readJson("tsconfig.team.json")).toEqual({
    extends: "./tsconfig.build.json",
    compilerOptions: { outDir: "dist-team", rootDir: "team", paths: {} },
    include: ["team"],
    exclude: ["**/*.test.ts", "**/test/**"],
  });
}, 30_000);
