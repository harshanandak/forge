import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateWithSchema } from "../../../src/contract/schema.ts";

setDefaultTimeout(30_000);

type Item = {
  id: string;
  dependsOn: string[];
  parent?: string;
  lease?: unknown;
};
type Handler = (call: {
  input: Record<string, unknown>;
  config?: unknown;
  services: unknown;
}) => unknown;

const root = resolve(import.meta.dirname, "../../../src/blocks/work");
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

type Lease = { generation: number; holder: unknown; expiresAt: string };
/** One project's state: records and leases in memory, written the way the state owner writes them. */
function project() {
  const records = new Map<
    string,
    { key: string; revision: number; updatedAt: string; value: unknown }
  >();
  const leases = new Map<string, Lease>();
  const state = {
    now: () => 0,
    get: (key: string) => records.get(key),
    list: (prefix = "") =>
      [...records.values()].filter((record) => record.key.startsWith(prefix)),
    put(key: string, value: unknown, options: { expectRevision: number }) {
      const revision = records.get(key)?.revision ?? 0;
      if (revision !== options.expectRevision)
        throw new Error("REVISION_CONFLICT");
      const record = {
        key,
        revision: revision + 1,
        updatedAt: "2026-10-21T00:00:00Z",
        value: structuredClone(value),
      };
      records.set(key, record);
      return record;
    },
    lease: (subject: string) => leases.get(subject),
    acquire(subject: string) {
      const lease = {
        generation: 1,
        holder: { actor: "a", session: "s" },
        expiresAt: "2999-01-01T00:00:00Z",
      };
      leases.set(subject, lease);
      return lease;
    },
    renew: (subject: string) => leases.get(subject),
    release: (subject: string) => leases.get(subject),
    events: () => [],
  };
  return (op: string, input: Record<string, unknown>, config?: unknown) =>
    operations[op]!({ input, config, services: { state } }) as Item;
}

test("a project named forge mints forge-1, and the prefix carries through deps and parents", () => {
  const call = project();
  const forge = { idPrefix: "forge" };
  expect(call("issue.create", { title: "one" }, forge).id).toBe("forge-1");
  const two = call(
    "issue.create",
    { title: "two", dependsOn: ["forge-1"], parent: "forge-1" },
    forge,
  );
  expect(two).toMatchObject({
    id: "forge-2",
    dependsOn: ["forge-1"],
    parent: "forge-1",
  });
});

test("after a prefix change every earlier prefix still names the same item, shown with the new one", () => {
  const call = project();
  call("issue.create", { title: "made as work" });
  call("issue.create", { title: "made as forge" }, { idPrefix: "forge" });
  call(
    "issue.create",
    { title: "child", dependsOn: ["forge-1"], parent: "work-2" },
    { idPrefix: "forge" },
  );
  const acme = { idPrefix: "acme" };
  for (const alias of ["work-1", "forge-1", "acme-1"])
    expect(call("issue.show", { id: alias }, acme).id).toBe("acme-1");
  // Deps and parents survive the change: they are stored by number, never rewritten.
  expect(call("issue.show", { id: "work-3" }, acme)).toMatchObject({
    id: "acme-3",
    dependsOn: ["acme-1"],
    parent: "acme-2",
  });
  expect(() => call("issue.show", { id: "acme-9" }, acme)).toThrow("NOT_FOUND");
});

test("every operation that takes an id accepts an alias and answers with the current prefix", () => {
  const call = project();
  const acme = { idPrefix: "acme" };
  call("issue.create", { title: "base" });
  call("issue.create", { title: "other" });
  expect(call("issue.claim", { id: "forge-2" }, acme).id).toBe("acme-2");
  expect(call("issue.renew", { id: "work-2" }, acme).id).toBe("acme-2");
  expect(call("issue.release", { id: "forge-2" }, acme).id).toBe("acme-2");
  expect(
    call(
      "issue.dep",
      { id: "forge-2", target: "work-1", action: "add", expectRevision: 1 },
      acme,
    ).dependsOn,
  ).toEqual(["acme-1"]);
  expect(
    call(
      "issue.update",
      { id: "work-2", expectRevision: 2, title: "renamed" },
      acme,
    ),
  ).toMatchObject({ id: "acme-2", dependsOn: ["acme-1"] });
  expect(call("issue.comment", { id: "forge-1", body: "hi" }, acme).id).toBe(
    "acme-1",
  );
  call("issue.link", {
    id: "forge-1",
    relation: "delivers",
    url: "https://x.example/1",
  });
  const links = call("issue.links", { id: "acme-1" }) as unknown as {
    records: unknown[];
  };
  expect(links.records).toHaveLength(1);
  const listed = call("issue.list", {}, acme) as unknown as {
    items: Item[];
  };
  expect(listed.items.map((item) => item.id)).toEqual(["acme-1", "acme-2"]);
  expect(call("issue.close", { id: "work-1" }, acme).id).toBe("acme-1");
});

test("idPrefix is a schema value: lowercase letters, digits and single hyphens, defaulting to work", () => {
  const schema = JSON.parse(
    readFileSync(resolve(root, "schemas/config.json"), "utf8"),
  ) as { properties: { idPrefix: { default: unknown } } };
  expect(schema.properties.idPrefix.default).toBe("work");
  for (const good of ["forge", "product-suite", "p2p", "a1-b2"])
    expect(validateWithSchema(schema, { idPrefix: good })).toEqual([]);
  for (const bad of ["", "Forge", "-forge", "forge-", "a--b", "a_b", "a b"])
    expect(validateWithSchema(schema, { idPrefix: bad })).not.toEqual([]);
  expect(validateWithSchema(schema, { idPrefix: "x".repeat(33) })).not.toEqual(
    [],
  );
});
