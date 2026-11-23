import { expect, test } from "bun:test";
import { timingSafeEqual } from "node:crypto";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { HOOK_PATHS } from "../../src/contract/hooks.ts";
import { SECRET_PATTERNS } from "../../src/contract/errors.ts";
import { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS } from "../../src/contract/mcp.ts";
import { createRemoteHandler, remoteWith } from "../../src/remote/index.ts";
import {
  config,
  deps,
  digest,
  eras,
  key,
  person,
  readRpc,
  request,
  rpcRequest,
  token,
} from "./fixtures.ts";

const timeout = 30_000;

test(
  "A1-A3 missing, malformed and unknown person bearer take the same refusal",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error("Body read"));
      },
    });
    try {
      const missing = await handler.handle(
        request("/mcp", null, undefined, { body }),
      );
      expect(missing.status).toBe(401);
      expect(missing.headers.get("www-authenticate")).toBe("Bearer");
      expect(fixture.core.calls).toEqual([]);
      const text = await missing.text();
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        status: "FAIL",
        error: { code: "UNAUTHENTICATED" },
      });
      const unknown = token.slice(0, -1) + "z";
      for (const value of ["abc", unknown]) {
        const result = await handler.handle(request("/mcp", null, value));
        expect(result.status).toBe(401);
        expect(await result.text()).toBe(text);
      }
      expect(fixture.core.calls).toEqual([
        ["findToken", digest("abc")],
        ["findToken", digest(unknown)],
      ]);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "A4 token revocation and person removal refuse further requests",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    const removed = createRemoteHandler(deps(config({ people: [] })));
    try {
      const live = await handler.handle(rpcRequest("tools/list"));
      expect(live.status).toBe(200);
      await readRpc(live);
      fixture.core.revokeToken("tok_a");
      const revoked = await handler.handle(rpcRequest("tools/list"));
      const unknown = await removed.handle(rpcRequest("tools/list"));
      expect(revoked.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(await revoked.text()).toBe(await unknown.text());
    } finally {
      await handler.close();
      await removed.close();
    }
  },
  timeout,
);

test(
  "A5-A6 credential kinds are isolated and queries are ignored",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      const badMcp = await handler.handle(request("/mcp", null, key));
      const badHook = await handler.handle(
        request(HOOK_PATHS.mode, null, token),
      );
      const query = await handler.handle(request("/mcp?token=" + token, null));
      expect([badMcp.status, badHook.status, query.status]).toEqual([
        401, 401, 401,
      ]);
      const expected = await badMcp.text();
      expect(await query.text()).toBe(expected);
      expect(await badHook.json()).toMatchObject({
        error: (JSON.parse(expected) as { error: unknown }).error,
      });
      expect(fixture.core.calls).toEqual([
        ["findToken", digest(key)],
        ["findHostKey", digest(token)],
      ]);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "A7 comparison uses one fixed 32-byte dummy and compares stored digests on hits",
  async () => {
    const fixture = deps();
    const compared: Array<[Buffer, Buffer]> = [];
    const handler = remoteWith(fixture, {
      compare(a, b) {
        compared.push([a, b]);
        return timingSafeEqual(a, b);
      },
    });
    try {
      const missing = [undefined, "abc", token.slice(0, -1) + "z", key];
      for (const bearer of missing)
        expect(
          (await handler.handle(request("/mcp", null, bearer))).status,
        ).toBe(401);
      expect(
        (await handler.handle(request(HOOK_PATHS.mode, null, token))).status,
      ).toBe(401);
      const live = await handler.handle(rpcRequest("tools/list"));
      await readRpc(live);
      expect(live.status).toBe(200);
      expect(compared).toHaveLength(6);
      const dummy = compared[0]?.[1];
      if (!dummy) throw new Error("Missing dummy digest");
      for (const [a, b] of compared.slice(0, -1)) {
        expect(a).toHaveLength(32);
        expect(b).toHaveLength(32);
        expect(b).toEqual(dummy);
        expect(a).not.toEqual(b);
      }
      expect(compared.at(-1)).toEqual([
        Buffer.from(digest(token), "hex"),
        Buffer.from(digest(token), "hex"),
      ]);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

for (const era of eras) {
  test(
    `A8 frozen tool list in ${era}`,
    async () => {
      const fixture = deps();
      const handler = createRemoteHandler(fixture);
      try {
        if (era === "2025-11-25") {
          const init = await handler.handle(
            rpcRequest(
              "initialize",
              {
                protocolVersion: era,
                capabilities: {},
                clientInfo: { name: "fixture", version: "1" },
              },
              era,
            ),
          );
          expect(await readRpc(init)).toMatchObject({
            result: { protocolVersion: era },
          });
          fixture.core.calls.length = 0;
        }
        const response = await handler.handle(
          rpcRequest("tools/list", {}, era),
        );
        expect(response.status).toBe(200);
        expect(await readRpc(response)).toMatchObject({
          result: {
            tools: MCP_TOOL_NAMES.map((name) => ({
              name,
              inputSchema: TOOL_INPUT_SCHEMAS[name],
              annotations: { readOnlyHint: false, destructiveHint: false },
            })),
          },
        });
        expect(fixture.core.calls.map(([name]) => name)).toEqual([
          "findToken",
          "person",
        ]);
      } finally {
        await handler.close();
      }
    },
    timeout,
  );
}

test(
  "A9 SDK factory receives the id and person without raw credentials",
  async () => {
    let observed: unknown;
    const handler = remoteWith(deps(), {
      makeMcp: (factory, options) =>
        createMcpHandler((context) => {
          observed = context.authInfo;
          return factory(context);
        }, options),
    });
    try {
      await readRpc(await handler.handle(rpcRequest("tools/list")));
      expect(observed).toEqual({
        token: "tok_a",
        clientId: person.personId,
        scopes: [],
        extra: { caller: { person, tokenId: "tok_a" } },
      });
      expect(JSON.stringify(observed)).not.toContain(token);
      expect(JSON.stringify(observed)).not.toContain(digest(token));
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "A10-A11 hook routes return one refusal per op and never expose credentials",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      for (const [route, path] of Object.entries(HOOK_PATHS)) {
        const first = await handler.handle(request(path, null));
        const second = await handler.handle(
          request(path, null, key.slice(0, -1) + "z"),
        );
        const text = await first.text();
        expect(first.status).toBe(401);
        expect(second.status).toBe(401);
        expect(first.headers.get("www-authenticate")).toBe("Bearer");
        expect(await second.text()).toBe(text);
        expect(JSON.parse(text)).toMatchObject({
          op: "hub.hook-" + route,
          error: { code: "UNAUTHENTICATED" },
        });
        expect(text).not.toContain("Bearer");
        for (const pattern of SECRET_PATTERNS)
          expect(text).not.toMatch(pattern);
      }
      expect(fixture.core.calls.map(([name]) => name)).toEqual([
        "findHostKey",
        "findHostKey",
        "findHostKey",
      ]);
      expect(JSON.stringify(fixture.log.fields)).not.toContain(digest(key));
      for (const pattern of SECRET_PATTERNS)
        expect(JSON.stringify(fixture.log.fields)).not.toMatch(pattern);
    } finally {
      await handler.close();
    }
  },
  timeout,
);
