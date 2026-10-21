import { expect, test } from "bun:test";
import {
  findBuildDependentSkips,
  findUnbuiltIntegrationLane,
} from "./lib/build-skip.ts";
import {
  format,
  listRepoFiles,
  readJson,
  readRepoFiles,
  TEST_FILE,
} from "./lib/repo.ts";

test("no test silently skips because the build is missing", () => {
  const files = readRepoFiles(
    listRepoFiles().filter((path) => TEST_FILE.test(path)),
  );
  expect(format(findBuildDependentSkips(files))).toEqual([]);
}, 30_000);

test("the integration lane builds before any test is discovered", () => {
  const { scripts } = readJson("package.json") as {
    scripts: Record<string, string>;
  };
  expect(format(findUnbuiltIntegrationLane(scripts))).toEqual([]);
}, 30_000);

const check = (text: string): number =>
  findBuildDependentSkips([{ path: "test/a.integration.test.ts", text }])
    .length;

test("the guard rejects a skip decided by a build probe or CI", () => {
  expect(
    check(
      "const missing = !existsSync(built) && !process.env.CI;\nconst builtTest = missing ? test.skip : test;\n",
    ),
  ).toBe(1);
  expect(
    check(
      'const built = existsSync("dist/x.js");\nconst gone = !built;\nconst t = gone ? test.skip : test;\n',
    ),
  ).toBe(1);
  expect(
    check('test.skipIf(!existsSync("dist/bin/forge.js"))("a", () => {});\n'),
  ).toBe(1);
  expect(check('describe.skipIf(!process.env.CI)("a", () => {});\n')).toBe(1);
}, 30_000);

test("the guard accepts platform skips and existence checks that fail", () => {
  expect(
    check('test.skipIf(process.platform !== "win32")("a", () => {});\n'),
  ).toBe(0);
  expect(
    check(
      'const zombie = process.platform === "win32" ? test.skip : test;\nif (!existsSync(x)) throw new Error("build");\n',
    ),
  ).toBe(0);
  expect(
    findUnbuiltIntegrationLane({
      "test:integration": "bun test --parallel .integration.test",
    }),
  ).toHaveLength(1);
  expect(
    findUnbuiltIntegrationLane({
      "test:integration":
        "bun run build && bun test --parallel .integration.test",
    }),
  ).toEqual([]);
}, 30_000);
