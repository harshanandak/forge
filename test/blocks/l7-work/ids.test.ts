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
  return Object.assign(
    <Op extends string>(
      op: Op,
      input: Record<string, unknown>,
      config?: unknown,
    ) =>
      operations[op]!({
        input,
        config,
        services: { state },
      }) as Op extends "issue.close" ? Promise<Item> : Item,
    { records },
  );
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

test("an id with a prefix this project never used is refused, naming the prefixes it accepts", () => {
  const call = project();
  const forge = { idPrefix: "forge" };
  call("issue.create", { title: "one" }, forge);
  // Another project's id must not silently open this project's item 1.
  for (const foreign of ["scoreeasy-1", "work-1"])
    expect(() => call("issue.show", { id: foreign }, forge)).toThrow(
      `INPUT_INVALID: Unknown id prefix ${foreign.split("-")[0]} in ${foreign}; this project's ids carry forge`,
    );
  expect(() =>
    call("issue.create", { title: "x", dependsOn: ["scoreeasy-1"] }, forge),
  ).toThrow("Unknown id prefix");
  expect(() =>
    call(
      "issue.dep",
      { id: "forge-1", target: "other-1", action: "add", expectRevision: 1 },
      forge,
    ),
  ).toThrow("Unknown id prefix");
  // After a change the old prefix was used, so it is accepted; the error names both.
  const acme = { idPrefix: "acme" };
  expect(call("issue.show", { id: "forge-1" }, acme).id).toBe("acme-1");
  expect(() => call("issue.show", { id: "scoreeasy-1" }, acme)).toThrow(
    "this project's ids carry acme, forge",
  );
});

for (const relation of ["dependsOn", "parent"] as const) {
  test(`a failed create with a missing ${relation} leaves no prefix alias`, () => {
    const call = project();
    const forge = { idPrefix: "forge" };
    const acme = { idPrefix: "acme" };
    call("issue.create", { title: "local" }, forge);
    const before = [...call.records.values()];
    expect(() =>
      call(
        "issue.create",
        {
          title: "must fail",
          [relation]: relation === "dependsOn" ? ["acme-999"] : "acme-999",
        },
        acme,
      ),
    ).toThrow("NOT_FOUND");
    expect([...call.records.values()]).toEqual(before);
    expect(() => call("issue.show", { id: "acme-1" }, forge)).toThrow(
      "Unknown id prefix acme",
    );
    // Only a successful mint makes the earlier name an alias after switching back.
    expect(call("issue.create", { title: "minted" }, acme).id).toBe("acme-2");
    expect(call("issue.show", { id: "acme-1" }, forge).id).toBe("forge-1");
  });
}

test("an item from before prefixes were recorded counts as minted with work, and the record stays hidden", () => {
  const call = project();
  // An item written before this change: no recorded prefix.
  call.records.set("issue:work-1", {
    key: "issue:work-1",
    revision: 1,
    updatedAt: "2026-10-20T00:00:00Z",
    value: {
      id: "work-1",
      title: "legacy",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: "2026-10-20T00:00:00Z",
    },
  });
  const forge = { idPrefix: "forge" };
  expect(call("issue.show", { id: "work-1" }, forge).id).toBe("forge-1");
  expect(() => call("issue.show", { id: "acme-1" }, forge)).toThrow(
    "this project's ids carry forge, work",
  );
  const minted = call("issue.create", { title: "new" }, forge);
  expect(minted).not.toHaveProperty("prefix");
  const acme = { idPrefix: "acme" };
  for (const alias of ["work-2", "forge-2", "acme-2"])
    expect(call("issue.show", { id: alias }, acme).id).toBe("acme-2");
});

test("every operation that takes an id accepts an alias and answers with the current prefix", async () => {
  const call = project();
  const acme = { idPrefix: "acme" };
  call("issue.create", { title: "base" });
  call("issue.create", { title: "other" }, { idPrefix: "forge" });
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
  call(
    "issue.link",
    { id: "forge-1", relation: "delivers", url: "https://x.example/1" },
    acme,
  );
  const links = call("issue.links", { id: "acme-1" }, acme) as unknown as {
    records: unknown[];
  };
  expect(links.records).toHaveLength(1);
  const listed = call("issue.list", {}, acme) as unknown as {
    items: Item[];
  };
  expect(listed.items.map((item) => item.id)).toEqual(["acme-1", "acme-2"]);
  expect(
    (
      await call(
        "issue.close",
        { id: "work-1", withoutReceipt: "Prefix fixture" },
        acme,
      )
    ).id,
  ).toBe("acme-1");
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

test("malformed ids are rejected before lookup with the current prefix example", () => {
  const call = project();
  for (const id of ["not/an/issue", "forge", "forge-", "forge-one"]) {
    expect(() => call("issue.show", { id }, { idPrefix: "forge" })).toThrow(
      `INPUT_INVALID: Invalid issue id ${JSON.stringify(id)}; expected <prefix>-<n> (for example forge-1)`,
    );
  }
  expect(call.records.size).toBe(0);
});
