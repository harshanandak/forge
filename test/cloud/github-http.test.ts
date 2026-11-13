import { expect, setDefaultTimeout, test } from "bun:test";
import { exitCode, failure } from "../../src/surface/result.ts";
setDefaultTimeout(1000);
const locator = Object.freeze({
  owner: "acme",
  repo: "forge",
  repositoryId: 7,
  branch: "feature/a",
  prNumber: 9,
});
const cases = [
  "ok",
  "requests:32",
  "requests:33",
  "bytes:4",
  "bytes:5",
  "keys",
  ...["owner", "repo", "repositoryId", "prNumber", "branch", "host", "dot"].map(
    (v) => `invalid:${v}`,
  ),
  ...["missing", "null", "throw", "expired"].map((v) => `credential:${v}`),
  ...[301, 302, 307, 308, "flag", "origin"].map((v) => `redirect:${v}`),
  ...[400, 401, 403, 404, 422, 429, 500, 503, "rate"].map((v) => `http:${v}`),
  ..."credential fetch body callback caller before late clock throw poison"
    .split(" ")
    .map((v) => `abort:${v}`),
];
for (const name of cases) {
  test(name, async () => {
    const [kind, variant] = name.split(":");
    const caller = new AbortController(),
      calls: string[] = [],
      signals: AbortSignal[] = [];
    let credentials = 0,
      cleared = 0,
      cancelled = 0,
      clock = 0,
      expire = () => {};
    let late: ((r: Response) => void) | undefined;
    const stream = (pull = () => {}) =>
      new ReadableStream(
        { pull, cancel: () => void cancelled++ },
        { highWaterMark: 0 },
      );
    const ports = {
      signal: caller.signal,
      now: () => clock,
      deadline(callback: () => void, ms: number) {
        expect(ms).toBe(10_000);
        expire = callback;
        return () => void cleared++;
      },
      async credential(id: number, signal: AbortSignal) {
        credentials++;
        signals.push(signal);
        expect(id).toBe(7);
        if (name === "credential:throw")
          throw new Error("secret-sentinel raw-body");
        if (name === "credential:null") return null;
        if (name === "abort:credential") {
          queueMicrotask(expire);
          return new Promise<never>(() => {});
        }
        return {
          token: "secret-sentinel",
          expiresAt: name === "credential:expired" ? 0 : 20_000,
        };
      },
      async fetch(url: string, init: RequestInit) {
        calls.push(url);
        signals.push(init.signal!);
        expect(url).toBe(
          "https://api.github.com/repos/acme/forge/branches/feature%2Fa?filter=a%26b%3Dx",
        );
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("manual");
        expect(new Headers(init.headers).get("Authorization")).toBe(
          "Bearer secret-sentinel",
        );
        expect(new Headers(init.headers).get("Accept")).toBe(
          "application/vnd.github+json",
        );
        if (name === "abort:throw") throw new Error("secret-sentinel raw-body");
        if (name === "abort:clock") clock = 10_000;
        if (name === "abort:fetch" || name === "abort:late") {
          queueMicrotask(expire);
          return new Promise<Response>((resolve) => void (late = resolve));
        }
        const body =
          name === "abort:body"
            ? stream(() => queueMicrotask(expire))
            : kind === "bytes"
              ? JSON.stringify("x".repeat(262142))
              : kind === "keys"
                ? `{${Array(9000).fill('"unknown":0').join(",")}}`
                : "{}";
        const status =
          ["http", "redirect"].includes(kind!) && Number(variant)
            ? Number(variant)
            : name === "abort:poison"
              ? 503
              : 200;
        const r = new Response(body, {
          status,
          headers: {
            "Content-Type": "application/json",
            ...(variant === "rate" ? { "X-RateLimit-Remaining": "0" } : {}),
          },
        });
        if (name === "redirect:flag")
          Object.defineProperty(r, "redirected", { value: true });
        if (name === "redirect:origin")
          Object.defineProperty(r, "url", {
            value: "https://evil.test/raw-body",
          });
        return r;
      },
    };
    type Get = (
      ...args: [string[], Record<string, string>]
    ) => Promise<unknown>;
    type Http = (
      l: unknown,
      p: unknown,
      read: (s: { get: Get }) => Promise<unknown>,
    ) => Promise<
      | { ok: true; value: unknown }
      | { ok: false; code: "INPUT_INVALID" | "UNAVAILABLE"; reason: string }
    >;
    const module = (await import("../../cloud/src/" + "github-http.ts").catch(
      () => null,
    )) as { withGithubHttp?: Http } | null;
    expect(typeof module?.withGithubHttp).toBe("function");
    const bad: Record<string, unknown> = {
      owner: "https://evil.test",
      repo: "x?x=1",
      repositoryId: 0,
      prNumber: -1,
      branch: "x..y",
      host: "evil.test",
      dot: "..",
    };
    const input = { ...locator };
    if (kind === "invalid")
      Object.assign(input, {
        [variant === "dot" ? "repo" : variant!]: bad[variant!],
      });
    const before = JSON.stringify(input);
    if (name === "abort:before") caller.abort("secret-sentinel");
    const result = await module!.withGithubHttp!(
      input,
      name === "credential:missing"
        ? { ...ports, credential: undefined }
        : ports,
      async ({ get }) => {
        if (name === "abort:callback") {
          queueMicrotask(expire);
          return new Promise<never>(() => {});
        }
        if (name === "abort:caller") caller.abort("secret-sentinel");
        const count = Number(variant) || (kind === "keys" ? 2 : 1);
        for (let i = 0; i < count; i++) {
          try {
            const value = await get(["branches", locator.branch], {
              filter: "a&b=x",
            });
            expect(value).toEqual(
              kind === "bytes"
                ? "x".repeat(262142)
                : kind === "keys"
                  ? { unknown: 0 }
                  : {},
            );
          } catch (error) {
            if (name !== "abort:poison") throw error;
          }
        }
        return "complete";
      },
    );
    const ok = ["ok", "requests:32", "bytes:4"].includes(name);
    expect(JSON.stringify(input)).toBe(before);
    if (ok) expect(result).toEqual({ ok: true, value: "complete" });
    else {
      const code =
        kind === "invalid" || kind === "keys" ? "INPUT_INVALID" : "UNAVAILABLE";
      expect(result).toEqual({
        ok: false,
        code,
        reason:
          code === "INPUT_INVALID"
            ? "Invalid GitHub request"
            : "GitHub unavailable",
      });
      if (!result.ok)
        expect(exitCode(failure(result.code, result.reason))).toBe(
          code === "INPUT_INVALID" ? 6 : 1,
        );
    }
    expect(new Set(signals).size).toBeLessThanOrEqual(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    if (kind === "invalid" || name === "abort:before") {
      expect(credentials).toBe(0);
      expect(calls).toHaveLength(0);
    } else expect(cleared).toBe(1);
    if (kind === "credential") expect(calls).toHaveLength(0);
    if (kind === "http" || kind === "redirect") expect(calls).toHaveLength(1);
    if (kind === "requests")
      expect(calls).toHaveLength(Math.min(32, Number(variant)));
    if (name === "abort:late") {
      late!(new Response(stream()));
      await Promise.resolve();
      await Promise.resolve();
    }
    if (name === "abort:late" || name === "abort:body")
      expect(cancelled).toBe(1);
  });
}
