import { expect, test } from "bun:test";
import { findAnyTypeViolations, isAnyScanFile } from "./lib/no-any.ts";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("src, tests and tools contain no explicit any types", () => {
  const files = readRepoFiles(listRepoFiles().filter(isAnyScanFile));
  expect(format(findAnyTypeViolations(files))).toEqual([]);
}, 30_000);

const forbidden: readonly (readonly [string, string])[] = [
  [": any", "const value: any = 1;"],
  ["as any", "const value = input as any;"],
  ["any[]", "const values: any[] = [];"],
  ["<any>", "const value = <any>input;"],
  ["Array<any>", "const values: Array<any> = [];"],
];

for (const [form, text] of forbidden) {
  test(`the guard rejects ${form}`, () => {
    expect(
      findAnyTypeViolations([{ path: "src/example.ts", text }]),
    ).toHaveLength(1);
  }, 30_000);
}

test("the guard ignores comments and string literals", () => {
  const text = [
    "// value: any; input as any; any[]; <any>; Array<any>",
    "/* value: any; input as any; any[]; <any>; Array<any> */",
    'const text = ": any; as any; any[]; <any>; Array<any>";',
    "const template = `: any; as any; any[]; <any>; Array<any>`;",
    "const interpolation = `value: ${input as string}`;",
    "const pattern = /Array<any>/;",
    "function regexAfterReturn() { return /Array<any>/; }",
    "const clean: unknown = 1;",
  ].join("\n");
  expect(findAnyTypeViolations([{ path: "src/example.ts", text }])).toEqual([]);
}, 30_000);

test("the guard ignores JavaScript and files outside its scan roots", () => {
  const files = [
    { path: "src/example.js", text: "const value: any = 1;" },
    { path: "docs/example.ts", text: "const value: any = 1;" },
  ];
  expect(findAnyTypeViolations(files)).toEqual([]);
}, 30_000);
