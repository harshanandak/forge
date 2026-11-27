import { expect, spyOn, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough, Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createMcpTransport } from "../../src/adapters/mcp-transport/index.ts";
import * as sqlite from "../../src/adapters/store-sqlite/index.ts";
import { blockCapture } from "../../src/assembly/capture.ts";
import { firstPartyBlocks } from "../../src/assembly/first-party.ts";
import { createAssembly, localContext } from "../../src/assembly/index.ts";
import { LocalState } from "../../src/assembly/state.ts";
import { StateOwner } from "../../src/core/state/index.ts";
import type {
  InvocationRequest,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import type { McpHandlers } from "../../src/ports/mcp-transport.ts";

const defer = () => Promise.withResolvers<void>();
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function withAssembly(
  run: (
    root: string,
    create: (signal?: AbortSignal) => Promise<ResultEnvelope>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "forge-mcp-preparation-"));
  const project = join(root, "project");
  mkdirSync(join(project, ".forge"), { recursive: true });
  writeFileSync(
    join(project, ".forge/config.yaml"),
    "blocks:\n  work:\n    source:\n      builtin: forge/work\n",
  );
  const source = fileURLToPath(firstPartyBlocks["forge/work"]!);
  const built = fileURLToPath(
    new URL("../../dist/src/blocks/work/", import.meta.url),
  );
  const open = blockCapture.open.bind(blockCapture);
  const capture = spyOn(blockCapture, "open").mockImplementation((path) =>
    open(path === source ? built : path),
  );
  const assembly = await createAssembly({
    root: project,
    deviceRoot: join(root, "device"),
    providers: { env: {} },
  });
  let count = 0;
  const create = (signal?: AbortSignal) => {
    const request: InvocationRequest = {
      schemaVersion: "forge.invocation/1",
      requestId: `request-${++count}`,
      op: "issue.create",
      input: { title: "Test cancellation" },
      caller: "agent",
      context: localContext(assembly, { kind: "agent", id: "test" }),
    };
    return assembly.mcpCatalog.invoke(request, signal);
  };
  try {
    expect(assembly.mcpCatalog.list().map(({ op }) => op)).toContain(
      "issue.create",
    );
    await run(root, create);
  } finally {
    capture.mockRestore();
    await assembly.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function transport(callTool: McpHandlers["callTool"]) {
  const name = "fixture";
  const version = "1.0.0";
  const input = new PassThrough();
  const output = new PassThrough();
  const opened = await createMcpTransport().open({
    handlers: { listTools: () => [], callTool },
    serverName: name,
    serverVersion: version,
    input: Readable.toWeb(input),
    output: Writable.toWeb(output),
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
  const reply = async (id: number): Promise<unknown> => {
    const line = await replies.next();
    if (line.done) throw new Error("MCP output closed");
    const value: unknown = JSON.parse(line.value);
    expect(value).toHaveProperty("id", id);
    return value;
  };
  const rpc = (method: string, params?: object) =>
    reply(request(method, params));
  await rpc("initialize", {
    protocolVersion: "2025-11-25",
    clientInfo: { name, version },
    capabilities: {},
  });
  send("notifications/initialized");
  const call = (tool: string) =>
    request("tools/call", { name: tool, arguments: {} });
  return {
    call,
    reply,
    async ping() {
      await rpc("ping");
      await turn();
    },
    cancel: (requestId: number) =>
      send("notifications/cancelled", { requestId }),
    async close() {
      lines.close();
      await opened.handle.close();
      input.end();
      output.end();
    },
  };
}

test("abort during local preparation prevents project registration and staged store publication", async () => {
  await withAssembly(async (root, create) => {
    const ready = defer();
    const release = defer();
    const controller = new AbortController();
    const native = sqlite.openDeviceRecordStore;
    const open = spyOn(sqlite, "openDeviceRecordStore").mockImplementation(
      async (...args) => {
        const result = await native(...args);
        if (!args[1]) {
          ready.resolve();
          await release.promise;
        }
        return result;
      },
    );
    const put = spyOn(StateOwner.prototype, "put");
    const started = create(controller.signal);
    try {
      await Promise.race([
        ready.promise,
        started.then((result) => {
          throw new Error(
            `Issue creation stopped before opening the registry: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      controller.abort();
      release.resolve();
      expect(await started).toMatchObject({
        error: { code: "INVOCATION_CANCELLED" },
      });
      await turn();
      const registrations = put.mock.calls.filter(
        ([namespace]) => namespace === "forge/core-projects",
      ).length;

      const path = join(root, "recovery.sqlite");
      const state = new LocalState(path);
      const recovery = new AbortController();
      const initialize = async (staged: LocalState) => {
        await staged.open(true);
        recovery.abort();
      };
      const recover = state.create.bind(state) as (
        init: typeof initialize,
        signal: AbortSignal,
      ) => Promise<void>;
      const aborted = await recover(initialize, recovery.signal).then(
        () => false,
        () => true,
      );
      await state.close();
      expect({
        registrations,
        aborted,
        published: existsSync(path),
        staging: readdirSync(root).filter((name) =>
          name.startsWith("recovery.sqlite.reinit-"),
        ),
      }).toEqual({
        registrations: 0,
        aborted: true,
        published: false,
        staging: [],
      });
    } finally {
      release.resolve();
      await started;
      await turn();
      open.mockRestore();
      put.mockRestore();
    }
  });
}, 10_000);

test("MCP keeps a cancelled call's slot until its state preparation closes", async () => {
  await withAssembly(async (_root, create) => {
    const entered = defer();
    const queued = defer();
    const releaseOpen = defer();
    const closing = defer();
    const releaseClose = defer();
    let requests = 0;
    let openCount = 0;
    const native = sqlite.createSqliteStore;
    const inject = spyOn(sqlite, "createSqliteStore").mockImplementation(
      (...args) => {
        const store = native(...args);
        return {
          async open(options) {
            const result = await store.open(options);
            if (
              !result.ok ||
              !options.path.endsWith(join(".forge", "state.sqlite"))
            )
              return result;
            openCount++;
            if (openCount === 1) {
              entered.resolve();
              await releaseOpen.promise;
            }
            return {
              ok: true,
              handle: {
                ...result.handle,
                async close() {
                  closing.resolve();
                  await releaseClose.promise;
                  await result.handle.close();
                },
              },
            };
          },
        };
      },
    );
    const nativeAcquire = Object.getOwnPropertyDescriptor(
      LocalState.prototype,
      "acquire",
    )!.value as LocalState["acquire"];
    const acquire = spyOn(LocalState.prototype, "acquire").mockImplementation(
      function (this: LocalState, ...args: [boolean, ...AbortSignal[]]) {
        const lease = Reflect.apply(nativeAcquire, this, args) as ReturnType<
          typeof nativeAcquire
        >;
        if (args[0] && ++requests === 8) queued.resolve();
        return lease;
      },
    );
    const active: Promise<unknown>[] = [];
    const wire = await transport(async (name, _args, signal) => {
      if (name === "issue_create") {
        const result = create(signal);
        active.push(result);
        return result;
      }
      return { ok: true, op: "probe", status: "OK", result: {}, warnings: [] };
    });
    const busy = {
      result: {
        isError: true,
        structuredContent: { error: { code: "MCP_BUSY" } },
      },
    };
    const probe = () => wire.reply(wire.call("probe"));
    try {
      const running = wire.call("issue_create");
      await entered.promise;
      const waiters = Array.from({ length: 7 }, () =>
        wire.call("issue_create"),
      );
      await queued.promise;
      wire.cancel(running);
      await wire.ping();
      expect(await probe()).toMatchObject(busy);
      releaseOpen.resolve();
      await closing.promise;
      await wire.ping();
      expect(await probe()).toMatchObject(busy);
      for (const id of waiters) wire.cancel(id);
      await wire.ping();
      expect(await probe()).toMatchObject({ result: { isError: false } });
      releaseClose.resolve();
      await Promise.all(active);
      expect(openCount).toBe(1);
    } finally {
      releaseOpen.resolve();
      releaseClose.resolve();
      await wire.close();
      await Promise.all(active);
      await turn();
      acquire.mockRestore();
      inject.mockRestore();
    }
  });
}, 10_000);
