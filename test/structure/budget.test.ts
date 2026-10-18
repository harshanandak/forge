import { expect, test } from "bun:test";
import { BUDGET_PATH, findOverBudget, parseBudget } from "./lib/budget.ts";
import { format, readJson, readRepoFiles } from "./lib/repo.ts";

test("every capped document is within its byte budget", () => {
  const caps = parseBudget(readJson(BUDGET_PATH));
  expect(caps.size).toBeGreaterThan(0);
  const files = readRepoFiles([...caps.keys()]);
  expect(format(findOverBudget(files, caps))).toEqual([]);
}, 30_000);

const caps = new Map([["AGENTS.md", 10]]);

test("the guard rejects a document over its cap and names the remedy", () => {
  const violations = findOverBudget(
    [{ path: "AGENTS.md", text: "x".repeat(11) }],
    caps,
  );
  expect(violations).toHaveLength(1);
  expect(violations[0]?.message).toContain("prune it, or raise the cap");
}, 30_000);

test("the guard counts bytes, not characters", () => {
  expect(
    findOverBudget([{ path: "AGENTS.md", text: "é".repeat(6) }], caps),
  ).toHaveLength(1);
  expect(
    findOverBudget([{ path: "AGENTS.md", text: "x".repeat(10) }], caps),
  ).toHaveLength(0);
}, 30_000);

test("the guard rejects a capped document that is missing", () => {
  expect(findOverBudget([], caps)).toHaveLength(1);
}, 30_000);

test("the budget file ignores comment keys and rejects a bad cap", () => {
  expect([...parseBudget({ _comment: "c", "a.md": 5 })]).toEqual([["a.md", 5]]);
  expect(() => parseBudget({ "a.md": "5" })).toThrow();
  expect(() => parseBudget({ "a.md": 0 })).toThrow();
  expect(() => parseBudget([])).toThrow();
}, 30_000);
