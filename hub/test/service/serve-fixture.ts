import { ok } from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import http, { type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { connect } from "node:net";
import { join } from "node:path";
import { MCP_PATH } from "../../src/contract/mcp.ts";
import type { HubConfig, HubDb } from "../../src/contract/runtime.ts";
import * as core from "../../src/core/index.ts";
import type { MainServices } from "../../src/main.ts";
import { createHubHttpListener } from "../../src/service/routes.ts";
import { configFixture } from "../core/config-fixture.ts";
import { FakeChatPort } from "../fakes/fake-chat.ts";
import { hubTestTemp } from "../temp.ts";

const scenario = process.argv[2];
const host = "127.0.0.1";
const basePath = "/hub";
const health = basePath + "/healthz";
const mcp = basePath + MCP_PATH;
const slack =
  scenario === "chat" || scenario === "reconcile" || scenario === "headers";
const remoteEnabled = scenario !== "lifecycle" && scenario !== "telegram";
const admitted = /^(shutdown|drain|error|signals|pipelined)$/.test(
  scenario ?? "",
);
const config: HubConfig = {
  ...configFixture(),
  listen: { host, port: 0 },
  basePath,
  allowedHosts: [host],
  dataDir: "",
  chat: {
    adapter: scenario === "telegram" ? "telegram" : slack ? "slack" : "off",
  },
  slack: slack
    ? { mode: "webhook", buttons: false }
    : { mode: "off", buttons: false },
  mcp: { enabled: remoteEnabled },
  doorbells: [],
};
const createServer = http.createServer;
const log = { info() {}, warn() {}, error() {} };
const waiting: ((response: Response) => void)[] = [];
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const raise = (name: NodeJS.Signals) =>
  process.platform === "win32"
    ? process.emit(name)
    : process.kill(process.pid, name);

async function interrupt(): Promise<void> {
  raise("SIGTERM");
  raise("SIGINT");
  await turn();
  await turn();
}

function port(server: Server): number {
  const address = server.address();
  ok(address && typeof address !== "string");
  return address.port;
}

function status(
  server: Server,
  path: string,
  fields = 0,
  hidden?: string,
): Promise<number> {
  const headers = ["host", host, "connection", "close"];
  for (let i = 0; i < fields; i++) headers.push("x-" + i, "v");
  if (hidden) headers.push("host", hidden);
  return new Promise((resolve, reject) => {
    http
      .get({ host, port: port(server), path, headers, agent: false }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode ?? 0));
        res.once("error", reject);
      })
      .once("error", reject);
  });
}

function send(server: Server, count: number): Promise<unknown> {
  const socket = connect(port(server), host);
  socket.on("error", () => {});
  socket.once("close", () => {
    for (const resolve of waiting) resolve(new Response());
  });
  socket.write(
    ("GET " + mcp + " HTTP/1.1\r\nhost: " + host + "\r\n\r\n").repeat(count),
  );
  return once(socket, "data");
}

async function listen(server: Server): Promise<void> {
  server.listen(0, host);
  await once(server, "listening");
}

async function close(server: Server): Promise<void> {
  const closed = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closed;
}

async function boundary() {
  const listener = createHubHttpListener({
    config,
    log,
    remote: {
      handle: () => Promise.resolve(new Response()),
    },
  });
  const results: number[][] = [];
  for (const [limit, fields] of [
    [8, 5],
    [0, 998],
    [null, 997],
  ] as const) {
    const server = createServer({ requireHostHeader: false }, listener);
    server.maxHeadersCount = limit;
    await listen(server);
    try {
      results.push([
        await status(server, mcp, fields),
        await status(server, mcp, fields + 1),
      ]);
    } finally {
      await close(server);
    }
  }
  return results;
}

async function probe() {
  const events: string[] = [];
  const stderr: string[] = [];
  const root = realpathSync(hubTestTemp("forge-hub-serve-"));
  const dataDir = join(root, "data");
  const occupied =
    scenario === "port" || scenario === "early" ? createServer() : undefined;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const listening = Promise.withResolvers<Server>();
  const dispatch = Promise.withResolvers<void>();
  const privateFailure = new Error("private startup detail");
  let db: HubDb | undefined;
  let server: Server | undefined;
  let reserved = false;
  let chatCalls = 0;
  let remoteCalls = 0;
  let reconciled = false;
  let settled = false;
  const chat = new FakeChatPort();
  const startChat = chat.start.bind(chat);
  const stopChat = chat.stop.bind(chat);
  chat.start = (handlers) => {
    events.push("chat.start");
    if (scenario === "chat") return Promise.reject(privateFailure);
    return startChat(handlers);
  };
  chat.stop = () => {
    events.push("chat.stop");
    return stopChat();
  };
  chat.handleWebhook = () => {
    chatCalls++;
    return Promise.resolve(new Response());
  };
  Reflect.set(
    http,
    "createServer",
    (...args: Parameters<typeof createServer>): Server => {
      const created = createServer(...args);
      server = created;
      created.once("listening", () => {
        events.push("listening");
        listening.resolve(created);
      });
      return created;
    },
  );
  syncBuiltinESMExports();
  if (scenario === "pipelined")
    Reflect.set(
      http.ServerResponse.prototype,
      "destroy",
      function (this: http.ServerResponse, error?: Error) {
        return this.socket
          ? http.OutgoingMessage.prototype.destroy.call(this, error)
          : this;
      },
    );
  try {
    ok(await core.createPrivateDirectory(dataDir));
    if (occupied) await listen(occupied);
    const unsupported = (): never => {
      throw new Error("Unexpected fixture call");
    };
    const services: MainServices = {
      versions: process.versions,
      stdout() {},
      stderr: (value) => {
        stderr.push(value);
      },
      stdin: unsupported,
      loadConfig: () => ({
        ...config,
        dataDir,
        listen: { host, port: occupied ? port(occupied) : 0 },
      }),
      inspectStorage: unsupported,
      protectPath: unsupported,
      runSetupCommand: unsupported,
      runAdminCommand: unsupported,
      createChatPort: slack ? () => Promise.resolve(chat) : unsupported,
      createDoorbell: unsupported,
      createRemoteHandler: () => ({
        handle(request) {
          remoteCalls++;
          if (scenario === "stream")
            return Promise.resolve(
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new Uint8Array(1));
                  },
                  async cancel() {
                    events.push("cancel");
                    await turn();
                    db?.transaction(() => events.push("cancel.settled"));
                  },
                }),
              ),
            );
          if (!admitted) return Promise.resolve(new Response());
          const pending = Promise.withResolvers<Response>();
          waiting.push(pending.resolve);
          request.signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              if (scenario === "shutdown") pending.resolve(new Response());
              else
                void (scenario === "signals" ? interrupt() : turn()).then(
                  () => {
                    events.push("handler.settled");
                    pending.resolve(new Response());
                  },
                );
            },
            { once: true },
          );
          if (scenario !== "pipelined" || remoteCalls === 2) dispatch.resolve();
          return pending.promise;
        },
        close() {
          events.push("remote.close");
          return scenario === "late" ? interrupt() : Promise.resolve();
        },
      }),
      loadCore: () =>
        Promise.resolve({
          nullTracker: core.nullTracker,
          openHubDb(path) {
            events.push("db.open");
            const opened = core.openHubDb(path);
            db = opened;
            return {
              ...opened,
              claimWorker() {
                const claim = opened.claimWorker();
                reserved = true;
                events.push("claim");
                return {
                  release() {
                    events.push("release");
                    claim.release();
                  },
                };
              },
              transaction(work) {
                if (reserved && !reconciled && slack) {
                  reconciled = true;
                  events.push("reconcile");
                  if (scenario === "reconcile") throw privateFailure;
                }
                return opened.transaction(work);
              },
              close() {
                events.push("db.close");
                opened.close();
                db = undefined;
              },
            };
          },
          createHubCore(deps) {
            const built = core.createHubCore(deps);
            return {
              ...built,
              async start() {
                entered.resolve();
                if (scenario === "lifecycle" || scenario === "early")
                  await release.promise;
                await built.start();
              },
              async close() {
                events.push("core.close");
                if (scenario === "late") await interrupt();
                return built.close();
              },
            };
          },
        }),
    };
    const { mainWithServices } = await import("../../src/main.ts");
    const run = mainWithServices(["serve"], {}, services).finally(() => {
      settled = true;
    });
    try {
      await Promise.race([entered.promise, run]);
      const readyBeforeStartup = server?.listening ?? false;
      if (scenario === "early") process.emit("SIGTERM");
      release.resolve();
      const active = await Promise.race([listening.promise, run]);
      let ready: number | undefined;
      let headers: object | undefined;
      let pending: Promise<number | string> | undefined;
      const pendingAtReady = !settled;
      if (typeof active !== "number") {
        ready = await status(active, health);
        if (scenario === "headers") {
          const fixed =
            !Reflect.set(active, "maxHeadersCount", 0) &&
            active.maxHeadersCount === 1_000;
          const atLimit = await status(active, mcp, 998);
          const hiddenHost = await status(
            active,
            mcp,
            998,
            "elsewhere.example.test",
          );
          headers = {
            node: process.versions.node,
            fixed,
            atLimit,
            hiddenHost,
            chatCalls,
            remoteCalls,
            belowLimit: await status(active, mcp, 997),
          };
        }
        if (scenario === "stream") await send(active, 1);
        if (scenario === "pipelined") void send(active, 2).catch(() => {});
        else if (admitted) pending = status(active, mcp).catch(() => "closed");
        if (admitted)
          await Promise.race([dispatch.promise, pending ?? dispatch.promise]);
        if (scenario === "error") active.emit("error", privateFailure);
        else if (scenario === "signals") raise("SIGTERM");
        else process.emit("SIGTERM");
      }
      const code = await run;
      return {
        code,
        stderr,
        events,
        ready,
        readyBeforeStartup,
        pendingAtReady,
        headers,
        pending: await pending,
        listeningAfter: server?.listening ?? false,
      };
    } finally {
      release.resolve();
      if (!settled) process.emit("SIGTERM");
      await run;
    }
  } finally {
    if (occupied?.listening) await close(occupied);
    if (server?.listening) await close(server);
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}

const result = scenario === "boundary" ? await boundary() : await probe();
process.stdout.write(JSON.stringify(result));
