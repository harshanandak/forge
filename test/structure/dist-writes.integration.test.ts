import { expect, test } from "bun:test";
import { findSharedDistWrites } from "./lib/dist-writes.ts";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("no integration test writes under or rebuilds the shared dist/", () => {
  const files = readRepoFiles(
    listRepoFiles().filter((path) => path.endsWith(".integration.test.ts")),
  );
  expect(format(findSharedDistWrites(files))).toEqual([]);
}, 30_000);

const check = (text: string): number =>
  findSharedDistWrites([{ path: "test/a.integration.test.ts", text }]).length;

test("the guard rejects writes that reach the repo's dist/", () => {
  const root = 'const root = resolve(import.meta.dirname, "../../..");\n';
  expect(
    check(
      `${root}const target = join(root, "dist/src/a.js");\nwriteFileSync(target, "x");\n`,
    ),
  ).toBe(1);
  expect(
    check(`${root}rmSync(join(root, "dist"), { recursive: true });\n`),
  ).toBe(1);
  expect(
    check(
      'const built = resolve(import.meta.dirname, "../../dist");\nconst file = join(built, "a.js");\nappendFileSync(file, "x");\n',
    ),
  ).toBe(1);
  expect(
    check(`${root}cpSync(join(tmp, "a.js"), join(root, "dist/a.js"));\n`),
  ).toBe(1);
  expect(
    check('spawnSync(process.execPath, ["run", "build"], { cwd: root });\n'),
  ).toBe(1);
}, 30_000);

test("the guard accepts reading dist/ and mutating a private copy", () => {
  expect(
    check(
      'const root = resolve(import.meta.dirname, "../../..");\nconst copy = mkdtempSync(join(tmpdir(), "x-"));\ncpSync(join(root, "dist"), join(copy, "dist"), { recursive: true });\nconst target = join(copy, "dist/src/a.js");\nwriteFileSync(target, readFileSync(join(root, "dist/src/a.js"), "utf8"));\n',
    ),
  ).toBe(0);
  expect(check('// writeFileSync(join(root, "dist/a.js"), "x");\n')).toBe(0);
}, 30_000);
