import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import type { McpTransportPort } from "../../src/ports/mcp-transport.ts";
import { runCommand } from "../../src/surface/command.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { candidate, fakeCatalog } from "./fixtures/catalog.ts";

const eras = ["2025-11-25", "2026-07-28"] as const;

type RpcReply = {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown };
};

function toolNames(reply: RpcReply): string[] {
  const result = reply.result as
    { readonly tools?: readonly { readonly name?: unknown }[] } | undefined;
  return result?.tools?.map((tool) => String(tool.name)) ?? [];
}

async function exchange(
  era: (typeof eras)[number],
  readOnly: boolean,
  run: (
    rpc: (
      method: string,
      params?: Record<string, unknown>,
    ) => Promise<RpcReply>,
  ) => Promise<void>,
): Promise<void> {
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const opened = await createMcpTransport().open({
    handlers: createMcpHandlers(
      fakeCatalog([
        candidate("sample.read"),
        candidate("sample.write", { effects: ["external:network"] }),
      ]),
      readOnly ? { readOnly: true } : {},
    ),
    serverName: "safe",
    serverVersion: "0.0.0",
    input: input.readable,
    output: output.writable,
  });
  if (!opened.ok) throw new Error("transport refused to open");
  const writer = input.writable.getWriter();
  const reader = output.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let id = 0;
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<RpcReply> => {
    const requestId = ++id;
    if (era === "2026-07-28")
      params._meta = {
        "io.modelcontextprotocol/protocolVersion": era,
        "io.modelcontextprotocol/clientInfo": {
          name: "safe",
          version: "0.0.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {},
      };
    await writer.write(
      encoder.encode(
        `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`,
      ),
    );
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        const reply = JSON.parse(buffer.slice(0, newline)) as RpcReply;
        buffer = buffer.slice(newline + 1);
        if (reply.id === requestId) return reply;
      } else {
        const next = await reader.read();
        if (next.done) throw new Error("transport closed early");
        buffer += decoder.decode(next.value, { stream: true });
      }
    }
  };
  try {
    if (era === "2025-11-25") {
      await rpc("initialize", {
        protocolVersion: era,
        capabilities: {},
        clientInfo: { name: "safe", version: "0.0.0" },
      });
      await writer.write(
        encoder.encode(
          '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
        ),
      );
    } else {
      await rpc("server/discover");
    }
    await run(rpc);
  } finally {
    await reader.cancel();
    await opened.handle.close();
  }
}

test("mcp open refusal reports on stderr and leaves stdout empty", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  errors.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const mcp: McpTransportPort = {
    open: () =>
      Promise.resolve({
        ok: false as const,
        unavailable: {
          kind: "unavailable" as const,
          reason: "streams closed",
          remedy: "reopen streams",
        },
      }),
  };
  const exit = await runCommand(["--mcp"], {
    catalog: fakeCatalog(),
    version: "0.0.0",
    input,
    output,
    errorOutput: errors,
    mcp,
  });
  expect(exit).not.toBe(0);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr)).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE" },
  });
  input.destroy();
  output.destroy();
  errors.destroy();
}, 30_000);

test("mcp transport reports failed opens instead of throwing", async () => {
  const opened = await createMcpTransport().open({
    handlers: createMcpHandlers(fakeCatalog()),
    serverName: "safe",
    serverVersion: "0.0.0",
    input: null as unknown as ReadableStream<Uint8Array>,
    output: null as unknown as WritableStream<Uint8Array>,
  });
  expect(opened.ok).toBe(false);
}, 30_000);

test("hidden and unknown tool names share the unknown-tool error", async () => {
  for (const era of eras) {
    await exchange(era, true, async (rpc) => {
      for (const call of [
        { name: "sample_write" },
        { name: "never_existed" },
        { name: "block_add", arguments: { path: "./hello" } },
      ] as const) {
        const reply = await rpc("tools/call", { ...call });
        const name = call.name;
        expect({ era, name, code: reply.error?.code }).toEqual({
          era,
          name,
          code: -32602,
        });
        expect({ era, name, result: reply.result ?? null }).toEqual({
          era,
          name,
          result: null,
        });
      }
    });
  }
}, 30_000);

test("unissued cursors fail while absent and empty cursors list", async () => {
  for (const era of eras) {
    await exchange(era, false, async (rpc) => {
      const full = toolNames(await rpc("tools/list"));
      expect({
        era,
        read: full.includes("sample_read"),
        write: full.includes("sample_write"),
      }).toEqual({ era, read: true, write: true });
      const empty = toolNames(await rpc("tools/list", { cursor: "" }));
      expect({
        era,
        read: empty.includes("sample_read"),
        write: empty.includes("sample_write"),
      }).toEqual({ era, read: true, write: true });
      const rejected = await rpc("tools/list", { cursor: "unissued-cursor" });
      expect({ era, code: rejected.error?.code }).toEqual({
        era,
        code: -32602,
      });
    });
  }
}, 30_000);

test("invalid input and hidden targets stay domain failures", async () => {
  await exchange("2025-11-25", true, async (rpc) => {
    const bad = await rpc("tools/call", {
      name: "catalog_describe",
      arguments: {},
    });
    expect(bad.error ?? null).toBeNull();
    expect(bad.result ?? null).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "INPUT_INVALID" } },
    });
    const gated = await rpc("tools/call", {
      name: "catalog_describe",
      arguments: { op: "sample.write" },
    });
    expect(gated.error ?? null).toBeNull();
    expect(gated.result ?? null).toMatchObject({
      isError: true,
      structuredContent: { ok: false, error: { code: "UNKNOWN_COMMAND" } },
    });
  });
}, 30_000);
