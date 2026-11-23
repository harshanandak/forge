import { expect, test } from "bun:test";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HOOK_PATHS } from "../../src/contract/hooks.ts";
import { enabledToolNames } from "../../src/contract/mcp.ts";
import { remoteWith } from "../../src/remote/index.ts";
import {
  config,
  deps,
  fail,
  json,
  key,
  readRpc,
  remoteTest,
  request,
  rpc,
  rpcRequest,
  token,
} from "./fixtures.ts";

const timeout = 30_000;
const check = remoteTest(timeout);
const input = { host: "claude", hostSessionId: "s1" };
const authPaths = [
  ["/mcp", token],
  [HOOK_PATHS.mode, key],
] as const;
const disabled = config({
  allowedOrigins: [],
  mcp: { enabled: false },
  hooks: { enabled: false },
});

check(
  "O1 absent and listed origins allow MCP and hooks",
  async ({ handle }) => {
    for (const origin of [undefined, "https://hub.example"]) {
      const mcp = rpcRequest("tools/list");
      if (origin) mcp.headers.set("origin", origin);
      const result = await handle(mcp);
      expect(result.status).toBe(200);
      await readRpc(result);
      const hook = request(HOOK_PATHS.mode, input, key, {
        headers: origin ? { origin } : {},
      });
      expect((await handle(hook)).status).toBe(200);
    }
  },
);

for (const settings of [config(), disabled]) {
  check(
    "O2 Origin precedes body and lookup, MCP " + settings.mcp.enabled,
    async ({ handle, names }) => {
      let refusal: string | undefined;
      for (const [path, credential] of authPaths)
        for (const bearer of [credential, undefined]) {
          const body = new ReadableStream({
            start(c) {
              c.error(new Error("Body read"));
            },
          });
          const headers = { origin: "https://other.example" };
          const result = await handle(
            request(path, null, bearer, { body, headers }),
          );
          const text = await result.text();
          expect(result.status).toBe(403);
          expect(json(text)).toMatchObject({
            error: { code: "REQUEST_NOT_ALLOWED" },
          });
          refusal ??= text;
          expect(text).toBe(refusal);
        }
      expect(names()).toEqual([]);
    },
    settings,
  );
}

check(
  "B1-B2 Slack-off list and known hidden calls",
  async ({ handle, core }) => {
    let called = 0;
    core.ask = () => {
      called++;
      return Promise.resolve(fail("BLOCK_DISABLED"));
    };
    const listing = await readRpc(await handle(rpcRequest("tools/list")));
    const result = listing.result as { tools: Array<{ name: string }> };
    expect(result.tools.map(({ name }) => name)).toEqual([
      ...enabledToolNames(false),
    ]);
    const input = {
      sessionId: "ses_a",
      projectId: "prj_demo",
      kind: "choice",
      requestedAction: "choice",
      question: "Check?",
    };
    const { status, tool } = await rpc(handle, "ask", input);
    expect(status).toBe(200);
    expect(tool).toMatchObject({
      isError: true,
      structuredContent: { error: { code: "BLOCK_DISABLED" } },
    });
    expect(called).toBe(1);
  },
  config({ slack: { mode: "off", buttons: false } }),
);

test(
  "B3-B6 blocked paths, no lookup, and one MCP close",
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
    const off = deps(disabled);
    const away = remoteWith(off, { makeMcp });
    const close = (h: typeof away) => Promise.all([h.close(), h.close()]);
    try {
      const refused = await Promise.all(
        [undefined, token].map((bearer) =>
          away.handle(request("/mcp", null, bearer)),
        ),
      );
      expect(refused.map(({ status }) => status)).toEqual([404, 404]);
      expect(await refused[0]?.text()).toEqual(await refused[1]?.text());
      let blocked: { code: string } | undefined;
      for (const path of Object.values(HOOK_PATHS))
        for (const bearer of [undefined, "garbage", key]) {
          const result = await away.handle(request(path, input, bearer));
          const body = (await result.json()) as { error: { code: string } };
          expect(result.status).toBe(503);
          blocked ??= body.error;
          expect(body.error).toEqual(blocked);
          expect(body.error.code).toBe("BLOCK_DISABLED");
        }
      expect((await away.handle(request("/other", null, token))).status).toBe(
        404,
      );
      expect(off.core.calls).toEqual([]);
      expect(created).toBe(0);
    } finally {
      await close(away);
    }
    expect(closed).toBe(0);
    const on = remoteWith(deps(config({ hooks: { enabled: false } })), {
      makeMcp,
    });
    try {
      const result = await on.handle(rpcRequest("tools/list"));
      expect(result.status).toBe(200);
      await readRpc(result);
      expect(created).toBe(1);
    } finally {
      await close(on);
    }
    expect(closed).toBe(1);
  },
  timeout,
);
