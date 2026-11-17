import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq, ok } from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

setDefaultTimeout(30_000);
const path = resolve(
  import.meta.dirname,
  "../../../src/blocks/work/record-primitives.ts",
);
const primitives = (existsSync(path) ? require(path) : {}) as Record<
  string,
  unknown
>;
const call = (name: string, ...args: unknown[]): unknown => {
  const fn = primitives[name];
  ok(typeof fn === "function", `Missing shared primitive ${name}`);
  return (fn as (...values: unknown[]) => unknown)(...args);
};
test.each([
  ["40-hex commit", "isCommit", "a".repeat(40), true],
  ["64-hex commit", "isCommit", "A".repeat(64), true],
  ["short commit", "isCommit", "a".repeat(39), false],
  ["non-hex commit", "isCommit", "z".repeat(40), false],
  ["empty reason", "validReason", "", false],
  ["whitespace reason", "validReason", " ", false],
  ["normalized reason", "validReason", "chosen", true],
  ["reason boundary", "validReason", "x".repeat(65536), true],
  ["Unicode reason boundary", "validReason", "😀".repeat(65536), true],
  ["oversized reason", "validReason", "x".repeat(65537), false],
  ["empty receipt", "validReceipt", "", false],
  ["receipt boundary", "validReceipt", "x".repeat(200), true],
  ["oversized receipt", "validReceipt", "x".repeat(201), false],
  ["UTF-16 receipt boundary", "validReceipt", "😀".repeat(100), true],
  ["oversized UTF-16 receipt", "validReceipt", "😀".repeat(101), false],
  ["existing whitespace receipt", "validReceipt", " ", true],
  [
    "uppercase evidence",
    "normalizedEvidenceSha",
    "A".repeat(40),
    "a".repeat(40),
  ],
  ["invalid evidence", "normalizedEvidenceSha", "bad", undefined],
  ["bad evidence sha", "evidenceProblem", { sha: "bad" }, "sha"],
  [
    "valid flat metrics",
    "evidenceProblem",
    { sha: "a".repeat(40), metrics: { duration: 1, state: "" } },
    undefined,
  ],
  [
    "null metrics",
    "evidenceProblem",
    { sha: "a".repeat(40), metrics: null },
    "metrics",
  ],
  [
    "nested metrics",
    "evidenceProblem",
    { sha: "a".repeat(40), metrics: { nested: {} } },
    "metrics",
  ],
  [
    "nonfinite metrics",
    "evidenceProblem",
    { sha: "a".repeat(40), metrics: { value: Infinity } },
    "metrics",
  ],
  [
    "too many metrics",
    "evidenceProblem",
    {
      sha: "a".repeat(40),
      metrics: Object.fromEntries(
        Array.from({ length: 33 }, (_, n) => [`m${n}`, n]),
      ),
    },
    "metrics",
  ],
] as const)("shared primitive preserves %s", (_name, fn, value, expected) => {
  eq(call(fn, value), expected);
});

test.each([
  ["ASK", "autopilot-ask:work-1"],
  ["journalKey", "autopilot:work-1"],
  ["clockKey", "autopilot-clock:work-1"],
  ["MERGE_KEY", "autopilot-merge:work-1"],
] as const)("shared key builder %s preserves its spelling", (fn, expected) => {
  eq(call(fn, "work-1"), expected);
});

test("approval construction keeps the selected option and gated request requirements", () => {
  const source = { harness: "test", thread: "owner", message: "1" };
  eq(call("approvalFor", true, "request-1", "#1 1A", source), {
    request: "request-1",
    quote: "#1 1A",
    source,
  });
  eq(call("approvalFor", undefined, "request-1", "#1 1A", source), undefined);
  eq(call("approvalFor", true, undefined, "#1 1A", source), undefined);
});

test.each(["Owner Project", 'quote"and\\slash', "😀", "\ud800", "\udc00"])(
  "bound key builder and parser preserve canonical %s",
  (project) => {
    const value = { origin: "local", identity: "identity", project };
    const key = `bound-lane:${JSON.stringify(Object.values(value))}:work-1`;
    eq(call("boundLaneKey", value, "work-1"), key);
    eq(call("boundLaneKey", value), key.slice(0, -6));
    eq(call("readBoundLaneKey", key), { ...value, id: "work-1" });
  },
);
test.each([
  "bound-lane:[]:work-1",
  'bound-lane:["local","identity",1]:work-1',
  'bound-lane:["local", "identity","project"]:work-1',
  'bound-lane:["local","identity","\\u0041"]:work-1',
  'bound-lane:["local","identity","Owner\\nProject"]:work-1',
  'bound-lane:["local","identity","Owner\\u200bProject"]:work-1',
])(
  "bound key parser refuses noncanonical or forbidden components %s",
  (key) => {
    eq(call("readBoundLaneKey", key), undefined);
  },
);

test("the work entry still loads through ordinary CommonJS require", () => {
  const operations = require("../../../src/blocks/work/entry.cts") as Record<
    string,
    unknown
  >;
  eq(typeof operations["lane.record"], "function");
  eq(typeof operations["issue.claim"], "function");
});
