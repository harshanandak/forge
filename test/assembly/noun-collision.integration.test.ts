import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { INTERFACE_DOCUMENTS } from "../../src/generated/schemas.ts";
import type {
  BlockManifest,
  InterfaceDocument,
} from "../../src/generated/types.ts";
import { record } from "../../src/surface/dispatch.ts";

setDefaultTimeout(30_000);

async function fixture(
  names: string[],
  overrides: Record<string, Partial<BlockManifest>> = {},
) {
  const root = mkdtempSync(join(tmpdir(), "forge-noun-collision-"));
  const file = join(root, ".forge/config.yaml");
  mkdirSync(join(root, ".forge"));
  for (const name of [...names, "healthy"]) {
    const directory = join(root, name);
    mkdirSync(directory);
    const operations =
      overrides[name]?.operations ??
      Object.fromEntries(
        (name === "healthy"
          ? ["healthy.read"]
          : ["shared.read", `${name}.read`]
        ).map((op) => [
          op,
          {
            input: "value.json",
            output: "value.json",
            context: "stateless",
            timeoutMs: 1000,
            effects: [],
            idempotent: true,
            callers: ["human"],
            stability: "experimental",
          },
        ]),
      );
    for (const [path, value] of Object.entries({
      "forge.block.json": {
        schemaVersion: "forge.block/1",
        id: `example.org/${name}`,
        version: "1.0.0",
        authorAbi: "forge.author/v1",
        profile: "trusted-action-sync/v1",
        entry: "entry.cjs",
        docs: "docs.json",
        ...overrides[name],
        operations,
      },
      "docs.json": {
        operations: Object.fromEntries(
          Object.keys(operations).map((op) => [
            op,
            { title: "Read", summary: "Read a value." },
          ]),
        ),
      },
      "value.json": { type: "string" },
    }))
      writeFileSync(join(directory, path), JSON.stringify(value));
    writeFileSync(
      join(directory, "entry.cjs"),
      `module.exports={${Object.keys(operations)
        .map((op) => `${JSON.stringify(op)}:({input})=>input`)
        .join(",")}}`,
    );
  }
  const configure = (order: string[], disabled: string[] = []) =>
    writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: "forge.config/1",
        blocks: Object.fromEntries(
          [...order, "healthy"].map((name) => [
            name,
            {
              source: { path: `./${name}` },
              ...(disabled.includes(name) ? { enabled: false } : {}),
            },
          ]),
        ),
      }),
    );
  // Admit the original captures before introducing the collision.
  configure(names, names.slice(1));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  const call = (op: string, input: unknown = {}) =>
    assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: op,
      op,
      input,
      caller: "human",
      context: localContext(assembly, { kind: "human", id: "test" }),
    });
  for (const name of [...names, "healthy"]) {
    configure(
      names,
      names.filter((other) => other !== name),
    );
    const checked = await call("block.check", { path: `./${name}` });
    expect(checked.ok).toBe(true);
    const admitted = await call("block.admit", {
      digest: record(checked.result)?.digest,
    });
    expect(admitted.ok).toBe(true);
  }
  return {
    assembly,
    configure,
    call,
    async close() {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function observe(
  f: Awaited<ReturnType<typeof fixture>>,
  names: string[],
) {
  const unavailable = f.assembly.catalog.unavailable();
  expect(unavailable.map((block) => block.name)).toEqual([...names].sort());
  for (const block of unavailable) {
    expect(block.error.code).toBe("INPUT_INVALID");
    expect(block.reason).toContain('"shared"');
    for (const name of names) expect(block.reason).toContain(`"${name}"`);
  }
  expect(
    f.assembly.catalog.list().some((entry) => entry.op === "shared.read"),
  ).toBe(false);
  const blocked = await f.call("shared.read", "blocked");
  expect(blocked).toMatchObject({
    ok: false,
    error: { code: "INPUT_INVALID" },
  });
  for (const name of [...names, "healthy"]) {
    expect(await f.call(`${name}.read`, name)).toMatchObject({
      ok: true,
      result: name,
    });
  }
  const shown = await f.call("config.show");
  expect(shown).toMatchObject({ ok: false, result: { valid: false } });
  const problems = record(shown.result)?.problems;
  expect(problems).toEqual(unavailable.map((block) => block.reason));
  return {
    unavailable,
    blocked,
    problems,
    diagnosis: f.assembly.catalog.diagnose?.("shared.read"),
  };
}

test("two noun owners have identical diagnostics in either order and config.set repairs them", async () => {
  const names = ["alpha", "bravo"];
  const f = await fixture(names);
  try {
    f.configure(names);
    const first = await observe(f, names);
    f.configure([...names].reverse());
    expect(await observe(f, names)).toEqual(first);
    const shown = await f.call("config.show");
    expect(
      await f.call("config.set", {
        path: "/blocks/bravo/rename",
        value: { shared: "repaired" },
        expectRevision: record(shown.result)?.revision,
      }),
    ).toMatchObject({ ok: true });
    expect(f.assembly.catalog.unavailable()).toEqual([]);
    expect(await f.call("config.show")).toMatchObject({
      ok: true,
      result: { valid: true },
    });
    for (const noun of ["shared", "repaired", ...names, "healthy"]) {
      expect(await f.call(`${noun}.read`, noun)).toMatchObject({
        ok: true,
        result: noun,
      });
    }
  } finally {
    await f.close();
  }
});

test("all three noun owners are reported in every order without disabling other nouns", async () => {
  const names = ["alpha", "bravo", "charlie"];
  const f = await fixture(names);
  try {
    const outcomes = [];
    for (const order of [
      ["alpha", "bravo", "charlie"],
      ["alpha", "charlie", "bravo"],
      ["bravo", "alpha", "charlie"],
      ["bravo", "charlie", "alpha"],
      ["charlie", "alpha", "bravo"],
      ["charlie", "bravo", "alpha"],
    ]) {
      f.configure(order);
      outcomes.push(await observe(f, names));
    }
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]!);
  } finally {
    await f.close();
  }
});

test("a suppressed provider cannot bind an unrelated optional consumer in either order", async () => {
  const names = ["alpha", "bravo"];
  const f = await fixture(names, {
    bravo: { provides: [{ interface: "example.host@1.0.0", noun: "shared" }] },
    healthy: {
      requires: [{ slot: "host", interface: "example.host@1", optional: true }],
    },
  });
  try {
    f.configure(names);
    const first = await observe(f, names);
    f.configure([...names].reverse());
    expect(await observe(f, names)).toEqual(first);
  } finally {
    await f.close();
  }
});

test("a suppressed known interface preserves independent nouns and one diagnostic per participant in either order", async () => {
  const tracker = INTERFACE_DOCUMENTS.find(
    (doc) => doc.id === "forge.tracker",
  ) as unknown as InterfaceDocument;
  const trackerOperations: BlockManifest["operations"] = Object.fromEntries(
    Object.entries(tracker.operations).map(([verb, expected]) => [
      `shared.${verb}`,
      {
        input: "value.json",
        output: "value.json",
        context: expected.context,
        ...(expected.leaseMode === undefined
          ? {}
          : { leaseMode: expected.leaseMode }),
        timeoutMs: 1000,
        effects: expected.access === "write" ? ["shared:write"] : [],
        idempotent: expected.idempotent,
        callers: ["human"],
        stability: "experimental",
      },
    ]),
  );
  const names = ["alpha", "bravo"];
  const f = await fixture(names, {
    bravo: {
      provides: [{ interface: "forge.tracker@1.0.0", noun: "shared" }],
      operations: {
        ...trackerOperations,
        "shared.read": {
          input: "value.json",
          output: "value.json",
          context: "stateless",
          timeoutMs: 1000,
          effects: [],
          idempotent: true,
          callers: ["human"],
          stability: "experimental",
        },
        "bravo.read": {
          input: "value.json",
          output: "value.json",
          context: "stateless",
          timeoutMs: 1000,
          effects: [],
          idempotent: true,
          callers: ["human"],
          stability: "experimental",
        },
      },
    },
  });
  try {
    f.configure(names);
    const first = await observe(f, names);
    f.configure([...names].reverse());
    expect(await observe(f, names)).toEqual(first);
    for (const verb of Object.keys(tracker.operations)) {
      expect(
        f.assembly.catalog
          .list()
          .some((entry) => entry.op === `shared.${verb}`),
      ).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test("provider projection resolves an omitted noun before filtering in either order", async () => {
  const names = ["alpha", "bravo"];
  const read = {
    input: "value.json",
    output: "value.json",
    context: "stateless",
    timeoutMs: 1000,
    effects: [],
    idempotent: true,
    callers: ["human"],
    stability: "experimental",
  } as const;
  const f = await fixture(names, {
    bravo: {
      operations: { "shared.read": read },
      provides: [{ interface: "example.host@1.0.0" }],
    },
    healthy: {
      requires: [{ slot: "host", interface: "example.host@1", optional: true }],
    },
  });
  try {
    for (const order of [names, [...names].reverse()]) {
      f.configure(order);
      expect(
        f.assembly.catalog.unavailable().map((block) => block.name),
      ).toEqual(names);
      expect(await f.call("shared.read", "blocked")).toMatchObject({
        ok: false,
        error: { code: "INPUT_INVALID" },
      });
      expect(await f.call("alpha.read", "alpha")).toMatchObject({
        ok: true,
        result: "alpha",
      });
      expect(await f.call("healthy.read", "healthy")).toMatchObject({
        ok: true,
        result: "healthy",
      });
    }
  } finally {
    await f.close();
  }
});
