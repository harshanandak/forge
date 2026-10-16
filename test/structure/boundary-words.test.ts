import { expect, test } from "bun:test";
import { findBoundaryViolations, isCoreFile } from "./lib/boundary.ts";
import { format, listRepoFiles, readRepoFiles } from "./lib/repo.ts";

test("core and schemas name no workflow concept", () => {
  const files = readRepoFiles(listRepoFiles().filter(isCoreFile));
  expect(format(findBoundaryViolations(files))).toEqual([]);
}, 30_000);

test("the guard rejects stage, TDD, pull request and issue words in a core file", () => {
  const planted = [
    {
      path: "src/core/state/a.ts",
      text: "export const x = 1; // advance to the next stage\n",
    },
    {
      path: "src/core/state/b.ts",
      text: "export function openIssue(): void {}\n",
    },
    { path: "src/core/state/c.ts", text: "export const PR_URL = 'x';\n" },
    { path: "schemas/d.json", text: '{ "description": "a pull request" }\n' },
    { path: "src/core/runtime/e.ts", text: "// red-green TDD loop\n" },
  ];
  const found = findBoundaryViolations(planted).map((v) => v.file);
  expect(new Set(found)).toEqual(new Set(planted.map((f) => f.path)));
}, 30_000);

test("the guard leaves blocks alone and does not match near misses", () => {
  const files = [
    {
      path: "src/blocks/work/a.ts",
      text: "export const issue = 1; // pr stage workflow\n",
    },
    {
      path: "src/core/state/b.ts",
      text: "const prefix = 'staged'; const compress = 1;\n",
    },
  ];
  expect(findBoundaryViolations(files)).toEqual([]);
}, 30_000);
