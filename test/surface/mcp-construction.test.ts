import { expect, test } from "bun:test";
import type { McpCandidate } from "../../src/contract/mcp.ts";
import type { McpExposure } from "../../src/generated/types.ts";
import type { SurfaceCatalog } from "../../src/surface/catalog.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { failure } from "../../src/surface/result.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

test("MCP construction reads one candidate list regardless of selected tool count", () => {
  for (const count of [0, 1, 4]) {
    for (const exposure of [
      {},
      { budget: 0 },
      { budget: 1 },
      { readOnly: true, toolPrefix: "forge" },
    ] satisfies McpExposure[]) {
      let reads = 0;
      const entries = Array.from({ length: count }, (_, i) =>
        candidate(`sample.op${i}`),
      );
      const catalog: SurfaceCatalog = {
        ...fakeCatalog(entries),
        list: () => {
          reads++;
          return entries;
        },
      };
      const handlers = createMcpHandlers(catalog, exposure);
      expect(reads).toBe(1);
      handlers.listTools();
      handlers.listTools();
      expect(reads).toBe(1);
    }
  }
}, 30_000);

test("separate MCP constructions refresh admission, candidates and configured metadata", async () => {
  let entries: readonly McpCandidate[] = [{ ...candidate(), admitted: false }];
  const catalog: SurfaceCatalog = { ...fakeCatalog(), list: () => entries };
  const hidden = createMcpHandlers(catalog);
  expect(hidden.listTools().map((tool) => tool.name)).not.toContain(
    "sample_echo",
  );
  expect(
    JSON.stringify(await hidden.callTool("catalog_list", {})),
  ).not.toContain("sample.echo");

  const configured = {
    ...candidate(),
    docs: { title: "Configured", summary: "Fresh config" },
    inputSchema: { type: "object", properties: { fresh: { type: "boolean" } } },
  };
  entries = [configured, candidate("fresh.inspect")];
  const admitted = createMcpHandlers(catalog);
  expect(
    admitted.listTools().find((tool) => tool.name === "sample_echo"),
  ).toMatchObject({
    title: "Configured",
    description: "Fresh config",
    inputSchema: configured.inputSchema,
  });
  expect(admitted.listTools().map((tool) => tool.name)).toContain(
    "fresh_inspect",
  );
  expect(
    await admitted.callTool("catalog_describe", { op: "sample.echo" }),
  ).toMatchObject({ ok: true, result: configured });

  entries = [{ ...configured, admitted: false }];
  const revoked = createMcpHandlers(catalog);
  expect(revoked.listTools().map((tool) => tool.name)).not.toContain(
    "sample_echo",
  );
  expect(revoked.listTools().map((tool) => tool.name)).not.toContain(
    "fresh_inspect",
  );
  expect(
    await revoked.callTool("catalog_describe", { op: "sample.echo" }),
  ).toMatchObject({ ok: false, error: { code: "UNKNOWN_COMMAND" } });
}, 30_000);

test("one construction preserves prefixed selection, overflow discovery and read-only hiding", async () => {
  const catalog = fakeCatalog([
    candidate("sample.alpha"),
    candidate("sample.overflow"),
    candidate("sample.write", { effects: ["external:network"] }),
    candidate("sample.private", { callers: ["human"] }),
    candidate("other.hidden"),
  ]);
  const handlers = createMcpHandlers(catalog, {
    budget: 1,
    toolPrefix: "forge",
    expose: ["sample"],
    readOnly: true,
  });
  const names = handlers.listTools().map((tool) => tool.name);
  expect(names).toContain("forge_sample_alpha");
  expect(names).toContain("catalog_list");
  expect(names).toContain("catalog_describe");
  expect(names).not.toContain("forge_sample_overflow");
  expect(names).not.toContain("forge_sample_write");
  expect(
    await handlers.callTool("forge_sample_alpha", { value: "direct" }),
  ).toMatchObject({ ok: true, op: "sample.alpha" });
  expect(
    await handlers.callTool("catalog_describe", { op: "sample.overflow" }),
  ).toMatchObject({ ok: true, result: { op: "sample.overflow" } });
  const listed = JSON.stringify(await handlers.callTool("catalog_list", {}));
  expect(listed).toContain("sample.overflow");
  for (const op of ["sample.write", "sample.private", "other.hidden"]) {
    expect(listed).not.toContain(op);
    expect(await handlers.callTool("catalog_describe", { op })).toMatchObject({
      ok: false,
      error: { code: "UNKNOWN_COMMAND" },
    });
  }
  expect(await handlers.callTool("forge_sample_write", {})).toMatchObject({
    ok: false,
    error: { code: "UNKNOWN_COMMAND" },
  });
  expect(catalog.calls).toHaveLength(1);
  const overflow = createMcpHandlers(catalog, {
    budget: 0,
    toolPrefix: "forge",
    expose: ["sample"],
  });
  expect(
    await overflow.callTool("catalog_call", {
      op: "sample.overflow",
      input: { value: "overflow" },
    }),
  ).toMatchObject({ ok: true, op: "sample.overflow" });
}, 30_000);

test("MCP calls retain live invocation forwarding and canonical runtime refusals", async () => {
  const calls: Parameters<SurfaceCatalog["invoke"]>[0][] = [];
  let refusal = failure("ADMISSION_REQUIRED", "Current trust refused");
  const catalog: SurfaceCatalog = {
    list: () => [candidate()],
    invoke: (request) => {
      calls.push(request);
      return Promise.resolve(refusal);
    },
  };
  const context = {
    actor: { kind: "agent" as const, id: "tester" },
    session: { id: "session" },
  };
  const handlers = createMcpHandlers(
    catalog,
    {},
    { context, requestId: "forwarded", dryRun: true },
  );
  for (const code of [
    "ADMISSION_REQUIRED",
    "CONTEXT_MISSING",
    "EFFECT_UNDECLARED",
  ] as const) {
    refusal = failure(code, "Current runtime refused");
    expect(await handlers.callTool("sample_echo", { value: code })).toEqual(
      refusal,
    );
    expect(
      await handlers.callTool("catalog_call", {
        op: "sample.echo",
        input: { value: code },
      }),
    ).toEqual(refusal);
  }
  expect(calls).toHaveLength(6);
  for (const call of calls)
    expect(call).toMatchObject({
      schemaVersion: "forge.invocation/1",
      caller: "agent",
      op: "sample.echo",
      context,
      requestId: "forwarded",
      dryRun: true,
    });
  expect(
    await handlers.callTool("catalog_call", {
      op: "sample.echo",
      requestId: 42,
    }),
  ).toMatchObject({ ok: false, error: { code: "INPUT_INVALID" } });
  expect(calls).toHaveLength(6);
}, 30_000);

test("read-only unknown-name checks still read the live catalog at call time", async () => {
  let entries: readonly McpCandidate[] = [];
  let reads = 0;
  const catalog: SurfaceCatalog = {
    ...fakeCatalog(),
    list: () => {
      reads++;
      return entries;
    },
  };
  const handlers = createMcpHandlers(catalog, { readOnly: true });
  const constructed = reads;
  entries = [candidate("fresh.write", { effects: ["external:network"] })];
  expect(await handlers.callTool("fresh_write", {})).toMatchObject({
    ok: false,
    error: { code: "UNKNOWN_COMMAND" },
  });
  expect(reads).toBe(constructed + 1);
}, 30_000);
