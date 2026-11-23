import { expect } from "bun:test";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HOOK_PATHS } from "../../src/contract/hooks.ts";
import { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS } from "../../src/contract/mcp.ts";
import { remoteWith } from "../../src/remote/index.ts";
import {
  config,
  digest,
  eras,
  json,
  key,
  person,
  readRpc,
  remoteTest,
  request,
  rpcRequest,
  token,
} from "./fixtures.ts";

const timeout = 30_000;
const check = remoteTest(timeout);
const invalid = token.slice(0, -1) + "z";
const missingKey = key.slice(0, -1) + "z";
const authError = { code: "UNAUTHENTICATED" };
const testBearer = (value?: string) => request("/mcp", null, value);

check(
  "A1-A3 one refusal for missing, malformed and unknown person bearer",
  async ({ handle, core }) => {
    const body = new ReadableStream({
      start(c) {
        c.error(new Error("Body read"));
      },
    });
    const first = await handle(request("/mcp", null, undefined, { body }));
    expect(first.status).toBe(401);
    expect(first.headers.get("www-authenticate")).toBe("Bearer");
    expect(core.calls).toEqual([]);
    const text = await first.text();
    expect(json(text)).toMatchObject({
      ok: false,
      status: "FAIL",
      error: authError,
    });
    for (const value of ["abc", invalid]) {
      const result = await handle(testBearer(value));
      expect(result.status).toBe(401);
      expect(await result.text()).toBe(text);
    }
    expect(core.calls).toEqual(
      ["abc", invalid].map((value) => ["findToken", digest(value)]),
    );
  },
);

check("A4 revoke an active token", async ({ handle, core }) => {
  const live = await handle(rpcRequest("tools/list"));
  expect(live.status).toBe(200);
  await readRpc(live);
  expect(core.revokeToken("tok_a")).toBe(true);
  const rejected = await handle(rpcRequest("tools/list"));
  expect(rejected.status).toBe(401);
  expect(await rejected.text()).toBe(
    await (await handle(testBearer(invalid))).text(),
  );
});

check(
  "A4 removed person cannot authenticate",
  async ({ handle }) => {
    const result = await handle(rpcRequest("tools/list"));
    expect(result.status).toBe(401);
    expect(await result.text()).toBe(
      await (await handle(testBearer(invalid))).text(),
    );
  },
  config({ people: [] }),
);

check(
  "A5-A6 route credential kinds and query isolation",
  async ({ handle, core }) => {
    const mcp = await handle(testBearer(key));
    const hook = await handle(request(HOOK_PATHS.mode, null, token));
    const query = await handle(request("/mcp?token=" + token, null));
    expect([mcp.status, hook.status, query.status]).toEqual([401, 401, 401]);
    const text = await mcp.text();
    expect(await query.text()).toBe(text);
    expect(await hook.json()).toMatchObject({
      error: json<{ error: unknown }>(text).error,
    });
    expect(core.calls).toEqual([
      ["findToken", digest(key)],
      ["findHostKey", digest(token)],
    ]);
  },
);

const compared: Array<[Buffer, Buffer]> = [];
check(
  "A7 fixed dummy and stored comparisons use two 32-byte buffers",
  async ({ handle }) => {
    for (const value of [undefined, "abc", invalid, key])
      expect((await handle(testBearer(value))).status).toBe(401);
    expect((await handle(request(HOOK_PATHS.mode, null, token))).status).toBe(
      401,
    );
    const live = await handle(rpcRequest("tools/list"));
    await readRpc(live);
    expect(live.status).toBe(200);
    expect(compared).toHaveLength(6);
    const dummy = compared[0]?.[1];
    if (!dummy) throw new Error("Missing dummy");
    for (const [a, b] of compared.slice(0, -1)) {
      expect([a.length, b.length]).toEqual([32, 32]);
      expect(b).toEqual(dummy);
      expect(a).not.toEqual(b);
    }
    const stored = Buffer.from(digest(token), "hex");
    expect(compared.at(-1)).toEqual([stored, stored]);
  },
  config(),
  (deps) => {
    compared.length = 0;
    return remoteWith(deps, {
      compare(a, b) {
        compared.push([a, b]);
        return timingSafeEqual(a, b);
      },
    });
  },
);

for (const era of eras) {
  check(`A8 frozen tool list in ${era}`, async ({ handle, core, names }) => {
    if (era === eras[0]) {
      const init = rpcRequest(
        "initialize",
        {
          protocolVersion: era,
          capabilities: {},
          clientInfo: { name: "fixture", version: "1" },
        },
        era,
      );
      expect(await readRpc(await handle(init))).toMatchObject({
        result: { protocolVersion: era },
      });
      core.calls.length = 0;
    }
    const response = await handle(rpcRequest("tools/list", {}, era));
    expect(response.status).toBe(200);
    const listing = await readRpc(response);
    const tools = (
      listing.result as {
        tools: Array<{
          name: string;
          inputSchema: unknown;
          annotations: unknown;
        }>;
      }
    ).tools;
    expect(tools.map(({ name }) => name)).toEqual([...MCP_TOOL_NAMES]);
    for (const [index, name] of MCP_TOOL_NAMES.entries()) {
      expect(tools[index]?.inputSchema).toEqual(TOOL_INPUT_SCHEMAS[name]);
      expect(tools[index]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
    }
    expect(names()).toEqual(["findToken", "person"]);
  });
}

let observed: unknown;
check(
  "A9 SDK receives id and person only",
  async ({ handle }) => {
    await readRpc(await handle(rpcRequest("tools/list")));
    expect(observed).toEqual({
      token: "tok_a",
      clientId: person.personId,
      scopes: [],
      extra: { caller: { person, tokenId: "tok_a" } },
    });
    expect(JSON.stringify(observed)).not.toContain(token);
    expect(JSON.stringify(observed)).not.toContain(digest(token));
  },
  config(),
  (deps) =>
    remoteWith(deps, {
      makeMcp: (factory, options) =>
        createMcpHandler((context) => {
          observed = context.authInfo;
          return factory(context);
        }, options),
    }),
);

check(
  "A10-A11 consistent hook refusals and secret-free output",
  async ({ handle, names }) => {
    for (const [route, path] of Object.entries(HOOK_PATHS)) {
      const first = await handle(request(path, null));
      const second = await handle(request(path, null, missingKey));
      expect([first.status, second.status]).toEqual([401, 401]);
      expect(first.headers.get("www-authenticate")).toBe("Bearer");
      const text = await first.text();
      expect(await second.text()).toBe(text);
      expect(json(text)).toMatchObject({
        op: "hub.hook-" + route,
        error: authError,
      });
    }
    expect(names()).toEqual(["findHostKey", "findHostKey", "findHostKey"]);
  },
);
