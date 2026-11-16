import { test, setDefaultTimeout } from "bun:test";
import { deepStrictEqual as eq } from "node:assert/strict";
import * as families from "../../tools/import-current-families.ts";

setDefaultTimeout(30_000);
test.each([
  ...[
    "\\b",
    "\\f",
    "\\n",
    "\\r",
    "\\t",
    "\\u0000",
    "\\u000b",
    "\\u001f",
    "\\u007f",
    "\\u0085",
    "\\u009f",
    "\\u00ad",
    "\\u061c",
    "\\u200d",
    "\\u2060",
    "\\ufeff",
    "\\udb40\\udc01",
  ].map(
    (escape) =>
      [
        `bound-lane:["local","identity","Owner${escape}Project"]:work-1`,
        false,
      ] as const,
  ),
  ...["Owner\\nProject", 'Owner"Project'].map(
    (project) =>
      [
        "bound-lane:" +
          JSON.stringify(["local", "identity", project]) +
          ":work-1",
        true,
      ] as const,
  ),
  ['bound-lane:["local","identity","Owner Project"]:work-1', true],
  ['bound-lane:["local","identity","Owner Project"]:work-1\n', false],
  ['bound-lane:["local","identity","Owner\u200bProject"]:work-1', false],
  ['bound-lane:["local","identity","Owner\\qProject"]:work-1', false],
  ['bound-lane:["local","identity","Owner\\u0020Project"]:work-1', false],
  ['bound-lane: ["local","identity","Owner Project"]:work-1', false],
  ['bound-lane:["local","identity",null]:work-1', false],
  ["autopilot:work-1 ", false],
] as const)("retained key whitespace: %j", (key, accepted) => {
  eq(families.leftBehindKey("forge/work", key), accepted);
  eq(families.ordinaryKey("forge/work", key), false);
});
