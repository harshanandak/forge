import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type JsonSchema,
  validateWithSchema,
} from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);

type Adapter = { id: string; detect: string[] };
type Route = {
  model: string;
  effort: string;
  speed: string;
  harness: string;
  singleFamily: boolean;
  line: string;
};
type Handler = (call: {
  input: { role: string; max?: boolean };
  config: { adapters: Adapter[] };
  services: {
    environment: {
      select(names: readonly string[]): Readonly<Record<string, string>>;
    };
  };
}) => Route;

const root = resolve(import.meta.dirname, "../../../src/blocks/agent");
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(`${code}: ${message}`);
  };
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

function route(
  adapters: Adapter[],
  environment: Readonly<Record<string, string>> = {},
  max = false,
) {
  const selected: string[][] = [];
  const result = operations["route.get"]!({
    input: { role: "build", max },
    config: { adapters },
    services: {
      environment: {
        select(names) {
          selected.push([...names]);
          return Object.fromEntries(
            names
              .filter((name) => environment[name] !== undefined)
              .map((name) => [name, environment[name]!]),
          );
        },
      },
    },
  });
  return { result, selected };
}

test("route returns the current-model fallback with no adapters", () => {
  expect(route([]).result).toEqual({
    model: "current",
    effort: "high",
    speed: "standard",
    harness: "current",
    singleFamily: true,
    line: "current high standard current single-family",
  });
});

test("detection tries adapter ids in order without mutating configuration", () => {
  const adapters = [
    { id: "codex", detect: ["CODEX_THREAD_ID"] },
    { id: "claude", detect: ["CLAUDECODE"] },
  ];
  const { result, selected } = route(adapters, {
    CODEX_THREAD_ID: "test",
    CLAUDECODE: "1",
  });
  expect(result.harness).toBe("claude");
  expect(result.line).toBe("current high standard claude single-family");
  expect(selected[0]).toEqual(["CLAUDECODE"]);
  expect(adapters.map(({ id }) => id)).toEqual(["codex", "claude"]);
});

test("empty and missing variables do not detect an adapter", () => {
  const adapters = [
    { id: "claude", detect: ["CLAUDECODE", "CLAUDE_OTHER"] },
    { id: "codex", detect: ["CODEX_THREAD_ID"] },
  ];
  const { result, selected } = route(adapters, {
    CLAUDECODE: "",
    CODEX_THREAD_ID: "test",
  });
  expect(result.harness).toBe("codex");
  expect(selected).toEqual([
    ["CLAUDECODE", "CLAUDE_OTHER"],
    ["CODEX_THREAD_ID"],
  ]);
  expect(route(adapters, { CLAUDECODE: "" }).result.harness).toBe("current");
});

test("any nonempty detect variable matches and an empty detect list does not", () => {
  expect(
    route(
      [
        { id: "empty", detect: [] },
        { id: "match", detect: ["MISSING", "PRESENT"] },
      ],
      { PRESENT: "0" },
    ).result.harness,
  ).toBe("match");
});

test("detection accepts selected environment keys with different casing", () => {
  const result = operations["route.get"]!({
    input: { role: "build" },
    config: { adapters: [{ id: "claude", detect: ["CLAUDECODE"] }] },
    services: {
      environment: {
        select(names) {
          expect(names).toEqual(["CLAUDECODE"]);
          return { claudecode: "1" };
        },
      },
    },
  });
  expect(result.harness).toBe("claude");
});

test("max refuses with the routing-file remedy", () => {
  expect(() => route([], {}, true)).toThrow(
    "INPUT_INVALID: no model allows max; add ~/.forge/routing.yaml",
  );
});

function schema(name: string): JsonSchema {
  return JSON.parse(
    readFileSync(resolve(root, `schemas/${name}.json`), "utf8"),
  ) as JsonSchema;
}

test("adapter schema accepts only lowercase ids and environment names", () => {
  const adapter = schema("adapter");
  for (const value of [
    { id: "claude", detect: ["CLAUDECODE"] },
    { id: "codex", detect: [] },
  ])
    expect(validateWithSchema(adapter, value)).toEqual([]);
  for (const value of [
    { id: "Codex", detect: [] },
    { id: "codex", detect: ["1INVALID"] },
    { id: "codex", detect: ["HAS-DASH"] },
    { id: "codex", detect: [], over: "claude" },
  ])
    expect(validateWithSchema(adapter, value)).not.toEqual([]);
});

test("input schema admits all eleven roles and a boolean max only", () => {
  const input = schema("route.input");
  for (const role of [
    "intake",
    "plan",
    "cut",
    "build",
    "review",
    "land",
    "learn",
    "rate",
    "merge",
    "judge",
    "verify",
  ])
    expect(validateWithSchema(input, { role, max: true })).toEqual([]);
  for (const value of [{ role: "deploy" }, { role: "build", max: "true" }, {}])
    expect(validateWithSchema(input, value)).not.toEqual([]);
});
