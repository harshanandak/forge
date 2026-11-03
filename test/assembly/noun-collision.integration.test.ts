import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import type { BlockManifest } from "../../src/generated/types.ts";
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
          (order.includes("healthy") ? order : [...order, "healthy"]).map(
            (name) => [
              name,
              {
                source: { path: `./${name}` },
                ...(disabled.includes(name) ? { enabled: false } : {}),
              },
            ],
          ),
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
  const unavailable = f.assembly.catalog
    .unavailable()
    .toSorted((a, b) => a.name.localeCompare(b.name));
  expect(unavailable.map((block) => block.name)).toEqual([...names].sort());
  for (const block of unavailable) {
    expect(block.error.code).toBe("INPUT_INVALID");
    expect(block.reason).toContain('"shared"');
    for (const name of names) expect(block.reason).toContain(`"${name}"`);
    expect(block.reason).toBe(unavailable[0]!.reason);
  }
  const operations = f.assembly.catalog.list().map((entry) => entry.op);
  for (const noun of ["shared", ...names]) {
    expect(operations).not.toContain(`${noun}.read`);
    expect(await f.call(`${noun}.read`, "blocked")).toMatchObject({
      ok: false,
      error: { code: "INPUT_INVALID" },
    });
  }
  expect(await f.call("healthy.read", "healthy")).toMatchObject({
    ok: true,
    result: "healthy",
  });
  const shown = await f.call("config.show");
  expect(shown).toMatchObject({ ok: false, result: { valid: false } });
  const problems = record(shown.result)?.problems as string[];
  expect(problems.toSorted()).toEqual(
    unavailable.map((block) => block.reason).sort(),
  );
  return unavailable;
}

test("both noun owners have identical diagnostics in either order and config.set disables one to repair", async () => {
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
        path: "/blocks/bravo/enabled",
        value: false,
        expectRevision: record(shown.result)?.revision,
      }),
    ).toMatchObject({ ok: true });
    expect(f.assembly.catalog.unavailable()).toEqual([]);
    expect(await f.call("config.show")).toMatchObject({
      ok: true,
      result: { valid: true },
    });
    for (const noun of ["shared", "alpha", "healthy"]) {
      expect(await f.call(`${noun}.read`, noun)).toMatchObject({
        ok: true,
        result: noun,
      });
    }
    expect(
      f.assembly.catalog.list().some((entry) => entry.op === "bravo.read"),
    ).toBe(false);
  } finally {
    await f.close();
  }
});

test("all three owners are rejected in every order while an unrelated optional consumer stays available", async () => {
  const names = ["alpha", "bravo", "charlie"];
  const f = await fixture(names, {
    bravo: { provides: [{ interface: "example.host@1.0.0", noun: "shared" }] },
    healthy: {
      requires: [{ slot: "host", interface: "example.host@1", optional: true }],
    },
  });
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
      f.configure(["healthy", ...order]);
      outcomes.push(await observe(f, names));
    }
    for (const outcome of outcomes) expect(outcome).toEqual(outcomes[0]!);
  } finally {
    await f.close();
  }
});

test("rejecting a provider with an implicit noun leaves an unrelated optional consumer available", async () => {
  const names = ["alpha", "bravo"];
  const f = await fixture(names, {
    bravo: {
      operations: {
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
      },
      provides: [{ interface: "example.host@1.0.0" }],
    },
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

test("local noun renames introduce and repair collisions without rewriting manifests", async () => {
  const names = ["alpha", "bravo"];
  const f = await fixture(names);
  try {
    f.configure(names);
    const shown = await f.call("config.show");
    expect(
      await f.call("config.set", {
        path: "/blocks/bravo/rename",
        value: { shared: "repaired" },
        expectRevision: record(shown.result)?.revision,
      }),
    ).toMatchObject({ ok: true });
    expect(f.assembly.catalog.unavailable()).toEqual([]);
    for (const noun of ["shared", "repaired", ...names, "healthy"]) {
      expect(await f.call(`${noun}.read`, noun)).toMatchObject({
        ok: true,
        result: noun,
      });
    }
    const repaired = await f.call("config.show");
    expect(
      await f.call("config.set", {
        path: "/blocks/alpha/rename",
        value: { shared: "repaired" },
        expectRevision: record(repaired.result)?.revision,
      }),
    ).toMatchObject({ ok: true });
    const unavailable = f.assembly.catalog.unavailable();
    expect(unavailable.map((block) => block.name).sort()).toEqual(names);
    for (const block of unavailable) {
      expect(block.error.code).toBe("INPUT_INVALID");
      expect(block.reason).toContain('"repaired"');
      for (const name of names) expect(block.reason).toContain(`"${name}"`);
      expect(block.reason).toBe(unavailable[0]!.reason);
    }
    for (const noun of ["shared", "repaired", ...names]) {
      expect(
        f.assembly.catalog.list().some((entry) => entry.op === `${noun}.read`),
      ).toBe(false);
    }
  } finally {
    await f.close();
  }
});

test("each participant reports every colliding noun in sorted order", async () => {
  const names = ["alpha", "bravo"];
  const f = await fixture(names);
  try {
    const outcomes = [];
    for (const order of [names, [...names].reverse()]) {
      f.configure(order);
      for (const name of names) {
        const shown = await f.call("config.show");
        expect(
          await f.call("config.set", {
            path: `/blocks/${name}/rename`,
            value: { [name]: "extra" },
            expectRevision: record(shown.result)?.revision,
          }),
        ).toMatchObject({ ok: true });
      }
      const outcome = await observe(f, names);
      for (const block of outcome) {
        expect(block.reason).toContain('"extra"');
        expect(block.reason.indexOf('"extra"')).toBeLessThan(
          block.reason.indexOf('"shared"'),
        );
        expect(block.reason.indexOf('"alpha"')).toBeLessThan(
          block.reason.indexOf('"bravo"'),
        );
      }
      expect(
        f.assembly.catalog.list().some((entry) => entry.op === "extra.read"),
      ).toBe(false);
      outcomes.push(outcome);
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  } finally {
    await f.close();
  }
});
