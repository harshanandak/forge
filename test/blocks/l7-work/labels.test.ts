import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type SchemaObject,
  SchemaRegistry,
  validateWithSchema,
} from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);

type Item = { id: string; labels: string[]; dependsOn: string[] };
type Handler = (call: {
  input: Record<string, unknown>;
  config?: unknown;
  services: unknown;
}) => { items: { id: string }[] };

const root = resolve(import.meta.dirname, "../../../src/blocks/work");
let operations: Record<string, Handler>;
const globals = globalThis as Record<string, unknown>;
const hadFail = "fail" in globals;
const previousFail = globals.fail;
beforeAll(() => {
  globals.fail = (code: string) => {
    throw new Error(code);
  };
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (hadFail) globals.fail = previousFail;
  else delete globals.fail;
});

function services(items: readonly Item[]) {
  const records = items.map((item) => ({
    key: `issue:${item.id}`,
    revision: 1,
    updatedAt: "2026-10-20T00:00:00Z",
    value: { ...item, title: item.id, status: "open", createdAt: "x" },
  }));
  return {
    state: {
      list: () => records,
      get: (key: string) => records.find((record) => record.key === key),
      lease: () => undefined,
      acquire: () => undefined,
      now: () => 0,
    },
  };
}
const backlog: readonly Item[] = [
  { id: "a", labels: ["p3"], dependsOn: [] },
  { id: "b", labels: ["p1", "bug"], dependsOn: [] },
  { id: "c", labels: [], dependsOn: [] },
  { id: "d", labels: ["p0"], dependsOn: [] },
  { id: "e", labels: ["p1"], dependsOn: [] },
  { id: "f", labels: ["bug", "p0"], dependsOn: ["a"] },
];
function ids(op: string, input: Record<string, unknown>, config?: unknown) {
  return operations[op]!({
    input,
    config,
    services: services(backlog),
  }).items.map((item) => item.id);
}

test("issue.ready with labels returns only items carrying every label", () => {
  expect(ids("issue.ready", { labels: ["p1"] })).toEqual(["b", "e"]);
  expect(ids("issue.ready", { labels: ["p1", "bug"] })).toEqual(["b"]);
  expect(ids("issue.ready", { labels: ["p9"] })).toEqual([]);
});

test("issue.list with labels filters and keeps blocked items", () => {
  expect(ids("issue.list", { labels: ["p0"] })).toEqual(["d", "f"]);
  expect(ids("issue.list", { labels: ["p0"], limit: 1 })).toEqual(["d"]);
  expect(ids("issue.list", {})).toHaveLength(backlog.length);
});

test("issue.ready orders by the first configured label, then stored order", () => {
  const labelOrder = ["p0", "p1", "p2", "p3", "p4"];
  expect(ids("issue.ready", {}, { labelOrder })).toEqual([
    "d",
    "b",
    "e",
    "a",
    "c",
  ]);
  expect(ids("issue.ready", { limit: 2 }, { labelOrder })).toEqual(["d", "b"]);
  expect(ids("issue.ready", { labels: ["p1"] }, { labelOrder })).toEqual([
    "b",
    "e",
  ]);
});

test("a missing or empty labelOrder leaves the stored order", () => {
  const stored = ["a", "b", "c", "d", "e"];
  expect(ids("issue.ready", {})).toEqual(stored);
  expect(ids("issue.ready", {}, {})).toEqual(stored);
  expect(ids("issue.ready", {}, { labelOrder: [] })).toEqual(stored);
});

test("only ready work is reordered", () => {
  const labelOrder = ["p0", "p1", "p2", "p3", "p4"];
  expect(ids("issue.list", {}, { labelOrder })).toEqual(
    backlog.map((item) => item.id),
  );
});

test("the config schema declares labelOrder with an empty default and refuses other keys", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/config.json"), "utf8"),
  ) as { properties: { labelOrder: { default: unknown } } };
  expect(schema.properties.labelOrder.default).toEqual([]);
  expect(validateWithSchema(schema, { labelOrder: ["p0", "p1"] })).toEqual([]);
  expect(validateWithSchema(schema, { labelOrder: ["p0", "p0"] })).not.toEqual(
    [],
  );
  expect(validateWithSchema(schema, { other: 1 })).not.toEqual([]);
});

test("issue.lint has its own input schema that refuses labels", () => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, "forge.block.json"), "utf8"),
  ) as { operations: Record<string, { input: string }> };
  const read = (path: string) =>
    JSON.parse(readFileSync(path, "utf8")) as SchemaObject;
  const lint = {
    ...read(resolve(root, manifest.operations["issue.lint"]!.input)),
    $id: "urn:forge:test:lint-input",
  };
  const schemas = resolve(root, "../../../schemas");
  const contract = readdirSync(schemas)
    .filter((name) => name.endsWith(".json"))
    .map((name) => read(resolve(schemas, name)));
  const registry = new SchemaRegistry([...contract, lint]);
  const validate = (value: unknown) =>
    registry.validate("urn:forge:test:lint-input", value);
  expect(validate({})).toEqual([]);
  expect(validate({ status: "open", limit: 5 })).toEqual([]);
  expect(validate({ labels: ["p0"] })).not.toEqual([]);
});
