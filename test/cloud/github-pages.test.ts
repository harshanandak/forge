import { expect, setDefaultTimeout, test } from "bun:test";
import { withGithubHttp } from "../../cloud/src/github-http.ts";
setDefaultTimeout(1000);
const sequence = (length: number, start = 0) =>
  Array.from({ length }, (_, n) => start + n);
const locator = Object.freeze({
  owner: "acme",
  repo: "forge",
  repositoryId: 7,
  branch: "main",
  prNumber: 9,
});
type Case = {
  name: string;
  sizes: number[];
  totals?: unknown[];
  fault?: string;
  ok?: boolean;
  invalid?: boolean;
  key?: string;
  before?: number;
};
const cases: Case[] = [
  ...[0, 1, 99].map((n) => ({ name: `short ${n}`, sizes: [n], ok: true })),
  { name: "empty terminal", sizes: [100, 0], ok: true },
  { name: "second terminal", sizes: [100, 1], ok: true },
  { name: "third terminal", sizes: [100, 100, 99], ok: true },
  { name: "full third", sizes: [100, 100, 100] },
  { name: "zero count", sizes: [0], totals: [0], ok: true },
  { name: "exact first", sizes: [100], totals: [100], ok: true },
  { name: "exact second", sizes: [100, 100], totals: [200, 200], ok: true },
  {
    name: "exact third",
    sizes: [100, 100, 100],
    totals: [300, 300, 300],
    ok: true,
  },
  { name: "more than cap", sizes: [100, 100, 100], totals: [301, 301, 301] },
  { name: "count grows", sizes: [100, 1], totals: [101, 102] },
  { name: "count shrinks", sizes: [100, 1], totals: [101, 100] },
  { name: "missing count", sizes: [100, 1], totals: [101, undefined] },
  { name: "early terminal", sizes: [99], totals: [100] },
  { name: "incomplete result", sizes: [1], totals: [1], fault: "incomplete" },
  { name: "count below rows", sizes: [100], totals: [99] },
  ...[-1, 1.5, "100", null, Number.MAX_SAFE_INTEGER + 1].map((total) => ({
    name: `invalid count ${total}`,
    sizes: [1],
    totals: [total],
  })),
  { name: "oversized page", sizes: [101] },
  ...["http", "throw", "stream", "shape", "keys", "deadline", "caller"].map(
    (fault) => ({
      name: `later ${fault}`,
      sizes: [100, 1],
      fault,
    }),
  ),
  { name: "missing array", sizes: [1], key: "rows", fault: "shape" },
  { name: "wrong envelope", sizes: [1], key: "rows", fault: "array" },
  { name: "mutable inputs", sizes: [100, 1], fault: "mutate", ok: true },
  { name: "request budget", sizes: [100, 1], before: 31 },
  { name: "last request", sizes: [1], before: 31, ok: true },
  ...["page", "per_page"].map((fault) => ({
    name: `reserved ${fault}`,
    sizes: [],
    fault,
    invalid: true,
  })),
];
for (const c of cases) {
  test(c.name, async () => {
    const path = ["collection"],
      query = { filter: "a&b=x" },
      urls: string[] = [],
      signals: AbortSignal[] = [],
      caller = new AbortController();
    let page = 0,
      credentials = 0,
      cleared = 0,
      expire = () => {};
    const envelope = c.totals !== undefined || c.key !== undefined;
    const key = envelope ? (c.key ?? "rows") : undefined;
    if (c.invalid) Object.assign(query, { [c.fault!]: "999" });
    const original = JSON.stringify({ locator, path, query });
    const result = await withGithubHttp(
      locator,
      {
        signal: caller.signal,
        now: () => 0,
        deadline(callback, ms) {
          expect(ms).toBe(10_000);
          expire = callback;
          return () => void cleared++;
        },
        credential(id, signal) {
          credentials++;
          signals.push(signal);
          expect(id).toBe(7);
          return Promise.resolve({
            token: "fake-credential",
            expiresAt: 20_000,
          });
        },
        async fetch(url, init) {
          await Promise.resolve();
          signals.push(init.signal!);
          expect(init.method).toBe("GET");
          expect(init.redirect).toBe("manual");
          expect(new Headers(init.headers).get("Authorization")).toBe(
            "Bearer fake-credential",
          );
          if (url.endsWith("/warmup")) return Response.json({});
          urls.push(url);
          const index = page++;
          expect(url).toBe(
            `https://api.github.com/repos/acme/forge/collection?filter=a%26b%3Dx&page=${page}&per_page=100`,
          );
          expect(page).toBeLessThanOrEqual(3);
          if (c.fault === "mutate") {
            path[0] = "evil";
            query.filter = "changed";
          }
          if (index === 1 && c.fault === "throw")
            throw new Error("fake-credential raw-body");
          if (index === 1 && c.fault === "deadline") expire();
          if (index === 1 && c.fault === "caller") caller.abort();
          const rows = sequence(c.sizes[index] ?? 0, index * 100);
          const value =
            c.fault === "shape" && (index === 1 || c.key)
              ? {}
              : envelope && c.fault !== "array"
                ? {
                    rows,
                    total_count: c.totals?.[index],
                    ...(c.fault === "incomplete"
                      ? { incomplete_results: true }
                      : {}),
                  }
                : rows;
          const body =
            c.fault === "keys"
              ? `{${Array(8300).fill('"unknown":0').join(",")},"rows":${JSON.stringify(rows)},"total_count":101}`
              : JSON.stringify(value);
          if (index === 1 && c.fault === "stream")
            return new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("["));
                  controller.error(new Error("raw-body"));
                },
              }),
              { headers: { "Content-Type": "application/json" } },
            );
          return new Response(body, {
            status: index === 1 && c.fault === "http" ? 503 : 200,
            headers: {
              "Content-Type": "application/json",
              Link: '<https://evil.test/steal?page=999>; rel="next"',
            },
          });
        },
      },
      async (session) => {
        for (let i = 0; i < (c.before ?? 0); i++) await session.get(["warmup"]);
        try {
          const rows = await session.collect(
            path,
            query,
            c.fault === "keys" ? "rows" : key,
          );
          return rows;
        } catch {
          // Catching a failed collection must never salvage earlier evidence.
          return "partial-evidence";
        }
      },
    );
    if (c.ok) {
      expect(result).toEqual({
        ok: true,
        value: sequence(c.sizes.reduce((a, b) => a + b, 0)),
      });
    } else {
      const invalid = c.invalid || c.fault === "keys";
      expect(result).toEqual({
        ok: false,
        code: invalid ? "INPUT_INVALID" : "UNAVAILABLE",
        reason: invalid ? "Invalid GitHub request" : "GitHub unavailable",
      });
    }
    expect(credentials).toBe(1);
    expect(cleared).toBe(1);
    expect(new Set(signals).size).toBe(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(urls).toHaveLength(
      c.invalid ? 0 : c.before === 31 ? 1 : c.sizes.length,
    );
    if (c.fault !== "mutate")
      expect(JSON.stringify({ locator, path, query })).toBe(original);
  });
}
