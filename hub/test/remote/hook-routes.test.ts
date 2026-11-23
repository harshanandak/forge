import { expect } from "bun:test";
import { HOOK_PATHS, HOOK_STOP_TEXT_MAX } from "../../src/contract/hooks.ts";
import { LIMITS } from "../../src/contract/mcp.ts";
import {
  config,
  done,
  fail,
  key,
  person,
  remoteTest,
  request,
  token,
} from "./fixtures.ts";

const timeout = 30_000;
const check = remoteTest(timeout);
const base = { host: "claude", hostSessionId: "s1" };
const session = { ...base, source: "resume", threadId: "thr_1" };
const stop = { ...base, text: "Done." };
const caller = { person, hostInstanceId: "hst_a" };
type Route = keyof typeof HOOK_PATHS;
const post = (body: unknown, route: Route, extra?: RequestInit) =>
  request(HOOK_PATHS[route], body, key, extra);
const op = (route: Route) => "hub.hook-" + route;

check(
  "H1-H2 key identity with unchanged mode and registration inputs",
  async ({ handle, core }) => {
    for (const [route, body] of [
      ["mode", base],
      ["session", session],
    ] as const) {
      const response = await handle(post(body, route));
      expect(response.status).toBe(200);
      const expected =
        route === "mode"
          ? { result: { mode: "normal", sessionId: "ses_a" } }
          : {};
      expect(await response.json()).toMatchObject({
        ok: true,
        op: op(route),
        ...expected,
      });
    }
    expect(core.calls.filter(([name]) => name.startsWith("hook"))).toEqual([
      ["hookMode", caller, base],
      ["hookSession", caller, session],
    ]);
  },
);

check(
  "H3 and T1 maps hook refusals and all Stop results",
  async ({ handle, core }) => {
    core.hookSession = () => fail("SESSION_UNKNOWN");
    core.hookMode = () => fail("INTERNAL");
    for (const [route, body, status, code] of [
      ["session", session, 404, "SESSION_UNKNOWN"],
      ["mode", base, 500, "INTERNAL"],
    ] as const) {
      const response = await handle(post(body, route));
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        op: op(route),
        error: { code, message: code, retry: "never" },
      });
    }
    const seen: unknown[] = [];
    for (const result of ["posted", "held", "skipped"] as const) {
      core.hookStop = (...args) => {
        seen.push(args);
        return done({ result });
      };
      const response = await handle(post(stop, "stop"));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        op: op("stop"),
        result: { result },
      });
    }
    expect(seen).toEqual(Array.from({ length: 3 }, () => [caller, stop]));
    core.hookStop = () => Promise.resolve(fail("CHAT_UNAVAILABLE"));
    const refusal = await handle(post(stop, "stop"));
    expect(refusal.status).toBe(503);
    expect(await refusal.json()).toMatchObject({
      op: op("stop"),
      error: { code: "CHAT_UNAVAILABLE" },
    });
  },
);

const extra = {
  mode: [],
  session: [
    [{ ...session, source: "boot" }, "/source"],
    [base, "/source"],
    [{ ...session, threadId: "" }, "/threadId"],
  ],
  stop: [
    [base, "/text"],
    [{ ...stop, text: "" }, "/text"],
    [{ ...stop, text: "x".repeat(HOOK_STOP_TEXT_MAX + 1) }, "/text"],
  ],
};
for (const [route, body] of [
  ["mode", base],
  ["session", session],
  ["stop", stop],
] as const) {
  check("H4 and T2 invalid input on " + route, async ({ handle, names }) => {
    const cases = [
      [[], ""],
      [null, ""],
      ["text", ""],
      [{ ...body, extra: key }, "/extra"],
      [{ ...body, host: "vim" }, "/host"],
      [{ ...body, hostSessionId: "" }, "/hostSessionId"],
      [{ ...body, hostSessionId: "a".repeat(257) }, "/hostSessionId"],
      ...extra[route],
    ];
    for (const [value, pointer] of cases) {
      const response = await handle(post(value, route));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        op: op(route),
        error: { code: "INPUT_INVALID", pointer },
      });
    }
    const malformed = await handle(post(null, route, { body: "{" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      op: op(route),
      error: { code: "INPUT_INVALID" },
    });
    expect(
      names().every((name) => name === "findHostKey" || name === "person"),
    ).toBe(true);
  });
}

check(
  "H5-H6, M14 and T3 hook transport ordering",
  async ({ handle, names }) => {
    const type = { headers: { "content-type": "text/plain" } };
    const get = { method: "GET", body: null };
    for (const [input, status] of [
      [post(base, "mode", type), 415],
      [request(HOOK_PATHS.mode, base, undefined, type), 401],
      [post(base, "mode", get), 405],
      [post(session, "session", { method: "PUT" }), 405],
      [post(base, "mode", { body: "a".repeat(LIMITS.bodyBytes + 1) }), 413],
      [post(stop, "stop", type), 415],
      [post(stop, "stop", get), 405],
    ] as const)
      expect((await handle(input)).status).toBe(status);
    let refused: string | undefined;
    for (const bearer of [undefined, token, key.slice(0, -1) + "z"]) {
      const result = await handle(request(HOOK_PATHS.stop, stop, bearer));
      expect(result.status).toBe(401);
      const text = await result.text();
      refused ??= text;
      expect(text).toBe(refused);
    }
    expect(names().some((name) => name.startsWith("hook"))).toBe(false);
  },
);

check(
  "T4 disabled Stop never looks up credentials",
  async ({ handle, names }) => {
    let blocked: string | undefined;
    for (const bearer of [undefined, "garbage", key]) {
      const result = await handle(request(HOOK_PATHS.stop, stop, bearer));
      expect(result.status).toBe(503);
      const text = await result.clone().text();
      blocked ??= text;
      expect(text).toBe(blocked);
      expect(await result.json()).toMatchObject({
        error: { code: "BLOCK_DISABLED" },
      });
    }
    expect(names()).toEqual([]);
  },
  config({ hooks: { enabled: false } }),
);

check(
  "U1 unknown prompt never looks up credentials",
  async ({ handle, names }) => {
    expect((await handle(request("/hook/prompt", base, key))).status).toBe(404);
    expect(names()).toEqual([]);
  },
);
