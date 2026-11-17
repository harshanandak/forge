import { expect, test } from "bun:test";
import { createWorker } from "../../cloud/src/worker.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: crypto.timingSafeEqual.bind(crypto),
  });
const DEVICE = `fct_0123456789abcdef.${"A".repeat(43)}`;
const OWNER = "an-oauth-bearer";
const ADMIN = "admin-secret";
const LEASE = [
  ["claim", "POST"],
  ["renew", "POST"],
  ["release", "POST"],
  ["holder?subject=issue", "GET"],
] as const;
const ADMITTED_ELSEWHERE = {
  ok: false,
  error: {
    code: "AUTH_FORBIDDEN",
    message: "Commands are for a device token on the admitted project",
    retry: "never",
  },
};

function rig() {
  const reached: string[] = [];
  const authorized: string[] = [];
  const forwarded: string[] = [];
  const env = {
    ADMIN_TOKEN: ADMIN,
    FORGE_CLOUD_PROJECT: "admitted",
    PROJECTS: {
      idFromName: (name: string) => name,
      get: (id: unknown) => ({
        fetch: (request: Request) => {
          reached.push(`${String(id)} ${new URL(request.url).pathname}`);
          return Promise.resolve(Response.json({ ok: true }));
        },
      }),
    },
  };
  const auth = {
    authorize: (_request: Request, project: string) => {
      authorized.push(project);
      return Promise.resolve({ decision: { allowed: true } });
    },
  };
  const forward = (request: Request, project: string) => {
    forwarded.push(`${project} ${new URL(request.url).pathname}`);
    return Promise.resolve(Response.json({ ok: true }));
  };
  const worker = createWorker(auth as never, forward);
  const call = (
    project: string,
    route: string,
    method: string,
    token: string,
  ) =>
    worker.fetch(
      new Request(`https://fixture.example/p/${project}/${route}`, {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(method === "POST" ? { body: "{}" } : {}),
      }),
      env,
    );
  return { reached, authorized, forwarded, call };
}

test("each raw lease route refuses a project the Worker does not admit, for a device token and an owner bearer", async () => {
  const r = rig();
  for (const [route, method] of LEASE)
    for (const token of [DEVICE, OWNER]) {
      const reply = await r.call("other", route, method, token);
      expect([route, token, reply.status, await reply.json()]).toEqual([
        route,
        token,
        403,
        ADMITTED_ELSEWHERE,
      ]);
    }
  expect([r.reached, r.authorized, r.forwarded]).toEqual([[], [], []]);
}, 30_000);

test("each raw lease route is still served for the admitted project", async () => {
  const r = rig();
  for (const [route, method] of LEASE) {
    const reply = await r.call("admitted", route, method, DEVICE);
    expect([route, reply.status]).toEqual([route, 200]);
    const owner = await r.call("admitted", route, method, OWNER);
    expect([route, owner.status]).toEqual([route, 200]);
  }
  expect(r.reached.length).toBe(LEASE.length);
  expect(r.forwarded.length).toBe(LEASE.length);
}, 30_000);

test("admin routes stay gated by the admin token alone, for any project", async () => {
  const r = rig();
  for (const route of ["devices", "revoke", "status", "dump", "restore"]) {
    const method = route === "status" || route === "dump" ? "GET" : "POST";
    const served = await r.call("other", route, method, ADMIN);
    expect([route, served.status]).toEqual([route, 200]);
    const refused = await r.call("other", route, method, DEVICE);
    expect([route, refused.status]).toEqual([route, 401]);
  }
  expect(r.reached.length).toBe(5);
}, 30_000);
