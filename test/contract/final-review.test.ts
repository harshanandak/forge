// Final review round: each case fails without its fix.
import { expect, test } from "bun:test";
import {
  checkProvidedInterface,
  type ConfigDocument,
  type BlockManifest,
  type InterfaceDocument,
  type McpCandidate,
  type OperationDeclaration,
  openAll,
  parseUntrustedJson,
  resolveComposition,
  SchemaRegistry,
  selectMcpTools,
  step,
  validateWithSchema,
} from "../../src/contract/index.ts";
import type { LifetimeProvider } from "../../src/ports/index.ts";
import { fixture } from "./lib/fixtures.ts";

const semver = fixture("blocks/semver/forge.block.json") as BlockManifest;

class Plugin {
  readonly a = 1;
}

test("values outside the JSON domain are refused before any schema is evaluated", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const hole: unknown[] = [];
  hole.length = 2;
  const outside: ReadonlyArray<readonly [string, unknown]> = [
    ["undefined", undefined],
    ["a function", () => 1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 1n],
    ["a symbol", Symbol("s")],
    ["a class instance", new Plugin()],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["a cycle", cycle],
    ["a nested undefined", { a: [1, { b: undefined }] }],
    ["a nested function", { a: { b: () => 1 } }],
    ["a sparse array", hole],
  ];
  for (const [label, value] of outside) {
    for (const schema of [true, {}, { type: "object" }] as const) {
      const problems = validateWithSchema(schema, value);
      expect(
        problems.length > 0,
        `${label} under ${JSON.stringify(schema)}`,
      ).toBe(true);
    }
    const registry = new SchemaRegistry([{ $id: "urn:t:any", $defs: {} }]);
    expect(registry.validator("urn:t:any")(value).ok, label).toBe(false);
  }
  expect(
    validateWithSchema({}, { a: [1, "x", null, true, { b: 1.5 }] }),
  ).toEqual([]);
  expect(validateWithSchema(true, Object.create(null))).toEqual([]);
  // a shared (non-cyclic) reference is still JSON
  const shared = { n: 1 };
  expect(validateWithSchema(true, { a: shared, b: shared })).toEqual([]);
  // a very deep value is refused, not a stack overflow
  let deep: unknown = 0;
  for (let i = 0; i < 200_000; i += 1) deep = [deep];
  expect(validateWithSchema(true, deep)).toEqual([]);
  const problems = validateWithSchema({}, { a: [0, Number.NaN] });
  expect(problems[0]?.pointer).toBe("/a/1");
}, 30_000);

const config = (blocks: ConfigDocument["blocks"]): ConfigDocument => ({
  schemaVersion: "forge.config/1",
  blocks,
});

test("a rename key that names no noun of the block is refused", () => {
  const result = resolveComposition(
    config({ one: { source: { path: "a" }, rename: { semvr: "ver" } } }),
    new Map([["one", semver]]),
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors[0]).toMatchObject({ code: "INPUT_INVALID" });
  expect(result.errors[0]?.message).toContain("semvr");
  expect(
    resolveComposition(
      config({ one: { source: { path: "a" }, rename: { semver: "ver" } } }),
      new Map([["one", semver]]),
    ).ok,
  ).toBe(true);
}, 30_000);

const declaration = (
  patch: Partial<OperationDeclaration>,
): OperationDeclaration => ({
  input: "i.json",
  output: "o.json",
  context: "stateless",
  effects: [],
  idempotent: true,
  callers: ["agent", "human"],
  stability: "stable",
  ...patch,
});

test("a deprecation notice names the replacement under the instance's local renames", () => {
  const candidate = (
    op: string,
    patch: Partial<OperationDeclaration>,
    rename?: Readonly<Record<string, string>>,
  ): McpCandidate => ({
    op,
    declaration: declaration(patch),
    admitted: true,
    docs: { title: op, summary: `Does ${op}.` },
    inputSchema: { type: "object" },
    ...(rename === undefined ? {} : { rename }),
  });
  const { tools } = selectMcpTools(
    [
      candidate(
        "ver.old",
        {
          stability: "deprecated",
          deprecated: { since: "0.1.0", use: "semver.new" },
        },
        { semver: "ver" },
      ),
      candidate("ver.new", {}),
    ],
    { expose: ["ver"] },
  );
  const old = tools.find((t) => t.name === "ver_old");
  expect(old?.description).toContain("use ver_new");
  expect(old?.description).not.toContain("semver_new");
}, 30_000);

test("a provider that contradicts the interface's idempotence does not conform", () => {
  const doc = {
    id: "forge.thing",
    operations: {
      put: {
        input: "i.json",
        output: "o.json",
        context: "stateless",
        access: "write",
        idempotent: false,
      },
    },
  } as unknown as InterfaceDocument;
  const manifest = (idempotent: boolean): BlockManifest =>
    ({
      operations: {
        "thing.put": declaration({ effects: ["thing:write"], idempotent }),
      },
    }) as unknown as BlockManifest;
  expect(
    checkProvidedInterface(manifest(false), "forge.thing@1.0.0", "thing", doc),
  ).toEqual([]);
  const problems = checkProvidedInterface(
    manifest(true),
    "forge.thing@1.0.0",
    "thing",
    doc,
  );
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain("idempotent");
}, 30_000);

test("a rejected open closes everything already opened and still rejects", async () => {
  const log: string[] = [];
  const owned = (name: string): LifetimeProvider<string, undefined> => ({
    open: () =>
      Promise.resolve({
        ok: true,
        handle: {
          ownership: "owned",
          value: name,
          close: () => {
            log.push(`close ${name}`);
            return Promise.resolve();
          },
        },
      }),
  });
  const exploding: LifetimeProvider<string, undefined> = {
    open: () => Promise.reject(new Error("disk went away")),
  };
  const error = await openAll([
    step(owned("store"), undefined),
    step(owned("process"), undefined),
    step(exploding, undefined),
  ]).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("disk went away");
  expect(log).toEqual(["close process", "close store"]);
}, 30_000);

test("a very large flat array is walked or refused by the budget, never a stack overflow", () => {
  const text = `[${"0,".repeat(500_000)}0]`;
  expect(text.length).toBeLessThan(1_048_576);
  expect(parseUntrustedJson(text)).toMatchObject({
    ok: false,
    error: { code: "LIMIT_EXCEEDED" },
  });
  // with room in every budget a flat array larger than any engine's argument limit parses cleanly
  const roomy = {
    maxBytes: 100_000_000,
    maxDepth: 64,
    maxNodes: 10_000_000,
    maxStringLength: 1000,
  };
  const million = `[${"0,".repeat(2_000_000)}0]`;
  expect(parseUntrustedJson(million, roomy).ok).toBe(true);
  expect(
    parseUntrustedJson(million, { ...roomy, maxNodes: 1_000_000 }),
  ).toMatchObject({ ok: false, error: { code: "LIMIT_EXCEEDED" } });
  expect(parseUntrustedJson(`[${"0,".repeat(999)}0]`).ok).toBe(true);
}, 30_000);
