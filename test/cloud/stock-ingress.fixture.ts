import { expect, mock } from "bun:test";
import raw from "../../cloud/src/worker.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { default: configured } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");

const closedReply = {
  ok: false,
  status: "FAIL",
  warnings: [],
  error: {
    code: "UNAVAILABLE",
    message: "Cloud projects arrive with v3.",
    retry: "never",
  },
};

type Entry = {
  fetch(request: Request, env: never): Response | Promise<Response>;
};
const entries: Record<string, Entry> = { raw, configured };
const bindings = new Set([
  "PROJECTS",
  "OAUTH_KV",
  "REGISTRATION_LIMITER",
  "CODE_REDEMPTION",
  "GRANT_STATE",
]);

export async function inspectIngress(
  request: Request,
  env: object | undefined,
  entry: Entry,
  reads: string[] = [],
  throwOnRead = false,
) {
  const guarded =
    env === undefined
      ? undefined
      : new Proxy(env, {
          get(target, key) {
            reads.push(String(key));
            if (throwOnRead || bindings.has(String(key)))
              throw new Error("Stock ingress touched " + String(key));
            return (target as Record<PropertyKey, unknown>)[key];
          },
        });
  try {
    const response = await entry.fetch(request, guarded as never);
    const body: unknown = await response.json().catch(() => null);
    return {
      status: response.status,
      cache: response.headers.get("cache-control"),
      body,
      reads,
    };
  } catch (error) {
    return { error: String(error), reads };
  }
}

export const closedOutcome = {
  status: 503,
  cache: "no-store",
  body: closedReply,
  reads: [],
};

export function stockIngress() {
  const failures: object[] = [];
  const covered = new Set<string>();
  return {
    async observe(request: Request, env: object, label?: string) {
      const route =
        label ?? request.method + " " + new URL(request.url).pathname;
      covered.add(route);
      const body = request.body
        ? await request.clone().arrayBuffer()
        : undefined;
      for (const [surface, worker] of Object.entries(entries)) {
        const copy = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          ...(body === undefined ? {} : { body }),
        });
        const observed = await inspectIngress(copy, env, worker);
        if (!Bun.deepEquals(observed, closedOutcome))
          failures.push({ route, surface, ...observed });
      }
    },
    expect(routes: string[]) {
      expect(routes.filter((route) => !covered.has(route))).toEqual([]);
      expect(failures).toEqual([]);
    },
  };
}

export { entries };
