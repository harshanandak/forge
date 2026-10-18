import { expect, test } from "bun:test";
import { format, listRepoFiles, readRepoFiles, TEST_FILE } from "./lib/repo.ts";
import { findMissingTimeouts, maskLiterals } from "./lib/timeouts.ts";

test("every test declares an explicit timeout", () => {
  const files = readRepoFiles(listRepoFiles().filter((p) => TEST_FILE.test(p)));
  expect(format(findMissingTimeouts(files))).toEqual([]);
}, 30_000);

const check = (text: string): number =>
  findMissingTimeouts([{ path: "a.test.ts", text }]).length;

test("the guard rejects a test with no timeout, however the call is written", () => {
  expect(check('test("a", () => {\n  expect(1).toBe(1);\n});\n')).toBe(1);
  expect(check('it("a", async () => { await f(1, 2); });\n')).toBe(1);
  expect(check('test.only("a", () => {});\n')).toBe(1);
  expect(check('test.each([1, 2])("a %s", (n) => {});\n')).toBe(1);
  expect(check('test("a", () => {}, );\n')).toBe(1);
  expect(check('test("a", () => {});\ntest("b", () => {}, 5_000);\n')).toBe(1);
}, 30_000);

test("the guard accepts a per-test timeout, an options object and a file default", () => {
  expect(check('test("a", () => {}, 5_000);\n')).toBe(0);
  expect(check('test("a", () => {}, { timeout: 5_000 });\n')).toBe(0);
  expect(check('test.each([1])("a %s", (n) => {}, 5_000);\n')).toBe(0);
  expect(check('setDefaultTimeout(10_000);\ntest("a", () => {});\n')).toBe(0);
  expect(check('test("a", () => {});\nsetDefaultTimeout(10_000);\n')).toBe(1);
  expect(check('test.todo("a");\ntest.skip("b", () => {});\n')).toBe(0);
}, 30_000);

test("the guard ignores test-like text in strings and comments", () => {
  expect(
    check(
      '// test("a", () => {})\nconst s = "it(1)";\nconst t = `test("x")`;\n',
    ),
  ).toBe(0);
  expect(maskLiterals('a("b,c") // d,e\n').includes(",")).toBe(false);
}, 30_000);
