import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly } from "../../src/assembly/index.ts";
import { assemblyMcp } from "../../src/assembly/mcp.ts";

const readOnly = { readOnly: true, expose: ["memory.search"] };
const invalid = [
  ["long prefix", { mcp: { ...readOnly, toolPrefix: "a".repeat(65) } }],
  ["invalid budget", { mcp: { ...readOnly, budget: -1 } }],
  ["invalid expose", { mcp: { ...readOnly, expose: 42 } }],
  ["invalid readOnly", { mcp: { readOnly: "true" } }],
  ["unknown field", { mcp: { ...readOnly, unexpected: true } }],
  ["restricted writes", { mcp: { expose: ["memory.search"], budget: -1 } }],
  ["invalid section", { mcp: null }],
  ["invalid version", { schemaVersion: "invalid", mcp: readOnly }],
  ["unrelated error", { mcp: readOnly, runtime: 42 }],
] as const;

for (const [name, fields] of invalid) {
  test(`MCP refuses ${name} before preparing trust or exposing tools`, async () => {
    const root = mkdtempSync(join(tmpdir(), "forge-mcp-config-"));
    const deviceRoot = join(root, "device");
    mkdirSync(join(root, ".forge"));
    const file = join(root, ".forge/config.yaml");
    const text = JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { memory: { source: { builtin: "forge/memory" } } },
      ...fields,
    });
    writeFileSync(file, text);
    const assembly = await createAssembly({
      root,
      deviceRoot,
      providers: { env: {} },
    });
    try {
      expect(() => assembly.exposure).toThrow();
      const result = await assemblyMcp(assembly).open({
        serverName: "test",
        serverVersion: "1.0.0",
        handlers: {
          listTools: () => [],
          callTool: () => Promise.resolve(undefined),
        },
        input: new ReadableStream<Uint8Array>(),
        output: new WritableStream<Uint8Array>(),
      });
      if (result.ok) await result.handle.close();
      expect(result).toMatchObject({
        ok: false,
        unavailable: {
          kind: "unavailable",
          remedy:
            "Run forge config show and repair .forge/config.yaml before starting MCP.",
        },
      });
      expect(existsSync(deviceRoot)).toBe(false);
      for (const op of ["memory.scope", "memory.add"]) {
        const result = await assembly.catalog.invoke({
          schemaVersion: "forge.invocation/1",
          requestId: "invalid-mcp",
          op,
          input: op === "memory.add" ? { text: "must not be written" } : {},
          caller: "agent",
          context: {
            actor: { kind: "agent", id: "test" },
            device: { id: deviceRoot },
          },
        });
        expect(result).toMatchObject({
          ok: false,
          error: { code: "INPUT_INVALID" },
        });
        expect(result.warnings).not.toContainEqual(
          expect.objectContaining({ code: "PROJECT_CONFIG_UNAVAILABLE" }),
        );
      }
      expect(readFileSync(file, "utf8")).toBe(text);
      expect(existsSync(deviceRoot)).toBe(false);
      writeFileSync(file, JSON.stringify({ blocks: {}, mcp: readOnly }));
      expect(assembly.exposure).toEqual(readOnly);
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("MCP exposure defaults remain available without a project config", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-no-config-"));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    expect(assembly.exposure).toEqual({});
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
});
