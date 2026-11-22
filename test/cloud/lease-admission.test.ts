import { Database } from "bun:sqlite";
import { expect, mock, spyOn, test } from "bun:test";
import { createOAuthHarness } from "../adapters/workers-oauth/harness.ts";
import { storageOf } from "../../cloud/conformance/storage.ts";
import { Project, createWorker } from "../../cloud/src/worker.ts";
import { Jar } from "./auth/report-fixture.ts";

const { createConfiguredWorker, composeOAuth } =
  await import("../../cloud/src/adapters/workers-oauth/compose.ts");
const { createOAuthAdapter } =
  await import("../../cloud/src/adapters/workers-oauth/index.ts");
const issuer = "https://auth.example";
const resource = "https://api.example/a";
const admin = "Bearer fixture-admin";
const device = { device: "phone", ttlMs: 600_000 };
const holder = {
  actor: { kind: "agent", id: "builder" },
  session: { id: "run", device: device.device },
};
const json = async <T>(reply: Response) => (await reply.json()) as T;
function request(path: string, authorization: string, data?: unknown) {
  const headers = authorization ? { authorization } : new Headers();
  if (data === undefined) return new Request(issuer + path, { headers });
  const body = JSON.stringify(data);
  return new Request(issuer + path, { headers, method: "POST", body });
}

async function owner(harness: ReturnType<typeof createOAuthHarness>) {
  const api = createOAuthAdapter(harness.options);
  const redirect = "https://client.example/callback";
  const client = await api.register(redirect);
  const jar = new Jar();
  async function visit(path: string, handle?: string) {
    const req = new Request(issuer + path, {
      headers: { cookie: jar.header() },
      ...(handle && { method: "POST", body: new URLSearchParams({ handle }) }),
    });
    const reply = handle
      ? await api.consent(req, true)
      : await api.authorize(req);
    jar.accept(reply);
    return reply;
  }
  const consent = await visit(
    `/authorize?response_type=code&client_id=${client}&redirect_uri=${redirect}&state=client&resource=${resource}&code_challenge_method=S256&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM`,
  );
  const { handle } = await json<{ handle: string }>(consent);
  const upstream = await visit("/authorize", handle);
  const query = (reply: Response) =>
    new URL(reply.headers.get("location")!).searchParams;
  const path = `/callback?state=${query(upstream).get("state")}&proof=proof`;
  const callback = new Request(issuer + path, {
    headers: { cookie: jar.header() },
  });
  const code = query(await api.callback(callback)).get("code");
  const body = new URLSearchParams(
    `grant_type=authorization_code&client_id=${client}&redirect_uri=${redirect}&code=${code}&resource=${resource}&code_verifier=dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk`,
  );
  const exchanged = await api.token(
    new Request(issuer + "/oauth/token", { method: "POST", body }),
  );
  expect(exchanged.status).toBe(200);
  return `Bearer ${(await json<{ access_token: string }>(exchanged)).access_token}`;
}

function fixture(project: Project, configured: boolean) {
  const harness = createOAuthHarness();
  const { options, grantNamespace } = harness;
  const idFromName = mock(String);
  const fetch = spyOn(project, "fetch");
  const get = mock(() => project);
  const policy = { authorize: () => ({ allowed: true as const }) };
  const auth = composeOAuth(options, resource, policy);
  const authorize = spyOn(auth, "authorize");
  const oauthRead = spyOn(options.storage, "get");
  const forward = mock(() => Promise.resolve(new Response()));
  const deps = { policy, forward, clock: options.clock };
  const worker = configured
    ? createConfiguredWorker(undefined, deps)
    : createWorker(auth, forward);
  const env = {
    ADMIN_TOKEN: "fixture-admin",
    CLERK_ISSUER: "https://identity.example",
    CLERK_CLIENT_ID: "fixture-client",
    CLERK_REDIRECT_URI: issuer + "/callback",
    FORGE_API_RESOURCE: resource,
    OAUTH_TIMEOUT_MS: "5000",
    CODE_REDEMPTION: grantNamespace,
    GRANT_STATE: grantNamespace,
    OAUTH_KV: options.storage,
    PROJECTS: { idFromName, get },
  };
  function send(req: Request, admitted?: string) {
    const admission = admitted ? { FORGE_CLOUD_PROJECT: admitted } : {};
    return worker.fetch(req, { ...env, ...admission });
  }
  const calls = [idFromName, get, fetch, authorize, oauthRead, forward];
  return { harness, send, calls };
}

async function issue(project: Project, name: string) {
  const req = request(`/p/${name}/devices`, admin, device);
  const reply = await project.fetch(req);
  expect(reply.status).toBe(200);
  return (await json<{ value: { id: string; token: string } }>(reply)).value;
}

for (const configured of [false, true]) {
  const factory = configured ? "configured Worker" : "raw Worker";
  test(`${factory} checks raw lease admission before Project and OAuth access`, async () => {
    using a = new Database(":memory:");
    using b = new Database(":memory:");
    const projectB = new Project(storageOf(b));
    const { harness, send, calls } = fixture(projectB, configured);
    const aToken = `Bearer ${(await issue(new Project(storageOf(a)), "a")).token}`;
    const bToken = `Bearer ${(await issue(projectB, "b")).token}`;
    const ownerBearer = await owner(harness);
    const lookup = "holder?subject=issue";
    const access = await send(request(`/p/a/${lookup}`, ownerBearer), "a");
    expect(access.status).toBe(200);
    const body = { subject: "issue", holder, ttlMs: 60_000, generation: 1 };
    const seed = request("/p/b/claim", bToken, { ...body, requestId: "seed" });
    expect((await projectB.fetch(seed)).status).toBe(200);
    for (const route of ["claim", "renew", "release", lookup])
      for (const [label, bearer, admitted] of [
        ["B device", bToken, "a"],
        ["A device", aToken, "a"],
        ["owner", ownerBearer, "a"],
        ["missing", "", "a"],
        ["malformed", "Bearer two words", "a"],
        ["unset", bToken, undefined],
      ] as const) {
        for (const call of calls) call.mockClear();
        const data =
          route === lookup ? undefined : { ...body, requestId: route };
        const req = request(`/p/b/${route}`, bearer, data);
        const reply = await send(req, admitted);
        const { error } = await json<{ error?: { code: string } }>(reply);
        expect(reply.status, `${route} ${label}`).toBe(403);
        expect(error?.code).toBe("AUTH_FORBIDDEN");
        expect(calls.every((call) => !call.mock.calls.length)).toBe(true);
      }
  }, 30_000);

  test(`${factory} preserves all six admin routes outside admission`, async () => {
    using store = new Database(":memory:");
    const project = new Project(storageOf(store));
    const { calls, send } = fixture(project, configured);
    const call = (route: string, bearer: string, data?: unknown) =>
      send(request(`/p/b/${route}`, bearer, data), "a");
    const exported = await call("dump", admin);
    const { value: dump } = await json<{ value: unknown }>(exported);
    const check = async (route: string, data?: unknown) => {
      for (const spy of calls) spy.mockClear();
      const wrong = await call(route, "Bearer wrong-admin", data);
      const { error } = await json<{ error: { code: string } }>(wrong);
      expect(wrong.status, route).toBe(401);
      expect(error.code).toBe("AUTH_INVALID");
      expect(calls.every((call) => !call.mock.calls.length)).toBe(true);
      const allowed = await call(route, admin, data);
      expect(allowed.status, route).toBe(200);
      return allowed;
    };
    await check("restore", dump);
    const issued = await check("devices", device);
    const { value } = await json<{ value: { id: string } }>(issued);
    await check("revoke", { id: value.id });
    await check("status");
    await check("dump");
    await check("upgrade", {});
  }, 30_000);
}
