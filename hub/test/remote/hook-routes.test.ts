import { expect, test } from "bun:test";
import { SECRET_PATTERNS } from "../../src/contract/errors.ts";
import { HOOK_PATHS, HOOK_STOP_TEXT_MAX } from "../../src/contract/hooks.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import { createRemoteHandler } from "../../src/remote/index.ts";
import { deps, fail, key, ok, person, request, token } from "./fixtures.ts";

const timeout = 30_000;
const base = { host: "claude", hostSessionId: "s1" };
const session = { ...base, source: "resume", threadId: "thr_1" };
const stop = { ...base, text: "Done." };
const caller = { person, hostInstanceId: "hst_a" };
const post = (
  input: unknown,
  route: keyof typeof HOOK_PATHS,
  extra?: RequestInit,
) => request(HOOK_PATHS[route], input, key, extra);

test(
  "H1-H2 hook mode and session derive the host identity from the key",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      const mode = await handler.handle(post(base, "mode"));
      expect(mode.status).toBe(200);
      expect(await mode.json()).toMatchObject({
        ok: true,
        op: "hub.hook-mode",
        result: { mode: "normal", sessionId: "ses_a" },
      });
      const registered = await handler.handle(post(session, "session"));
      expect(registered.status).toBe(200);
      expect(await registered.json()).toMatchObject({
        ok: true,
        op: "hub.hook-session",
      });
      expect(
        fixture.core.calls.filter(([name]) => name.startsWith("hook")),
      ).toEqual([
        ["hookMode", caller, base],
        ["hookSession", caller, session],
      ]);
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "H3 and T1 hook stop results and core failures carry their frozen statuses",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      fixture.core.hookSession = () => fail("SESSION_UNKNOWN");
      fixture.core.hookMode = () => fail("INTERNAL");
      for (const [route, body, status, code] of [
        ["session", session, 404, "SESSION_UNKNOWN"],
        ["mode", base, 500, "INTERNAL"],
      ] as const) {
        const response = await handler.handle(post(body, route));
        expect(response.status).toBe(status);
        expect(await response.json()).toMatchObject({
          op: "hub.hook-" + route,
          error: { code, message: code, retry: "never" },
        });
      }
      const seen: unknown[] = [];
      for (const result of ["posted", "held", "skipped"] as const) {
        fixture.core.hookStop = (...args) => {
          seen.push(args);
          return Promise.resolve(ok({ result }));
        };
        const response = await handler.handle(post(stop, "stop"));
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          ok: true,
          op: "hub.hook-stop",
          result: { result },
        });
      }
      expect(seen).toEqual(Array(3).fill([caller, stop]));
      fixture.core.hookStop = () => Promise.resolve(fail("CHAT_UNAVAILABLE"));
      const refusal = await handler.handle(post(stop, "stop"));
      expect(refusal.status).toBe(503);
      expect(await refusal.json()).toMatchObject({
        op: "hub.hook-stop",
        error: { code: "CHAT_UNAVAILABLE" },
      });
    } finally {
      await handler.close();
    }
  },
  timeout,
);

for (const route of ["session", "mode", "stop"] as const) {
  const value = route === "session" ? session : route === "mode" ? base : stop;
  const cases = [
    [[], ""],
    [null, ""],
    ["text", ""],
    [{ ...value, extra: key }, "/extra"],
    [{ ...value, host: "vim" }, "/host"],
    [{ ...value, hostSessionId: "" }, "/hostSessionId"],
    [{ ...value, hostSessionId: "a".repeat(257) }, "/hostSessionId"],
    ...(route === "session"
      ? [
          [{ ...session, source: "boot" }, "/source"],
          [base, "/source"],
          [{ ...session, threadId: "" }, "/threadId"],
        ]
      : []),
    ...(route === "stop"
      ? [
          [base, "/text"],
          [{ ...stop, text: "" }, "/text"],
          [{ ...stop, text: "x".repeat(HOOK_STOP_TEXT_MAX + 1) }, "/text"],
        ]
      : []),
  ] as const;
  test(
    `H4 and T2 ${route} invalid JSON and ${cases.length} schema errors stop before core`,
    async () => {
      const fixture = deps();
      const handler = createRemoteHandler(fixture);
      try {
        for (const [body, pointer] of cases) {
          const response = await handler.handle(post(body, route));
          expect(response.status).toBe(400);
          const text = await response.text();
          expect(JSON.parse(text)).toMatchObject({
            op: "hub.hook-" + route,
            error: { code: "INPUT_INVALID", pointer },
          });
          for (const pattern of SECRET_PATTERNS)
            expect(text).not.toMatch(pattern);
        }
        const malformed = await handler.handle(
          post(null, route, { body: "{" }),
        );
        expect(malformed.status).toBe(400);
        expect(await malformed.json()).toMatchObject({
          op: "hub.hook-" + route,
          error: { code: "INPUT_INVALID" },
        });
        expect(
          fixture.core.calls.every(
            ([name]) => name === "findHostKey" || name === "person",
          ),
        ).toBe(true);
      } finally {
        await handler.close();
      }
    },
    timeout,
  );
}

test(
  "H5-H6, M14 and T3 authenticate before method, media type and body size checks",
  async () => {
    const fixture = deps();
    const handler = createRemoteHandler(fixture);
    try {
      const type = { headers: { "content-type": "text/plain" } };
      expect((await handler.handle(post(base, "mode", type))).status).toBe(415);
      expect(
        (await handler.handle(request(HOOK_PATHS.mode, base, undefined, type)))
          .status,
      ).toBe(401);
      expect(
        (
          await handler.handle(
            post(base, "mode", { method: "GET", body: null }),
          )
        ).status,
      ).toBe(405);
      expect(
        (await handler.handle(post(session, "session", { method: "PUT" })))
          .status,
      ).toBe(405);
      expect(
        (
          await handler.handle(
            post(base, "mode", { body: "a".repeat(LIMITS.bodyBytes + 1) }),
          )
        ).status,
      ).toBe(413);
      let refused: string | undefined;
      for (const bearer of [undefined, token, key.slice(0, -1) + "z"]) {
        const response = await handler.handle(
          request(HOOK_PATHS.stop, stop, bearer),
        );
        expect(response.status).toBe(401);
        const text = await response.text();
        refused ??= text;
        expect(text).toBe(refused);
      }
      expect((await handler.handle(post(stop, "stop", type))).status).toBe(415);
      expect(
        (
          await handler.handle(
            post(stop, "stop", { method: "GET", body: null }),
          )
        ).status,
      ).toBe(405);
      expect(fixture.core.calls.some(([name]) => name.startsWith("hook"))).toBe(
        false,
      );
    } finally {
      await handler.close();
    }
  },
  timeout,
);

test(
  "T4 stop is disabled before key lookup and U1 prompt is outside the routes",
  async () => {
    const fixture = deps();
    const enabled = createRemoteHandler(fixture);
    const disabled = createRemoteHandler({
      ...fixture,
      config: { ...fixture.config, hooks: { enabled: false } },
    });
    try {
      for (const bearer of [undefined, "garbage", key]) {
        const response = await disabled.handle(
          request(HOOK_PATHS.stop, stop, bearer),
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "BLOCK_DISABLED" },
        });
      }
      expect(
        (await enabled.handle(request("/hook/prompt", base, key))).status,
      ).toBe(404);
      expect(fixture.core.calls).toEqual([]);
    } finally {
      await enabled.close();
      await disabled.close();
    }
  },
  timeout,
);
