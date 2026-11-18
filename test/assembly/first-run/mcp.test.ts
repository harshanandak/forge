import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
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

test("MCP refuses a read-only project with an invalid tool prefix", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-invalid-config-"));
  mkdirSync(join(root, ".forge"));
  writeFileSync(
    join(root, ".forge/config.yaml"),
    JSON.stringify({
      schemaVersion: "forge.config/1",
      blocks: { memory: { source: { builtin: "forge/memory" } } },
      mcp: { readOnly: true, toolPrefix: "a".repeat(65) },
    }),
  );
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
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
    if (result.ok) {
      await result.handle.close();
      throw new Error("MCP started with invalid read-only configuration");
    }
    expect(result.unavailable.reason).toMatch(/INPUT_INVALID.*mcp\.toolPrefix/);
  } finally {
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("MCP refuses tool requests when the config becomes invalid on an open connection", async () => {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-config-change-"));
  mkdirSync(join(root, ".forge"));
  const file = join(root, ".forge/config.yaml");
  writeFileSync(file, JSON.stringify({ blocks: {}, mcp: {} }));
  const assembly = await createAssembly({
    root,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })}\n`,
    );
    const reply = await replies.next();
    if (reply.done) throw new Error(`MCP closed before answering ${method}`);
    const message = JSON.parse(reply.value) as {
      id: number;
      result?: unknown;
      error?: { message: string };
    };
    expect(message.id).toBe(id);
    return message;
  };
  try {
    const opened = await assemblyMcp(assembly).open({
      serverName: "test",
      serverVersion: "1.0.0",
      handlers: {
        listTools: () => [],
        callTool: () => Promise.resolve(undefined),
      },
      input: Readable.toWeb(input),
      output: Writable.toWeb(output),
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    try {
      const initialized = await rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0.0" },
      });
      expect(initialized).toHaveProperty(
        "result.protocolVersion",
        "2025-11-25",
      );
      input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      expect(await rpc("tools/list")).toHaveProperty("result.tools");

      writeFileSync(
        file,
        JSON.stringify({
          blocks: { memory: { source: { builtin: "forge/memory" } } },
          mcp: { readOnly: true, toolPrefix: "a".repeat(65) },
        }),
      );
      const listed = await rpc("tools/list");
      const called = await rpc("tools/call", {
        name: "memory_add",
        arguments: { text: "MCP policy check", level: "device" },
      });
      for (const reply of [listed, called]) {
        expect(reply.result).toBeUndefined();
        expect(reply.error?.message).toMatch(/INPUT_INVALID.*mcp\.toolPrefix/);
      }
    } finally {
      await opened.handle.close();
    }
  } finally {
    lines.close();
    input.end();
    output.end();
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
