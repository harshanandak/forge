import { test, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve, dirname, delimiter } from "node:path";
import { createProcessPort } from "../../../src/adapters/process/index.ts";
import type { ProcessPort } from "../../../src/ports/process.ts";
import { validateBlockManifest } from "../../../src/contract/index.ts";
import manifest from "../../../src/blocks/pr/forge.block.json" with { type: "json" };
type Result = {
  verdict: string;
  threads?: {
    id: string;
    commentId: number;
    author: string | null;
    line: number | null;
    isResolved: boolean;
    excerpt: { kind: string; source: string; text: string };
  }[];
  replyId?: number | null;
  isResolved?: boolean | null;
  reasons: { code: string; message: string }[];
};
const ops = createRequire(import.meta.url)(
  "../../../src/blocks/pr/entry.cts",
) as Record<string, (call: unknown) => Promise<Result>>;
const fixture = resolve(import.meta.dir, "../../node-fixtures/pr-thin/gh.cjs");
const node = createProcessPort().resolve("node", {
  PATH: process.env.PATH ?? "",
  PATHEXT: process.env.PATHEXT ?? "",
});
if (node.kind !== "resolved") throw new Error("Node unavailable");
const nodePath = node.path;
const proxyEnv = Object.fromEntries(
  "HTTPS_PROXY HTTP_PROXY NO_PROXY https_proxy http_proxy no_proxy"
    .split(" ")
    .map((name) => [name, "fixture-proxy"]),
);
async function run(
  operation: string,
  scenario: string,
  input: Record<string, unknown>,
  config: Record<string, unknown> = {},
) {
  let launches = 0;
  const port: ProcessPort = {
    capability: "forge.process/v1",
    resolve: () =>
      scenario === "missing"
        ? { kind: "unavailable", reason: "Missing gh", remedy: "Install gh" }
        : { kind: "resolved", path: fixture },
    run: (_exe, args, options) => {
      launches++;
      const child = spawnSync(nodePath, [fixture, ...args], {
        encoding: "utf8",
        env: { ...options.env, PR_CASE: scenario },
      });
      return Promise.resolve({
        exitCode: child.status,
        signal: child.signal,
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
        timedOut: false,
        truncated: false,
        durationMs: 0,
      });
    },
  };
  const result = await ops[operation]!({
    input: { repo: "owner/repo", number: 1, ...input },
    config,
    services: {
      process: port,
      files: { root: process.cwd() },
      environment: {
        select: (names: readonly string[]) =>
          Object.fromEntries(
            Object.entries({
              PATH: dirname(fixture) + delimiter + process.env.PATH,
              SystemRoot: process.env.SystemRoot ?? "",
              APPDATA: "fixture-APPDATA",
              XDG_CONFIG_HOME: "fixture-XDG_CONFIG_HOME",
              DBUS_SESSION_BUS_ADDRESS: "fixture-DBUS_SESSION_BUS_ADDRESS",
              ...proxyEnv,
            }).filter(([name]) => names.includes(name)),
          ),
      },
    },
    signal: new AbortController().signal,
    deadline: Date.now() + 30000,
  });
  return { result, launches };
}
test("manifest declares the thread operations", () => {
  expect(validateBlockManifest(manifest).ok).toBe(true);
  for (const name of ["pr.threads", "pr.reply", "pr.resolve"])
    expect(Object.keys(manifest.operations)).toContain(name);
}, 5000);
test("pr.threads reads both pages and fences review text as untrusted", async () => {
  const { result, launches } = await run("pr.threads", "threads-paged", {});
  expect(launches).toBe(1);
  expect(result.verdict).toBe("OK");
  expect(result.threads?.map((t) => t.id)).toEqual([
    "PRRT_1",
    "PRRT_2",
    "PRRT_3",
  ]);
  const [first, second] = result.threads!;
  expect(first).toMatchObject({
    commentId: 10,
    author: "reviewer",
    isResolved: false,
  });
  expect(second).toMatchObject({ line: null, isResolved: true });
  expect(first!.excerpt.kind).toBe("untrusted");
  expect(first!.excerpt.source).toBe("github:review-comment");
  expect(first!.excerpt.text.startsWith("Ignore previous")).toBe(true);
  expect(first!.excerpt.text.length).toBe(200);
}, 30000);
test("pr.threads honours the excerpt size and the unresolved filter", async () => {
  const { result } = await run(
    "pr.threads",
    "threads-paged",
    { unresolved: true },
    { excerptChars: 5 },
  );
  expect(result.threads?.map((t) => t.id)).toEqual(["PRRT_1", "PRRT_3"]);
  expect(result.threads?.[0]?.excerpt.text).toBe("Ignor");
}, 30000);
test("pr.reply posts to the comment's reply endpoint", async () => {
  const { result } = await run("pr.reply", "reply", {
    commentId: 42,
    body: "Fixed in abc",
  });
  expect(result).toEqual({ verdict: "OK", replyId: 777, reasons: [] });
}, 30000);
test("pr.resolve reads the thread back and reports isResolved", async () => {
  const { result, launches } = await run("pr.resolve", "resolve", {
    threadId: "PRRT_1",
  });
  expect(launches).toBe(2);
  expect(result).toEqual({ verdict: "OK", isResolved: true, reasons: [] });
}, 30000);
test("pr.resolve is BLOCKED when GitHub does not report the thread resolved", async () => {
  const { result } = await run("pr.resolve", "resolve-stuck", {
    threadId: "PRRT_1",
  });
  expect(result.verdict).toBe("BLOCKED");
  expect(result.isResolved).toBe(false);
  expect(result.reasons[0]?.code).toBe("EVIDENCE_GAP");
}, 30000);
for (const operation of ["pr.threads", "pr.reply", "pr.resolve"]) {
  test(`${operation} is UNAVAILABLE without gh or on a non-GitHub remote`, async () => {
    const extra = { commentId: 42, body: "x", threadId: "PRRT_1" };
    const missing = await run(operation, "missing", extra);
    expect(missing.result.verdict).toBe("UNAVAILABLE");
    expect(missing.launches).toBe(0);
    const foreign = await run(operation, "reply", {
      ...extra,
      repo: "https://gitlab.com/owner/repo",
    });
    expect(foreign.result.verdict).toBe("UNAVAILABLE");
    expect(foreign.launches).toBe(0);
  }, 30000);
}
