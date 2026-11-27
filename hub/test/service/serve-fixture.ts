import { ok } from "node:assert/strict";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import http, { type Server } from "node:http";
import { syncBuiltinESMExports } from "node:module";
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

function port(server: Server): number {
  const address = server.address();
  ok(address && typeof address !== "string");
  return address.port;
}

function status(server: Server, path: string, fields = 0): Promise<number> {
  const headers: Record<string, string> = { host, connection: "close" };
  for (let i = 0; i < fields; i++) headers["x-" + i] = "v";
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
  const occupied = scenario === "port" ? createServer() : undefined;
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
  http.createServer = (...args: Parameters<typeof createServer>) => {
    const created = createServer(...args);
    server = created;
    created.once("listening", () => {
      events.push("listening");
      listening.resolve(created);
    });
    return created;
  };
  syncBuiltinESMExports();
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
          if (scenario !== "shutdown") return Promise.resolve(new Response());
          const pending = Promise.withResolvers<Response>();
          request.signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              pending.resolve(new Response());
            },
            { once: true },
          );
          dispatch.resolve();
          return pending.promise;
        },
        close() {
          events.push("remote.close");
          return Promise.resolve();
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
                if (scenario === "lifecycle") await release.promise;
                await built.start();
              },
              close() {
                events.push("core.close");
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
          headers = {
            fixed,
            atLimit,
            chatCalls,
            remoteCalls,
            belowLimit: await status(active, mcp, 997),
          };
        }
        if (scenario === "shutdown") {
          pending = status(active, mcp).catch(() => "closed");
          await Promise.race([dispatch.promise, pending]);
        }
        process.emit("SIGTERM");
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
