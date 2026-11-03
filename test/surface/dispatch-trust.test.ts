import { expect, test } from "bun:test";
import type { Caller } from "../../src/generated/types.ts";
import { runCli } from "../../src/surface/cli.ts";
import { dispatch, record, visible } from "../../src/surface/dispatch.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("declared caller lists admit exactly their callers before invocation", async () => {
  for (const callers of [
    ["agent"],
    ["human"],
    ["human", "agent"],
    [],
  ] as const) {
    for (const caller of ["human", "agent"] as const) {
      const entry = candidate("sample.echo", { callers });
      const catalog = fakeCatalog([entry]);
      const allowed = (callers as readonly Caller[]).includes(caller);
      const input = { value: "hello" };
      const direct = await dispatch(catalog, entry.op, input, { caller });
      const cli = await runCli(
        catalog,
        [entry.op, "--input", JSON.stringify(input)],
        { caller },
      );
      const overflow = await dispatch(
        catalog,
        "catalog.call",
        { op: entry.op, input },
        { caller },
      );
      for (const result of [direct, cli.envelope, overflow]) {
        expect(result).toMatchObject(
          allowed
            ? { ok: true, result: input }
            : { ok: false, error: { code: "UNKNOWN_COMMAND" } },
        );
      }
      expect(catalog.calls).toHaveLength(allowed ? 3 : 0);
      expect(visible(catalog, caller).some(({ op }) => op === entry.op)).toBe(
        allowed,
      );
    }
  }
}, 30_000);

test("an undeclared caller list keeps the human surface default", async () => {
  const entry = candidate();
  const { callers: _callers, ...declaration } = entry.declaration;
  const catalog = fakeCatalog([
    { ...entry, declaration: declaration as typeof entry.declaration },
  ]);
  expect(
    await dispatch(catalog, entry.op, { value: "hello" }, { caller: "human" }),
  ).toMatchObject({ ok: true, result: { value: "hello" } });
  expect(visible(catalog, "human").some(({ op }) => op === entry.op)).toBe(
    true,
  );
  expect(catalog.calls).toHaveLength(1);
}, 30_000);

const malformed: readonly {
  readonly op: string;
  readonly input: unknown;
  readonly pointer: string;
  readonly keyword: string;
}[] = [
  { op: "catalog.list", input: null, pointer: "", keyword: "type" },
  { op: "catalog.list", input: [], pointer: "", keyword: "type" },
  {
    op: "catalog.list",
    input: { unexpected: true },
    pointer: "/unexpected",
    keyword: "additionalProperties",
  },
  { op: "catalog.describe", input: null, pointer: "", keyword: "type" },
  { op: "catalog.describe", input: {}, pointer: "/op", keyword: "required" },
  {
    op: "catalog.describe",
    input: { op: 3 },
    pointer: "/op",
    keyword: "type",
  },
  {
    op: "catalog.describe",
    input: { op: "sample.echo", unexpected: true },
    pointer: "/unexpected",
    keyword: "additionalProperties",
  },
  { op: "catalog.call", input: null, pointer: "", keyword: "type" },
  { op: "catalog.call", input: [], pointer: "", keyword: "type" },
  { op: "catalog.call", input: {}, pointer: "/op", keyword: "required" },
  { op: "catalog.call", input: { op: 3 }, pointer: "/op", keyword: "type" },
  {
    op: "catalog.call",
    input: { op: "sample.echo", unexpected: true },
    pointer: "/unexpected",
    keyword: "additionalProperties",
  },
  ...["dryRun", "context", "requestId", "schemaVersion", "caller"].map(
    (field) => ({
      op: "catalog.call",
      input: { op: "sample.echo", [field]: 3 },
      pointer: `/${field}`,
      keyword:
        field === "schemaVersion"
          ? "const"
          : field === "caller"
            ? "enum"
            : "type",
    }),
  ),
];

for (const route of ["MCP", "CLI --input"] as const) {
  for (const { op, input, pointer, keyword } of malformed) {
    test(`${route} validates ${op} input ${JSON.stringify(input)}`, async () => {
      const catalog = fakeCatalog();
      const result =
        route === "MCP"
          ? await createMcpHandlers(catalog).callTool(
              op.replaceAll(".", "_"),
              input,
            )
          : (await runCli(catalog, [op, "--input", JSON.stringify(input)]))
              .envelope;
      expect(result).toMatchObject({
        ok: false,
        error: {
          code: "INPUT_INVALID",
          retry: "never",
        },
      });
      if (result === undefined || result.ok)
        throw new Error("Expected refusal");
      expect(record(result.error.observed)?.problems).toEqual(
        expect.arrayContaining([expect.objectContaining({ pointer, keyword })]),
      );
      expect(catalog.calls).toHaveLength(0);
    }, 30_000);
  }
}

test("valid catalog inputs retain discovery and shorthand invocation defaults", async () => {
  for (const route of ["MCP", "CLI --input"] as const) {
    const catalog = fakeCatalog();
    for (const [op, input] of [
      ["catalog.list", {}],
      ["catalog.describe", { op: "sample.echo" }],
      ["catalog.call", { op: "sample.echo" }],
    ] as const) {
      const result =
        route === "MCP"
          ? await createMcpHandlers(catalog).callTool(
              op.replaceAll(".", "_"),
              input,
            )
          : (await runCli(catalog, [op, "--input", JSON.stringify(input)]))
              .envelope;
      expect(result).toMatchObject({ ok: true });
    }
    expect(catalog.calls).toHaveLength(1);
    expect(catalog.calls[0]).toMatchObject({
      op: "sample.echo",
      input: {},
      context: {},
      caller: "agent",
      schemaVersion: "forge.invocation/1",
    });
  }
}, 30_000);
