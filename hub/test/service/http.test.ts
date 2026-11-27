import { once } from "node:events";
import { createServer, request, type IncomingMessage } from "node:http";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { expect, spyOn, test } from "bun:test";
import { SLACK_WEBHOOK_PATH } from "../../src/contract/chat.ts";
import { HOOK_PATHS } from "../../src/contract/hooks.ts";
import { LIMITS, MCP_PATH } from "../../src/contract/mcp.ts";
import type { HubConfig } from "../../src/contract/runtime.ts";
import { createHubHttpListener } from "../../src/service/routes.ts";
import { configFixture } from "../core/config-fixture.ts";

const timeout = 10_000;
const host = "hub.example.test:3775";
const basePath = "/forge/hub";
const webhook = basePath + SLACK_WEBHOOK_PATH;
const mcp = basePath + MCP_PATH;
const log = { info() {}, warn() {}, error() {} };

async function withServer(
  run: (fixture: Awaited<ReturnType<typeof openServer>>) => Promise<void>,
  overrides: Partial<HubConfig> = {},
  handle = (_request: Request) => new Response("remote response"),
) {
  const fixture = await openServer(overrides, handle);
  try {
    await run(fixture);
  } finally {
    await new Promise<void>((resolve) => {
      fixture.server.close(() => resolve());
      fixture.server.closeAllConnections();
    });
  }
}

async function openServer(
  overrides: Partial<HubConfig>,
  handle: (request: Request) => Response,
) {
  const config = {
    ...configFixture(),
    basePath,
    allowedHosts: [host],
    slack: { mode: "webhook", buttons: false } as const,
    hooks: { enabled: true },
    ...overrides,
  };
  const chatCalls: Request[] = [];
  const remoteCalls: Request[] = [];
  const listener = createHubHttpListener({
    config,
    log,
    chat: {
      async handleWebhook(input) {
        chatCalls.push(input);
        return new Response("adapter refused", {
          status: 401,
          headers: { "x-adapter-result": "refused" },
        });
      },
    },
    remote: {
      async handle(input) {
        remoteCalls.push(input);
        return handle(input);
      },
    },
  });
  const server = createServer({ requireHostHeader: false }, listener);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("TCP address expected");
  const port = address.port;
  return { server, port, chatCalls, remoteCalls };
}

async function rawStatus(port: number, target: string, headers: string[]) {
  const client = connect(port, "127.0.0.1");
  let response = "";
  client.setEncoding("utf8").on("data", (chunk: string) => {
    response += chunk;
  });
  const ended = once(client, "end");
  try {
    client.write(
      [
        "GET " + target + " HTTP/1.1",
        ...headers,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );
    await ended;
    return Number(response.split(" ", 2)[1]);
  } finally {
    client.destroy();
  }
}

function startRequest(
  port: number,
  path: string,
  method: string,
  headers: Record<string, string> = {},
) {
  const { promise, resolve, reject } = Promise.withResolvers<IncomingMessage>();
  const client = request(
    {
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: { host, ...headers },
      agent: false,
    },
    resolve,
  );
  client.once("error", reject);
  return { client, response: promise };
}

async function readResponse(input: IncomingMessage, slow = false) {
  const chunks: Buffer[] = [];
  for await (const chunk of input as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    if (slow) await delay(1);
  }
  return Buffer.concat(chunks);
}

const ingress = [
  ["malformed Host", mcp, ["Host: hub.example.test/path"], 403],
  ["duplicate Host", mcp, ["Host: " + host, "hOsT: " + host], 403],
  ["missing Host", mcp, [], 403],
  ["unlisted Host", mcp, ["Host: elsewhere.example.test"], 403],
  [
    "forwarded Host",
    mcp,
    ["Host: elsewhere.example.test", "X-Forwarded-Host: " + host],
    403,
  ],
  ["absolute form", "http://" + host + mcp, ["Host: " + host], 400],
  ["Host checked first", "http://" + host + mcp, [], 403],
  ["normalized path", basePath + "/%2e" + MCP_PATH, ["Host: " + host], 400],
  ["malformed escape", mcp + "?q=%z0", ["Host: " + host], 400],
  ["wrong base path", basePath + "-other" + MCP_PATH, ["Host: " + host], 404],
  ["absent base path", MCP_PATH, ["Host: " + host], 404],
] as const;

for (const [label, target, headers, status] of ingress) {
  test(
    "S2 rejects " + label + " and keeps serving",
    async () => {
      await withServer(async ({ port, chatCalls, remoteCalls }) => {
        expect(await rawStatus(port, target, [...headers])).toBe(status);
        expect(chatCalls).toHaveLength(0);
        expect(remoteCalls).toHaveLength(0);
        expect(await rawStatus(port, mcp + "?q=%2F", ["Host: " + host])).toBe(
          200,
        );
        expect(remoteCalls.map(({ url }) => url)).toEqual([
          "http://" + host + MCP_PATH + "?q=%2F",
        ]);
      });
    },
    timeout,
  );
}

test(
  "S2 accepts mixed-case Host and routes exact MCP and hook paths",
  async () => {
    await withServer(async ({ port, remoteCalls }) => {
      for (const path of [MCP_PATH, ...Object.values(HOOK_PATHS)]) {
        expect(
          await rawStatus(port, basePath + path, [
            "Host: " + host.toUpperCase(),
          ]),
        ).toBe(200);
      }
      expect(remoteCalls.map(({ url }) => new URL(url).pathname)).toEqual([
        MCP_PATH,
        ...Object.values(HOOK_PATHS),
      ]);
    });
  },
  timeout,
);

test(
  "S2 uses the root with an empty base and only dispatches enabled routes",
  async () => {
    await withServer(
      async ({ port, remoteCalls, chatCalls }) => {
        const headers = ["Host: " + host];
        expect(await rawStatus(port, MCP_PATH, headers)).toBe(404);
        expect(await rawStatus(port, HOOK_PATHS.mode + "/extra", headers)).toBe(
          404,
        );
        expect(await rawStatus(port, HOOK_PATHS.mode, headers)).toBe(200);
        expect(await rawStatus(port, SLACK_WEBHOOK_PATH, headers)).toBe(404);
        expect(chatCalls).toHaveLength(0);
        expect(remoteCalls.map(({ url }) => new URL(url).pathname)).toEqual([
          HOOK_PATHS.mode,
        ]);
      },
      {
        basePath: "",
        mcp: { enabled: false },
        slack: { mode: "off", buttons: false },
      },
    );
  },
  timeout,
);

test(
  "S3 preserves webhook bytes and passes through the adapter's refusal",
  async () => {
    await withServer(async ({ port, chatCalls, remoteCalls }) => {
      const body = Buffer.from([0x61, 0xff, 0x0d, 0x0a, 0x00, 0x80]);
      const { client, response } = startRequest(port, webhook, "POST", {
        "content-length": String(body.length),
      });
      client.end(body);
      const incoming = await response;
      expect(incoming.statusCode).toBe(401);
      expect(incoming.headers["x-adapter-result"]).toBe("refused");
      expect((await readResponse(incoming)).toString()).toBe("adapter refused");
      expect(chatCalls).toHaveLength(1);
      const received = await chatCalls[0]?.arrayBuffer();
      expect(received && Buffer.from(received)).toEqual(body);
      expect(chatCalls[0]?.signal.aborted).toBe(false);
      expect(remoteCalls).toHaveLength(0);
    });
  },
  timeout,
);

test(
  "S3 does not dispatch the webhook in socket mode",
  async () => {
    await withServer(
      async ({ port, chatCalls }) => {
        const { client, response } = startRequest(port, webhook, "POST");
        client.end();
        const incoming = await response;
        expect(incoming.statusCode).toBe(404);
        await readResponse(incoming);
        expect(chatCalls).toHaveLength(0);
      },
      { slack: { mode: "socket", buttons: false } },
    );
  },
  timeout,
);

test(
  "S3 accepts a body at the cap",
  async () => {
    await withServer(async ({ port, chatCalls }) => {
      const body = Buffer.alloc(LIMITS.bodyBytes);
      const { client, response } = startRequest(port, webhook, "POST", {
        "content-length": String(body.length),
      });
      client.end(body);
      const incoming = await response;
      expect(incoming.statusCode).toBe(401);
      await readResponse(incoming);
      expect(chatCalls).toHaveLength(1);
    });
  },
  timeout,
);

for (const framing of ["declared", "chunked"] as const) {
  test(
    "S3 rejects an oversized " + framing + " body before the upload ends",
    async () => {
      await withServer(async ({ server, port, chatCalls, remoteCalls }) => {
        const size = LIMITS.bodyBytes + 1;
        let readStarted = false;
        const { client, response } = startRequest(
          port,
          webhook,
          "POST",
          framing === "declared"
            ? { "content-length": String(size + 1) }
            : { "transfer-encoding": "chunked" },
        );
        try {
          if (framing === "declared") {
            server.prependOnceListener("request", (input) => {
              const iterator = input.iterator.bind(input);
              input.iterator = (options) => {
                readStarted = true;
                client.write(Buffer.alloc(size));
                return iterator(options);
              };
            });
            client.flushHeaders();
          } else client.write(Buffer.alloc(size));
          const incoming = await response;
          expect(incoming.statusCode).toBe(413);
          await readResponse(incoming);
          if (framing === "declared") expect(readStarted).toBe(false);
          expect(chatCalls).toHaveLength(0);
          expect(remoteCalls).toHaveLength(0);
        } finally {
          client.destroy();
        }
      });
    },
    timeout,
  );
}

test(
  "S3 aborts a partial upload without dispatch",
  async () => {
    await withServer(async ({ server, port, chatCalls, remoteCalls }) => {
      const firstChunk = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      server.prependOnceListener("request", (input) => {
        input.once("data", () => firstChunk.resolve());
        input.once("close", () => closed.resolve());
      });
      const originalAbort = AbortController.prototype.abort;
      const signals: AbortSignal[] = [];
      const abort = spyOn(
        AbortController.prototype,
        "abort",
      ).mockImplementation(function (this: AbortController, reason?: unknown) {
        originalAbort.call(this, reason);
        signals.push(this.signal);
      });
      const { client, response } = startRequest(port, webhook, "POST", {
        "content-length": "10",
      });
      void response.catch(() => {});
      try {
        client.write("a");
        await firstChunk.promise;
        expect(abort).not.toHaveBeenCalled();
        client.destroy();
        await closed.promise;
        expect(signals[0]?.aborted).toBe(true);
        expect(signals[0]?.reason).toHaveProperty("name", "AbortError");
        expect(chatCalls).toHaveLength(0);
        expect(remoteCalls).toHaveLength(0);
      } finally {
        client.destroy();
        abort.mockRestore();
      }
    });
  },
  timeout,
);

test(
  "S3 propagates disconnect to a dispatched request and cancels its stream",
  async () => {
    const cancelled = Promise.withResolvers<void>();
    await withServer(
      async ({ port, remoteCalls }) => {
        const { client, response } = startRequest(port, mcp, "GET");
        try {
          client.end();
          const incoming = await response;
          await once(incoming, "data");
          client.destroy();
          await cancelled.promise;
          expect(remoteCalls[0]?.signal.aborted).toBe(true);
        } finally {
          client.destroy();
        }
      },
      {},
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(Uint8Array.of(1));
            },
            cancel() {
              cancelled.resolve();
            },
          }),
        ),
    );
  },
  timeout,
);

test(
  "S3 delivers a large streamed response to a slow reader",
  async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const count = 64;
    let sent = 0;
    await withServer(
      async ({ port }) => {
        const { client, response } = startRequest(port, mcp, "GET");
        client.end();
        const incoming = await response;
        expect(incoming.statusCode).toBe(200);
        expect(await readResponse(incoming, true)).toEqual(
          Buffer.alloc(chunk.length * count, 0x61),
        );
      },
      {},
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (sent === count) controller.close();
              else {
                controller.enqueue(chunk);
                sent++;
              }
            },
          }),
        ),
    );
  },
  timeout,
);
