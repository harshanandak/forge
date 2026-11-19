import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssembly } from "../../../src/assembly/index.ts";
import { assemblyMcp } from "../../../src/assembly/mcp.ts";

test("MCP open returns unavailable with the trust store path and remedy", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-trust-"));
  const deviceRoot = join(root, "device");
  const storePath = join(deviceRoot, "trust.sqlite");
  mkdirSync(storePath, { recursive: true });
  const assembly = await createAssembly({ root, deviceRoot });
  try {
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
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable.kind).toBe("unavailable");
      expect(result.unavailable.reason).toContain(storePath);
      expect(result.unavailable.reason).toContain("move or delete it");
      expect(result.unavailable.remedy).toBe(
        "Use a supported runtime and a readable local store path",
      );
    }
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test.each([
  ["a too-long tool prefix", { readOnly: true, toolPrefix: "a".repeat(65) }],
  ["an invalid budget", { readOnly: true, budget: -1 }],
  ["an unknown field", { readOnly: true, future: true }],
  ["a non-object MCP section", null],
])(
  "MCP refuses to open with %s",
  async (_name, mcp) => {
    const root = mkdtempSync(join(tmpdir(), "forge-invalid-mcp-"));
    mkdirSync(join(root, ".forge"));
    writeFileSync(
      join(root, ".forge/config.yaml"),
      JSON.stringify({ blocks: { memory: {} }, mcp }),
    );
    const assembly = await createAssembly({
      root,
      deviceRoot: join(root, "device"),
    });
    try {
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
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.unavailable.reason).toContain(".forge/config.yaml");
    } finally {
      await assembly.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

test("invalid MCP config does not activate device-memory recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-memory-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({ blocks: {}, mcp: { readOnly: true, budget: -1 } }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    const result = await assembly.catalog.invoke({
      schemaVersion: "forge.invocation/1",
      requestId: "memory-should-stay-disabled",
      op: "memory.add",
      input: { text: "synthetic note", level: "device", scope: "general" },
      caller: "agent",
      context: { actor: { kind: "agent", id: "test" } },
    });
    expect(result.ok).toBe(false);
    expect(result.warnings.map(({ code }) => code)).not.toContain(
      "PROJECT_CONFIG_UNAVAILABLE",
    );
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("unrelated config exclusions keep valid MCP exposure", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-exposure-"));
  mkdirSync(join(root, ".forge"));
  const exposure = { readOnly: true, expose: ["memory.search"], budget: 1 };
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({ blocks: {}, mcp: exposure, templates: [null] }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
  });
  try {
    expect(assembly.exposure).toEqual(exposure);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
