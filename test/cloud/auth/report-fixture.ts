import { expect, mock } from "bun:test";
import { Database } from "bun:sqlite";
import type { ClaimStore } from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
import { sha256 } from "../../../cloud/src/tokens.ts";
import { jwtFixture } from "../../adapters/clerk/jwt-fixture.ts";
import { createOAuthHarness } from "../../adapters/workers-oauth/harness.ts";
import { browserStorage } from "../browser-storage.fixture.ts";

await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { CodeRedemption, createConfiguredWorker, Project } =
  await import("../../../cloud/src/adapters/workers-oauth/compose.ts");
if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });

export const origin = "https://reports.example";
export const issuer = "https://clerk.example";
export const active = "__Host-forge_report";
export const pending = "__Host-forge_report_login";
export const reportPath = "/__forge/report-session";
const client = "report-client";
const owner = "user_Owner1";
const vars = {
  FORGE_CLOUD_PROJECT: "p",
  FORGE_CLOUD_ID_PREFIX: "fixture",
  DEVICE_LOGIN_HMAC_KEY: Buffer.alloc(32, 7).toString("base64url"),
  CLERK_ISSUER: issuer,
  CLERK_CLIENT_ID: client,
  CLERK_REDIRECT_URI: origin + "/callback",
  FORGE_OWNER_SUBJECT: owner,
  FORGE_API_RESOURCE: origin,
  OAUTH_TIMEOUT_MS: "5000",
  ADMIN_TOKEN: "fixture-admin",
};

export class Jar extends Map<string, string> {
  header() {
    return [...this].map(([name, value]) => name + "=" + value).join("; ");
  }
  accept(response: Response) {
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!;
      const name = pair.slice(0, pair.indexOf("="));
      if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) this.delete(name);
      else this.set(name, pair.slice(name.length + 1));
    }
  }
}

export function noStore(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("CDN-Cache-Control")).toBe("no-store");
  expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("no-store");
}

export function reportFixture(claims: Record<string, unknown> = {}) {
  let time = 1_800_000_000_000;
  const clock = { now: () => time };
  const trace = {
    exchanges: [] as URLSearchParams[],
    durable: [] as string[],
    projects: [] as string[],
    writes: [] as string[],
  };
  const fault = { method: "" };
  const objects = new Map<string, ReturnType<typeof redemption>>();
  function redemption() {
    const values = new Map<string, number>();
    const alarm = { at: 0 };
    let tail = Promise.resolve();
    const store: ClaimStore = {
      get: <T>(key: string) =>
        Promise.resolve(values.get(key) as T | undefined),
      put: (key, value) => Promise.resolve(void values.set(key, value)),
      setAlarm: (at) => {
        alarm.at = at;
        return Promise.resolve();
      },
    };
    const storage = {
      ...store,
      deleteAll: () => Promise.resolve(values.clear()),
      transaction<T>(operation: (storage: ClaimStore) => Promise<T>) {
        const next = tail.then(() => operation(store));
        tail = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    };
    const object = new CodeRedemption({ storage }, undefined, clock);
    return { object, values, alarm };
  }
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: unknown) => {
      const name = String(id);
      let row = objects.get(name);
      if (!row) objects.set(name, (row = redemption()));
      const { object } = row;
      return {
        fetch: async (request: Request) => {
          const path = new URL(request.url).pathname;
          trace.durable.push(request.method + " " + path);
          if (path === reportPath && request.method === fault.method)
            return new Response(null, { status: 503 });
          const response = await object.fetch(request);
          if (path === reportPath) noStore(response);
          return response;
        },
      };
    },
  };
  const { storage } = browserStorage(new Database(":memory:"), (sql) => {
    if (/^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) trace.writes.push(sql);
  });
  const project = new Project({ storage }, vars);
  const harness = createOAuthHarness();
  const env = {
    ...vars,
    PROJECTS: {
      idFromName: String,
      get: (id: unknown) => {
        trace.projects.push(String(id));
        return project;
      },
    },
    CODE_REDEMPTION: namespace,
    OAUTH_KV: harness.options.storage,
    GRANT_STATE: harness.grantNamespace,
    REGISTRATION_LIMITER: {
      idFromName: String,
      get: () => ({ fetch: () => Promise.resolve(new Response()) }),
    },
  };
  const worker = createConfiguredWorker(undefined, {
    clock,
    fetch: async (url, init) => {
      const now = time / 1000;
      const defaults = { sub: owner, auth_time: now - 1, exp: now + 600 };
      const { proof, jwk } = await jwtFixture(issuer, client, {
        claims: { ...defaults, ...claims },
      });
      if (url === issuer + "/.well-known/jwks.json")
        return Response.json({ keys: [jwk] });
      if (
        url !== issuer + "/oauth/token" ||
        !(init?.body instanceof URLSearchParams)
      )
        throw new Error("Unexpected Clerk request");
      trace.exchanges.push(init.body);
      return Response.json({ id_token: proof });
    },
  });
  async function send(
    path: string,
    jar = new Jar(),
    init: RequestInit = {},
    overrides: Record<string, unknown> = {},
  ) {
    const headers = new Headers(init.headers);
    if (jar.size && !headers.has("Cookie")) headers.set("Cookie", jar.header());
    const response = await worker.fetch(
      new Request(new URL(path, origin).href, { ...init, headers }),
      { ...env, ...overrides },
    );
    jar.accept(response);
    return response;
  }
  return {
    send,
    trace,
    objects,
    fault,
    clock,
    advance: (ms: number) => (time += ms),
  };
}

export type ReportFixture = ReturnType<typeof reportFixture>;
export const callback = (...states: string[]) => {
  const query = new URLSearchParams({ code: "fixture-code" });
  for (const state of states) query.append("state", state);
  return "/callback?" + query.toString();
};
export async function begin(f: ReportFixture, jar: Jar) {
  const response = await f.send("/app/sign-in", jar);
  expect(response.status).toBe(302);
  noStore(response);
  return new URL(response.headers.get("Location")!);
}
export async function session(f: ReportFixture, jar: Jar) {
  const url = await begin(f, jar);
  const response = await f.send(callback(url.searchParams.get("state")!), jar);
  expect(response.status).toBe(303);
  noStore(response);
  const id = jar.get(active)?.split(".")[0];
  expect(id).toMatch(/^[\w-]{43}$/);
  const record = f.objects.get(
    "forge-report-session:v1:" + (await sha256(id!)),
  );
  expect(record).toBeDefined();
  return { response, record: record! };
}
