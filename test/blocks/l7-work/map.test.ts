import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type SchemaObject,
  validateWithSchema,
} from "../../../src/contract/schema.ts";
import { validateUpdateItemInput } from "../../../src/generated/validators.ts";
import type { StateRecord, TrackerItem } from "../../../src/generated/types.ts";

type Node = {
  item: TrackerItem;
  openChildren: number;
  closedChildren: number;
  children: Node[];
};
type Result = TrackerItem & {
  items: (TrackerItem & Node)[];
  problems: string[];
  parentless: { count: number; ids: string[] };
  closedParents: { count: number; ids: string[] };
  truncated: boolean;
};
type Handler = (call: {
  input: Record<string, unknown>;
  config: unknown;
  services: unknown;
}) => Result;
setDefaultTimeout(1000);
const root = resolve(import.meta.dirname, "../../../src/blocks/work");
const globals = globalThis as Record<string, unknown>;
const previousFail = globals.fail;
let operations: Record<string, Handler>;
beforeAll(() => {
  globals.fail = (code: string, message: string) => {
    throw new Error(code + ": " + message);
  };
  operations = require(resolve(root, "entry.cts")) as typeof operations;
});
afterAll(() => {
  if (previousFail === undefined) delete globals.fail;
  else globals.fail = previousFail;
});
function project() {
  const records = new Map<string, StateRecord>();
  const state = {
    now: () => 0,
    get: (key: string) => records.get(key),
    list: (prefix: string) =>
      [...records.values()].filter((r) => r.key.startsWith(prefix)),
    lease: () => undefined,
    acquire: () => undefined,
    put(
      this: void,
      key: string,
      value: unknown,
      options: {
        expectRevision: number;
        readSet?: { key: string; expectRevision: number }[];
      },
    ) {
      if ((records.get(key)?.revision ?? 0) !== options.expectRevision)
        throw new Error("REVISION_CONFLICT");
      for (const read of options.readSet ?? [])
        if (records.get(read.key)?.revision !== read.expectRevision)
          throw new Error("REVISION_CONFLICT");
      const record: StateRecord = {
        key,
        namespace: "forge/work",
        updatedBy: { kind: "agent", id: "test" },
        value,
        revision: options.expectRevision + 1,
        updatedAt: new Date(0).toISOString(),
      };
      records.set(key, record);
      return record;
    },
  };
  const call = (
    op: string,
    input: Record<string, unknown> = {},
    config: unknown = { idPrefix: "forge" },
  ) => operations["issue." + op]!({ input, config, services: { state } });
  const epic = call("create", { title: "epic", kind: "epic" });
  const one = call("create", {
    title: "one",
    kind: "task",
    labels: ["p1", "area:tracker"],
    parent: epic.id,
  });
  const two = call("create", {
    title: "two",
    kind: "bug",
    labels: ["p1", "p2"],
  });
  return { call, epic, one, two, records, state };
}
test("parent can be set after creation", () => {
  const { call, epic, two } = project();
  expect(
    validateUpdateItemInput({ id: two.id, parent: epic.id, expectRevision: 1 })
      .ok,
  ).toBe(true);
  expect(
    call("update", { id: two.id, parent: epic.id, expectRevision: 1 }).parent,
  ).toBe(epic.id);
});
test("parent null removes the parent property", () => {
  const { call, one } = project();
  expect(
    call("update", { id: one.id, parent: null, expectRevision: 1 }),
  ).not.toHaveProperty("parent");
});
test("parent update refuses cycles including self and preserves revision", () => {
  const { call, epic, one } = project();
  for (const parent of [one.id, epic.id])
    expect(() =>
      call("update", { id: epic.id, parent, expectRevision: 1 }),
    ).toThrow("INPUT_CONFLICT");
  expect(call("show", { id: epic.id }).revision).toBe(1);
});
test("parent update refuses unknown parents", () => {
  const { call, two } = project();
  expect(() =>
    call("update", { id: two.id, parent: "forge-999", expectRevision: 1 }),
  ).toThrow("NOT_FOUND");
});
test("parent update keeps expected revision and fences ancestor reads", () => {
  const { call, one, two, state } = project();
  expect(() =>
    call("update", { id: two.id, parent: one.id, expectRevision: 9 }),
  ).toThrow("REVISION_CONFLICT");
  const put = state.put;
  state.put = (key, value, options) => {
    expect(options.readSet?.map((r) => r.key).sort()).toEqual([
      "issue:work-1",
      "issue:work-2",
    ]);
    return put(key, value, options);
  };
  call("update", { id: two.id, parent: one.id, expectRevision: 1 });
});
for (const [filter, expected] of [
  [{ parent: "forge-1" }, ["forge-2"]],
  [{ parent: "none" }, ["forge-1", "forge-3"]],
  [{ kind: "bug" }, ["forge-3"]],
  [{ label: ["p1", "area:tracker"] }, ["forge-2"]],
  [{ parent: "forge-1", kind: "bug", label: ["p1"] }, []],
] as const)
  test("list filters " + JSON.stringify(filter), () => {
    const { call } = project();
    expect(call("list", filter).items.map((i) => i.id)).toEqual([...expected]);
  });
test("tree shows counts, parentless, and open children of closed parents", () => {
  const { call, epic, one, two } = project();
  call("update", { id: epic.id, status: "closed", expectRevision: 1 });
  const next = call("create", { title: "open epic", kind: "epic" });
  call("create", { title: "child", parent: next.id });
  const closed = call("create", { title: "closed child", parent: next.id });
  call("update", { id: closed.id, status: "closed", expectRevision: 1 });
  const tree = call("tree");
  expect(tree.items.map((i) => i.item.id)).toEqual([next.id]);
  expect(tree.items[0]).toMatchObject({
    openChildren: 1,
    closedChildren: 1,
    children: [{ item: { id: "forge-5" } }],
  });
  expect(tree.parentless).toEqual({ count: 2, ids: [two.id, next.id] });
  expect(tree.closedParents).toEqual({ count: 1, ids: [one.id] });
  expect(
    call("tree", { id: epic.id }).items[0]!.children.map((i) => i.item.id),
  ).toEqual([one.id]);
});
test("tree bounds all emitted nodes and anomaly ids and stops at depth 3", () => {
  const { call, epic } = project();
  let parent = epic.id;
  for (let i = 0; i < 5; i++)
    parent = call("create", { title: "nested", parent }).id;
  const tree = call("tree", { id: epic.id, limit: 100 });
  const chain = tree.items[0]!.children[1]!.children[0]!.children[0]!;
  expect(chain.children).toEqual([]);
  expect(chain.openChildren).toBe(1);
  expect(tree.truncated).toBe(true);
  const small = call("tree", { limit: 2 });
  const count = (nodes: Node[]): number =>
    nodes.reduce((n, node) => n + 1 + count(node.children), 0);
  expect(
    count(small.items) +
      small.parentless.ids.length +
      small.closedParents.ids.length,
  ).toBeLessThanOrEqual(2);
  expect(small.truncated).toBe(true);
  expect(() => call("tree", { id: "forge-999" })).toThrow("NOT_FOUND");
});
test("lint requires exactly one label per configured group on open issues", () => {
  const { call, two } = project();
  const config = {
    idPrefix: "forge",
    labels: {
      required: [{ prefix: "area:" }, { oneOf: ["p0", "p1", "p2", "p3"] }],
    },
  };
  const problems = call("lint", {}, config).problems;
  expect(
    problems.some(
      (p) => p.includes(two.id) && p.includes("area:") && p.includes("0"),
    ),
  ).toBe(true);
  expect(
    problems.some(
      (p) => p.includes(two.id) && p.includes("p0") && p.includes("2"),
    ),
  ).toBe(true);
  expect(problems.some((p) => p.includes("forge-2"))).toBe(false);
  call("update", { id: two.id, status: "closed", expectRevision: 1 });
  expect(
    call("lint", {}, config).problems.some((p) => p.includes(two.id)),
  ).toBe(false);
});
test("lint reports an open issue with a closed parent", () => {
  const { call, epic, one } = project();
  call("update", { id: epic.id, status: "closed", expectRevision: 1 });
  expect(call("lint").problems).toContain(
    one.id + ": parent " + epic.id + " is closed",
  );
});
test("default lint remains silent without required groups", () => {
  expect(project().call("lint").problems).toEqual([]);
});
test("label groups config is optional and validates exclusive nonempty selectors", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/config.json"), "utf8"),
  ) as SchemaObject;
  expect(
    validateWithSchema(schema, {
      labels: { required: [{ prefix: "area:" }, { oneOf: ["p0", "p1"] }] },
    }),
  ).toEqual([]);
  for (const group of [
    {},
    { prefix: "" },
    { oneOf: [] },
    { prefix: "area:", oneOf: ["p1"] },
  ])
    expect(
      validateWithSchema(schema, { labels: { required: [group] } }),
    ).not.toEqual([]);
});
