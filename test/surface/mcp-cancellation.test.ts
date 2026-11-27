import { expect, setDefaultTimeout, test } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import type { InvocationRequest } from "../../src/generated/types.ts";
import { createMcpHandlers } from "../../src/surface/mcp.ts";
import { fixture } from "../core/async-handlers/fixture.ts";
import { candidate } from "./fixtures/catalog.ts";

setDefaultTimeout(10_000);

const clientInfo = { name: "fixture", version: "1.0.0" };
const echo = candidate("sample.run");

async function connect(
  era: string,
  handlers: ReturnType<typeof createMcpHandlers>,
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const opened = await createMcpTransport().open({
    handlers,
    serverName: clientInfo.name,
    serverVersion: clientInfo.version,
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  const modern = era === "2026-07-28";
  const meta = {
    "io.modelcontextprotocol/protocolVersion": era,
    "io.modelcontextprotocol/clientInfo": clientInfo,
    "io.modelcontextprotocol/clientCapabilities": {},
  };
  let nextId = 0;
  const send = (method: string, params: object = {}, id?: number) => {
    const message = {
      jsonrpc: "2.0",
      id,
      method,
      params: modern ? { ...params, _meta: meta } : params,
    };
    input.write(JSON.stringify(message) + "\n");
  };
  const request = (method: string, params?: object) => {
    send(method, params, ++nextId);
    return nextId;
  };
  const reply = async (id: number): Promise<unknown> => {
    const message = await replies.next();
    if (message.done) throw new Error("MCP closed before replying");
    const value: unknown = JSON.parse(message.value);
    expect(value).toMatchObject({ id });
    return value;
  };
  const rpc = (method: string, params?: object) =>
    reply(request(method, params));
  const cancel = (id: number) =>
    send("notifications/cancelled", { requestId: id });
  const close = async () => {
    lines.close();
    await opened.handle.close();
    input.end();
    output.end();
  };
  try {
    const initialized = modern
      ? await rpc("server/discover")
      : await rpc("initialize", {
          protocolVersion: era,
          capabilities: {},
          clientInfo,
        });
    expect(initialized).toHaveProperty("result");
    if (!modern) send("notifications/initialized");
    return {
      rpc,
      reply,
      cancel,
      close,
      call: (name: string, args: object) =>
        request("tools/call", { name, arguments: args }),
    };
  } catch (error) {
    await close();
    throw error;
  }
}

for (const era of ["2025-11-25", "2026-07-28"]) {
  for (const via of ["sample_run", "catalog_call"]) {
    test(`MCP ${era} ${via} aborts only its own runtime, closes services and suppresses the reply`, async () => {
      const started = Promise.withResolvers<AbortSignal>();
      const otherStarted = Promise.withResolvers<AbortSignal>();
      const release = Promise.withResolvers<void>();
      const releaseOther = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<unknown>();
      const staged: string[] = [];
      const closed: string[] = [];
      let calls = 0;
      const f = fixture("async ({ services, input }) => services.stage(input)");
      const invoke = (
        request: InvocationRequest,
        ...signals: AbortSignal[]
      ) => {
        const value = (request.input as { value: string }).value;
        calls++;
        const runtime = f.runtime({
          services: (_instance, _context, scope) =>
            Promise.resolve({
              ownership: "owned",
              value: {
                async stage(input: string) {
                  if (input === "cancel") {
                    started.resolve(scope.signal);
                    await release.promise;
                  } else {
                    otherStarted.resolve(scope.signal);
                    await releaseOther.promise;
                  }
                  scope.signal.throwIfAborted();
                  staged.push(input);
                  return input;
                },
              },
              close: () => {
                closed.push(value);
                return Promise.resolve();
              },
            }),
        });
        const result = runtime.invoke(
          { ...request, input: value },
          signals[0] ? { signal: signals[0] } : {},
        );
        if (value === "cancel")
          void result.then(finished.resolve, finished.reject);
        return result;
      };
      const wire = await connect(
        era,
        createMcpHandlers({ list: () => [echo], invoke }),
      );
      try {
        const input = { value: "cancel" };
        const cancelled = wire.call(
          via,
          via === "catalog_call" ? { op: echo.op, input } : input,
        );
        const signal = await started.promise;
        const other = wire.call("sample_run", { value: "other" });
        const otherSignal = await otherStarted.promise;
        wire.cancel(0);
        await wire.rpc("ping");
        expect(signal.aborted).toBe(false);
        wire.cancel(cancelled);
        await wire.rpc("ping");
        expect(signal.aborted).toBe(true);
        expect(otherSignal.aborted).toBe(false);
        release.resolve();
        expect(await finished.promise).toMatchObject({
          error: { code: "INVOCATION_CANCELLED" },
        });
        expect(closed).toEqual(["cancel"]);
        wire.cancel(cancelled);
        releaseOther.resolve();
        expect(await wire.reply(other)).toMatchObject({
          result: { structuredContent: { ok: true, result: "other" } },
        });
        wire.cancel(other);
        await wire.rpc("ping");
        expect([calls, staged, closed]).toEqual([
          2,
          ["other"],
          ["cancel", "other"],
        ]);
      } finally {
        release.resolve();
        releaseOther.resolve();
        await wire.close();
      }
    });
  }

  test(`MCP ${era} refuses excess calls immediately and frees slots after terminal outcomes`, async () => {
    const limit = 8;
    const gates = Array.from({ length: limit + 1 }, () =>
      Promise.withResolvers<void>(),
    );
    const initial = gates.slice(0, limit);
    const held: number[] = [];
    let calls = 0;
    const invoke = async (
      request: InvocationRequest,
      ...signals: AbortSignal[]
    ) => {
      const value = (request.input as { value: string }).value;
      calls++;
      const slot = Number(value);
      const gate = gates[slot];
      if (gate) {
        held.push(slot);
        await gate.promise;
        signals[0]?.throwIfAborted();
        if (slot === 1) throw new Error("fixture failure");
      }
      return {
        ok: true,
        op: request.op,
        status: "OK",
        result: value,
        warnings: [],
      } as const;
    };
    const wire = await connect(
      era,
      createMcpHandlers({ list: () => [echo], invoke }),
    );
    const call = (value: string) => wire.call("sample_run", { value });
    try {
      const ids = initial.map((_gate, slot) => call(String(slot)));
      const busy = {
        result: {
          isError: true,
          structuredContent: {
            error: {
              code: "MCP_BUSY",
              message: expect.stringContaining("retry"),
            },
          },
        },
      };
      expect(await wire.reply(call("overflow"))).toMatchObject(busy);
      expect(held).toEqual(initial.map((_gate, slot) => slot));
      expect(calls).toBe(limit);
      expect(await wire.rpc("tools/list")).toHaveProperty("result.tools");
      expect(await wire.reply(wire.call("catalog_list", {}))).toMatchObject({
        result: { isError: false },
      });
      wire.cancel(ids[0]!);
      expect(await wire.reply(call("while cleaning"))).toMatchObject(busy);
      gates[1]!.resolve();
      expect(await wire.reply(ids[1]!)).toMatchObject({
        result: { isError: true },
      });
      const replacement = call(String(limit));
      await wire.rpc("ping");
      expect(held.at(-1)).toBe(limit);
      gates[0]!.resolve();
      await wire.rpc("ping");
      expect(await wire.reply(call("after cancel"))).toMatchObject({
        result: { isError: false },
      });
      expect(calls).toBe(limit + 2);
      for (const [slot, id] of ids.entries()) {
        if (slot < 2) continue;
        gates[slot]!.resolve();
        expect(await wire.reply(id)).toMatchObject({
          result: { isError: false },
        });
      }
      gates[limit]!.resolve();
      expect(await wire.reply(replacement)).toMatchObject({
        result: { isError: false },
      });
    } finally {
      for (const gate of gates) gate.resolve();
      await wire.close();
    }
  });
}
