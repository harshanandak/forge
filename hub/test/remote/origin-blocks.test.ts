import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HOOK_PATHS } from "../../src/contract/hooks.ts";
import { enabledToolNames } from "../../src/contract/mcp.ts";
import { createRemoteHandler, remoteWith } from "../../src/remote/index.ts";
import {
  callTool,
  config,
  deps,
  fail,
  key,
  readRpc,
  request,
  rpcRequest,
  token,
  toolResult,
} from "./fixtures.ts";

const timeout = 30_000;
const input = { host: "claude", hostSessionId: "s1" };

test(
  "O1 absent and listed origins allow MCP and hooks",
  async () => {
    const handler = createRemoteHandler(deps());
    try {
      for (const origin of [undefined, "https://hub.example"]) {
        const mcp = rpcRequest("tools/list");
        if (origin) mcp.headers.set("origin", origin);
        const result = await handler.handle(mcp);
        expect(result.status).toBe(200);
        await readRpc(result);
        expect(
          (
            await handler.handle(
              request(HOOK_PATHS.mode, input, key, {
                headers: origin ? { origin } : {},
              }),
            )
          ).status,
        ).toBe(200);
      }
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "O2 all unlisted origins use one 403 before lookup or body read",
  async () => {
    let refusal: string | undefined;
    for (const settings of [
      config(),
      config({
        allowedOrigins: [],
        mcp: { enabled: false },
        hooks: { enabled: false },
      }),
    ]) {
      const fixture = deps(settings);
      const handler = createRemoteHandler(fixture);
      try {
        for (const [path, credential] of [
          ["/mcp", token],
          [HOOK_PATHS.mode, key],
        ] as const) {
          for (const bearer of [credential, undefined]) {
            const body = new ReadableStream({
              start(controller) {
                controller.error(new Error("Body read"));
              },
            });
            const result = await handler.handle(
              request(path, null, bearer, {
                headers: { origin: "https://other.example" },
                body,
              }),
            );
            expect(result.status).toBe(403);
            const text = await result.text();
            refusal ??= text;
            expect(text).toBe(refusal);
            expect(JSON.parse(text)).toMatchObject({
              error: { code: "REQUEST_NOT_ALLOWED" },
            });
          }
        }
        expect(fixture.core.calls).toEqual([]);
      } finally {
        await handler.close();
      }
    }
  },
  timeout,
);

test(
  "B1-B2 Slack off advertises four tools and resolves known hidden tools in core",
  async () => {
    const fixture = deps(config({ slack: { mode: "off", buttons: false } }));
    let called = 0;
    fixture.core.ask = () => {
      called++;
      return Promise.resolve(fail("BLOCK_DISABLED"));
    };
    const handler = createRemoteHandler(fixture);
    try {
      const listing = await readRpc(
        await handler.handle(rpcRequest("tools/list")),
      );
      const result = listing.result as { tools: Array<{ name: string }> };
      expect(result.tools.map(({ name }) => name)).toEqual([
        ...enabledToolNames(false),
      ]);
      const rpc = await callTool(handler, "ask", {
        sessionId: "ses_a",
        projectId: "prj_demo",
        kind: "choice",
        requestedAction: "choice",
        question: "Check?",
      });
      expect(rpc.status).toBe(200);
      expect(toolResult(rpc.message)).toMatchObject({
        isError: true,
        structuredContent: { error: { code: "BLOCK_DISABLED" } },
      });
      expect(called).toBe(1);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "B3-B6 blocks and unrelated paths do not look up credentials and close is idempotent",
  async () => {
    let created = 0;
    let closed = 0;
    const makeMcp: typeof createMcpHandler = (factory, options) => {
      created++;
      const sdk = createMcpHandler(factory, options);
      return {
        ...sdk,
        close: async () => {
          closed++;
          await sdk.close();
        },
      };
    };
    const off = deps(
      config({ mcp: { enabled: false }, hooks: { enabled: false } }),
    );
    const disabled = remoteWith(off, { makeMcp });
    try {
      for (const bearer of [undefined, token])
        expect(
          (await disabled.handle(request("/mcp", null, bearer))).status,
        ).toBe(404);
      let refusal: { code: string } | undefined;
      for (const path of Object.values(HOOK_PATHS)) {
        for (const bearer of [undefined, "garbage", key]) {
          const response = await disabled.handle(request(path, input, bearer));
          expect(response.status).toBe(503);
          const body = (await response.json()) as { error: { code: string } };
          refusal ??= body.error;
          expect(body.error).toEqual(refusal);
          expect(body.error.code).toBe("BLOCK_DISABLED");
        }
      }
      expect(
        (await disabled.handle(request("/other", null, token))).status,
      ).toBe(404);
      expect(off.core.calls).toEqual([]);
      expect(created).toBe(0);
    } finally {
      await Promise.all([disabled.close(), disabled.close()]);
    }
    expect(closed).toBe(0);
    const enabled = remoteWith(deps(config({ hooks: { enabled: false } })), {
      makeMcp,
    });
    try {
      const listing = await enabled.handle(rpcRequest("tools/list"));
      expect(listing.status).toBe(200);
      await readRpc(listing);
      expect(created).toBe(1);
    } finally {
      await Promise.all([enabled.close(), enabled.close()]);
    }
    expect(closed).toBe(1);
  },
  timeout,
);
