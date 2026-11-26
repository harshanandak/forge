import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createMcpHandlers } from "../../../src/surface/mcp.ts";
import {
  createReport,
  reportBlock,
  reportFixture,
  reportMessage,
} from "./fixtures.ts";

test("configured device report is admitted and counts repeats across reopened assemblies", async () => {
  using f = reportFixture();
  const started = Date.now();
  f.configure({ blocks: { report: reportBlock } });
  for (const count of [1, 2])
    await f.withAssembly(async ({ assembly, cli }) => {
      const [entry, ...rest] = assembly.catalog
        .list()
        .filter(({ blockId }) => blockId === "forge/report");
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({
        op: "report.create",
        declaredOp: "report.create",
        builtin: true,
        admitted: true,
        declaration: {
          context: "device",
          stability: "experimental",
          effects: ["report:write"],
        },
        inputSchema: { additionalProperties: false },
      });
      const reply = await cli(createReport);
      expect(reply.exitCode).toBe(0);
      expect(reply.envelope).toMatchObject({
        ok: true,
        status: "OK",
        op: "report.create",
        result: {
          count,
          promotion: "unpromoted",
        },
      });
      expect(
        (reply.envelope.result as { fingerprint: string }).fingerprint,
      ).toMatch(/^fp1:[a-f0-9]{64}$/);
    });
  const { rows, events, memory } = await f.read();
  expect(rows).toMatchObject([
    {
      value: {
        count: 2,
        summary: reportMessage,
        context: {
          os: process.platform,
          harness: "cli",
        },
      },
    },
  ]);
  const { firstSeen, lastSeen, context } = rows![0]!.value as {
    firstSeen: string;
    lastSeen: string;
    context: { forgeVersion: string };
  };
  expect(context.forgeVersion).toMatch(/^\d+\.\d+\.\d+$/);
  expect(Date.parse(firstSeen)).toBeGreaterThanOrEqual(started);
  expect(Date.parse(lastSeen)).toBeGreaterThanOrEqual(Date.parse(firstSeen));
  expect(events).toHaveLength(2);
  expect(memory).toEqual([]);
  expect(f.wroteProject).toBe(false);
}, 30_000);

test("default device filing survives absent or malformed project configuration", async () => {
  using f = reportFixture();
  const file = join(f.root, ".forge/config.yaml");
  const broken = "blocks: [broken";
  for (const [count, config] of [
    [1, undefined],
    [2, broken],
  ] as const) {
    if (config) f.configure(config);
    await f.withAssembly(async ({ cli }) => {
      const reply = await cli(createReport);
      expect(reply.envelope).toMatchObject({ ok: true, result: { count } });
      expect(reply.exitCode).toBe(0);
    });
    expect(existsSync(file) ? readFileSync(file, "utf8") : undefined).toBe(
      config,
    );
    expect(f.wroteProject).toBe(false);
  }
}, 30_000);

test("default filing survives malformed and unsafe optional project manifests", async () => {
  using f = reportFixture();
  const path = join(f.root, ".forge/project.json");
  f.configure({ blocks: {} });
  for (const [count, contents] of [
    [1, "{broken"],
    [2, '{"schema":1,"id":"invalid"}'],
    [3, undefined],
  ] as const) {
    if (contents) writeFileSync(path, contents);
    else {
      unlinkSync(path);
      mkdirSync(path);
    }
    await f.withAssembly(async ({ cli }) => {
      expect((await cli(createReport)).envelope).toMatchObject({
        ok: true,
        result: { count },
      });
    });
    if (contents) expect(readFileSync(path, "utf8")).toBe(contents);
    else expect(existsSync(path)).toBe(true);
  }
}, 30_000);

test("report validation and MCP opt-in run before any write", async () => {
  using f = reportFixture();
  for (const mcp of [{}, { expose: ["report.create"], readOnly: true }]) {
    f.configure({ blocks: {}, mcp });
    await f.withAssembly(async ({ assembly, options, cli }) => {
      const handlers = createMcpHandlers(
        assembly.mcpCatalog,
        assembly.exposure,
        options,
      );
      expect(
        handlers.listTools().some(({ name }) => name === "report_create"),
      ).toBe(false);
      for (const input of [
        {},
        { message: "" },
        { message: "   " },
        { message: "one\ntwo" },
        { message: "one\u2028two" },
        { message: "x".repeat(4097) },
        { message: "Valid", kind: "unknown" },
        { message: "Valid", PrivateFieldFixture: true },
      ]) {
        const reply = await cli([
          "report",
          "create",
          "--input",
          JSON.stringify(input),
        ]);
        expect(reply.exitCode).toBe(6);
        expect(reply.envelope).toMatchObject({
          ok: false,
          op: "report.create",
          error: { code: "INPUT_INVALID" },
        });
        expect(reply.stdout.includes("PrivateFieldFixture")).toBe(false);
      }
    });
  }
  expect(existsSync(f.records)).toBe(false);
  f.configure({ mcp: { expose: "broken" } });
  await f.withAssembly(({ assembly }) => {
    expect(() => assembly.exposure).toThrow();
    return Promise.resolve();
  });
}, 30_000);
