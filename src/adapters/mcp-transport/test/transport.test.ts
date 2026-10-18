import { expect, test } from "bun:test";
import { createMcpTransport } from "../index.ts";
import { createMcpHandlers } from "../../../surface/mcp.ts";
import { fakeCatalog } from "../../../../test/surface/fixtures/catalog.ts";

for (const era of ["2025-11-25", "2026-07-28"]) {
  test(`SDK stdio protocol journey: ${era}`, async () => {
    const input = new TransformStream<Uint8Array, Uint8Array>();
    const output = new TransformStream<Uint8Array, Uint8Array>();
    const writer = input.writable.getWriter();
    const reader = output.readable.getReader();
    const opened = await createMcpTransport().open({
      handlers: createMcpHandlers(fakeCatalog()),
      serverName: "fixture",
      serverVersion: "1.0.0",
      input: input.readable,
      output: output.writable,
    });
    if (!opened.ok) throw new Error(opened.unavailable.reason);
    const decoder = new TextDecoder();
    let buffer = "";
    let id = 0;
    const rpc = async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      const requestId = ++id;
      const meta =
        era === "2026-07-28"
          ? {
              "io.modelcontextprotocol/protocolVersion": era,
              "io.modelcontextprotocol/clientInfo": {
                name: "fixture",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            }
          : {};
      await writer.write(
        new TextEncoder().encode(
          `${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params: { ...params, ...(era === "2026-07-28" ? { _meta: meta } : {}) } })}\n`,
        ),
      );
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const message = JSON.parse(buffer.slice(0, newline)) as Record<
            string,
            unknown
          >;
          buffer = buffer.slice(newline + 1);
          if (message.id === requestId) return message;
        } else {
          const next = await reader.read();
          if (next.done) throw new Error("Unexpected EOF");
          buffer += decoder.decode(next.value, { stream: true });
        }
      }
    };
    try {
      if (era === "2025-11-25") {
        expect(
          await rpc("initialize", {
            protocolVersion: era,
            capabilities: {},
            clientInfo: { name: "fixture", version: "1.0.0" },
          }),
        ).toMatchObject({ result: { protocolVersion: era } });
        await writer.write(
          new TextEncoder().encode(
            '{"jsonrpc":"2.0","method":"notifications/initialized"}\n',
          ),
        );
      } else {
        expect(await rpc("server/discover")).toMatchObject({
          result: {
            _meta: {
              "io.modelcontextprotocol/serverInfo": { name: "fixture" },
            },
            supportedVersions: [era],
          },
        });
      }
      const listing = await rpc("tools/list");
      expect(listing.error).toBeUndefined();
      expect(JSON.stringify(listing.result)).toContain('"name":"sample_echo"');
      expect(
        await rpc("tools/call", {
          name: "sample_echo",
          arguments: { value: "hello" },
        }),
      ).toMatchObject({
        result: {
          isError: false,
          structuredContent: { ok: true, result: { value: "hello" } },
        },
      });
      expect(
        await rpc("tools/call", { name: "missing", arguments: {} }),
      ).toMatchObject({ error: { code: -32602 } });
      expect(
        await rpc("tools/call", {
          name: "catalog_call",
          arguments: { op: "missing.op" },
        }),
      ).toMatchObject({
        result: { isError: true, structuredContent: { ok: false } },
      });
    } finally {
      await reader.cancel();
      await opened.handle.close();
      await opened.handle.close();
      writer.releaseLock();
      reader.releaseLock();
    }
  }, 10_000);
}
