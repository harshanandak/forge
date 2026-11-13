// Test-only pre-admission barrier, provider snapshots and late-write controls.
import type { OAuthStorage } from "../src/adapters/workers-oauth/index.ts";
import type { RedemptionNamespace } from "../src/adapters/workers-oauth/redemption.ts";
import { sha256 } from "../src/tokens.ts";
import { opens } from "./fault-worker.ts";

const groups = new Map<string, ReturnType<typeof group>>();
function group() {
  return {
    ready: Promise.withResolvers<void>(),
    held: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    arrived: 0,
    entries: 0,
    snapshots: new Map<string, string>(),
  };
}
function get(name: string) {
  let value = groups.get(name);
  if (!value) {
    value = group();
    groups.set(name, value);
  }
  return value;
}
export async function refreshControls(
  request: Request,
  kv: OAuthStorage,
  namespace: RedemptionNamespace,
) {
  const url = new URL(request.url),
    name =
      request.headers.get("x-refresh-race") ??
      request.headers.get("x-refresh-late") ??
      request.headers.get("x-refresh-observe");
  const state = name ? get(name) : undefined;
  const failure = () =>
    Response.json(
      { error: "temporarily_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  if (url.pathname.startsWith("/fixture/refresh-")) {
    const control = get(url.searchParams.get("group") ?? "");
    if (url.pathname.endsWith("-held"))
      return (await opens(control.held.promise))
        ? new Response(null)
        : failure();
    if (url.pathname.endsWith("-release")) {
      control.release.resolve();
      return new Response(null);
    }
    if (url.pathname.endsWith("-state"))
      return Response.json({
        entries: control.entries,
        arrived: control.arrived,
      });
    if (url.pathname.endsWith("-expiry")) {
      const body = (await request.json()) as {
          token: string;
          access?: boolean;
          remaining: number | null;
        },
        [user, id] = body.token.split(":");
      const key = body.access
        ? `token:${user}:${id}:${await sha256(body.token)}`
        : `grant:${user}:${id}`;
      const value = await kv.get<Record<string, unknown>>(key, {
        type: "json",
      });
      if (!value) return failure();
      if (body.remaining === null) delete value.expiresAt;
      else value.expiresAt = Math.floor(Date.now() / 1000) + body.remaining;
      await kv.put(key, JSON.stringify(value));
      return new Response(null);
    }
  }
  let reads = 0;
  const storage: OAuthStorage = {
    async get<T>(key: string, options?: { type: "json" }): Promise<T | null> {
      if (!state || !key.startsWith("grant:")) return kv.get<T>(key, options);
      if (++reads === 2) state.entries++;
      let value = state.snapshots.get(key);
      if (!value) {
        value = (await kv.get(key)) ?? undefined;
        if (value) state.snapshots.set(key, value);
      }
      return value ? ((options ? JSON.parse(value) : value) as T) : null;
    },
    async put(key, value, options) {
      if (key.startsWith("token:")) {
        if (request.headers.has("x-refresh-rate-fault"))
          throw new Error("429 Too Many Requests");
        if (request.headers.has("x-refresh-write-fault"))
          throw new Error("fixture provider write failure");
        if (state && request.headers.has("x-refresh-late")) {
          state.held.resolve();
          if (!(await opens(state.release.promise)))
            throw new Error("fixture late-write timeout");
        }
      }
      await kv.put(key, value, options);
    },
    delete: (key) => kv.delete(key),
    list: (options) => kv.list(options),
  };
  return {
    storage,
    namespace: {
      idFromName: (hash: string) => namespace.idFromName(hash),
      get: (id: unknown) => ({
        fetch: async (input: Request) => {
          if (
            state &&
            input.method === "POST" &&
            input.headers.get("Content-Type") === "application/json"
          ) {
            state.arrived++;
            if (
              state.arrived === (request.headers.has("x-refresh-race") ? 2 : 1)
            )
              state.ready.resolve();
            if (!(await opens(state.ready.promise))) return failure();
          }
          return namespace.get(id).fetch(input);
        },
      }),
    },
    finish: (response: Response) =>
      request.headers.has("x-refresh-drop") && response.ok
        ? failure()
        : response,
  };
}
