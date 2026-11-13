import { expect, setDefaultTimeout, test } from "bun:test";
import { withGithubHttp } from "../../cloud/src/github-http.ts";
setDefaultTimeout(1000);
const locator = Object.freeze({
  owner: "acme",
  repo: "forge",
  repositoryId: 7,
  branch: "main",
  prNumber: 9,
});
type Case = {
  name: string;
  size: number;
  total?: unknown;
  envelope?: boolean;
  incomplete?: boolean;
  fault?: string;
  ok?: boolean;
  before?: number;
};
const cases: Case[] = [
  ...[0, 1, 99].map((size) => ({ name: `short ${size}`, size, ok: true })),
  { name: "full page", size: 100 },
  { name: "oversized page", size: 101 },
  { name: "exact count", size: 99, total: 99, ok: true },
  { name: "full despite exact count", size: 100, total: 100 },
  { name: "count above rows", size: 99, total: 100 },
  { name: "count below rows", size: 2, total: 1 },
  { name: "envelope without count", size: 1, envelope: true, ok: true },
  { name: "incomplete", size: 1, total: 1, incomplete: true },
  { name: "explicit complete", size: 1, total: 1, incomplete: false, ok: true },
  ...[-1, 1.5, "1", null].map((total) => ({
    name: `bad count ${total}`,
    size: 1,
    total,
  })),
  ...[
    "duplicate",
    "missing id",
    "string id",
    "http",
    "throw",
    "shape",
    "deadline",
    "caller",
    "page",
    "per_page",
  ].map((fault) => ({ name: fault, size: 2, fault })),
  { name: "shared request cap", size: 1, before: 32 },
  { name: "last request", size: 1, before: 31, ok: true },
];
for (const c of cases) {
  test(c.name, async () => {
    const query = { filter: "a&b=x" },
      caller = new AbortController(),
      signals: AbortSignal[] = [];
    const rows = Array.from({ length: c.size }, (_, n) => ({ id: n + 1 }));
    let calls = 0,
      credentials = 0,
      cleared = 0,
      expire = () => {};
    const reserved = c.fault === "page" || c.fault === "per_page";
    if (reserved) Object.assign(query, { [c.fault!]: "999" });
    const before = JSON.stringify({ locator, query, rows });
    const envelope = c.envelope || Object.hasOwn(c, "total");
    let body: unknown = envelope
      ? {
          rows,
          ...(Object.hasOwn(c, "total") ? { total_count: c.total } : {}),
          incomplete_results: c.incomplete ?? false,
        }
      : rows;
    if (c.fault === "duplicate") body = [{ id: 1 }, { id: 1 }];
    if (c.fault === "missing id") body = [{}];
    if (c.fault === "string id") body = [{ id: "1" }];
    if (c.fault === "shape") body = {};
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
          calls++;
          expect(url).toBe(
            "https://api.github.com/repos/acme/forge/collection?filter=a%26b%3Dx&per_page=100",
          );
          if (c.fault === "throw") throw new Error("fake-credential raw-body");
          if (c.fault === "deadline") expire();
          if (c.fault === "caller") caller.abort();
          return new Response(JSON.stringify(body), {
            status: c.fault === "http" ? 503 : 200,
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
          return await session.collect(
            ["collection"],
            query,
            envelope ? "rows" : undefined,
          );
        } catch {
          return "partial-evidence";
        }
      },
    );
    if (c.ok) expect(result).toEqual({ ok: true, value: rows });
    else {
      const invalid = reserved || c.fault === "duplicate";
      expect(result).toEqual({
        ok: false,
        code: invalid ? "INPUT_INVALID" : "UNAVAILABLE",
        reason: invalid ? "Invalid GitHub request" : "GitHub unavailable",
      });
    }
    expect(calls).toBe(reserved || c.before === 32 ? 0 : 1);
    expect(credentials).toBe(1);
    expect(cleared).toBe(1);
    expect(new Set(signals).size).toBe(1);
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(JSON.stringify({ locator, query, rows })).toBe(before);
  });
}
