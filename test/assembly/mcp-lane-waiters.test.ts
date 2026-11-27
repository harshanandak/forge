import { expect, spyOn, test } from "bun:test";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import { coordinateLane } from "../../src/assembly/cloud-lane-coordinator.ts";
import { createAssemblyProviders } from "../../src/assembly/providers.ts";
import { LocalState } from "../../src/assembly/state.ts";
import type { Preflight } from "../../src/core/runtime/index.ts";

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("MCP returns cancelled bound-lane slots while the running reservation stays fenced", async () => {
  const root = import.meta.dirname;
  const device = new LocalState(":memory:");
  const open = spyOn(device, "open").mockResolvedValue(undefined);
  const project = {
    origin: "https://fixture.invalid",
    identity: "fixture",
    project: "fixture",
  };
  const providers = createAssemblyProviders(root, { env: {} });
  const flight = {
    request: {
      input: { id: "fixture-1" },
      context: { session: { id: "fixture" } },
    },
    operation: { declaredOp: "lane.next" },
  } as unknown as Preflight;
  const active = new Set<Promise<unknown>>();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queued = Promise.withResolvers<void>();
  let commands = 0;
  const success = {
    ok: true,
    op: "probe",
    status: "OK",
    result: {},
    warnings: [],
  } as const;
  const laneResult = {
    ok: false,
    status: "FAIL",
    error: { code: "NOT_FOUND", message: "No device lane", retry: "never" },
    warnings: [],
  } as const;
  const input = new PassThrough();
  const output = new PassThrough();
  const clientInfo = { name: "fixture", version: "1.0.0" };
  const opened = await createMcpTransport().open({
    serverName: clientInfo.name,
    serverVersion: clientInfo.version,
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
    handlers: {
      listTools: () => [],
      async callTool(name, _args, signal) {
        if (name === "probe") return success;
        const pending = coordinateLane(
          flight,
          project,
          device,
          async () => {
            if (++commands === 1) {
              entered.resolve();
              await release.promise;
            }
            return { id: "fixture-1" };
          },
          {
            providers,
            env: { FORGE_DEVICE_ID: "fixture" },
            deviceRoot: root,
            now: () => 1,
            ...(signal === undefined ? {} : { signal }),
          },
        );
        active.add(pending);
        if (active.size === 8) queued.resolve();
        try {
          await pending;
          return success;
        } catch {
          return laneResult;
        } finally {
          active.delete(pending);
        }
      },
    },
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const lines = createInterface({ input: output });
  const replies = lines[Symbol.asyncIterator]();
  let nextId = 0;
  const send = (method: string, params?: object, id?: number) =>
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`);
  const request = (method: string, params?: object) => {
    send(method, params, ++nextId);
    return nextId;
  };
  const read = async (): Promise<{ id: number }> => {
    const line = await replies.next();
    if (line.done) throw new Error("MCP output closed");
    return JSON.parse(line.value) as { id: number };
  };
  const reply = async (id: number) => {
    const value = await read();
    expect(value).toHaveProperty("id", id);
    return value;
  };
  const call = (name: string) => request("tools/call", { name, arguments: {} });
  const ping = async () => {
    await reply(request("ping"));
    await turn();
  };
  try {
    await reply(
      request("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo,
      }),
    );
    send("notifications/initialized");
    const running = call("lane_next");
    await entered.promise;
    const waiting = Array.from({ length: 7 }, () => call("lane_next"));
    await queued.promise;
    await ping();
    expect(await reply(call("probe"))).toMatchObject({
      result: {
        isError: true,
        structuredContent: { error: { code: "MCP_BUSY" } },
      },
    });
    for (const requestId of waiting)
      send("notifications/cancelled", { requestId });
    await ping();
    expect(await reply(call("probe"))).toMatchObject({
      result: { isError: false },
    });
    expect([active.size, commands, open.mock.calls.length]).toEqual([1, 1, 8]);
    const later = call("lane_next");
    await ping();
    expect([active.size, commands]).toEqual([2, 1]);
    release.resolve();
    const results = [await read(), await read()];
    expect(results.map(({ id }) => id).sort((a, b) => a - b)).toEqual([
      running,
      later,
    ]);
    for (const result of results)
      expect(result).toMatchObject({
        result: { structuredContent: laneResult },
      });
    expect([active.size, commands]).toEqual([0, 2]);
  } finally {
    release.resolve();
    lines.close();
    await opened.handle.close();
    input.end();
    output.end();
    await Promise.allSettled(active);
    open.mockRestore();
    await device.close();
  }
}, 10_000);
