import { expect, test } from "bun:test";
import { sha256 } from "../../../cloud/src/tokens.ts";
import {
  active,
  begin,
  callback,
  issuer,
  Jar,
  noStore,
  origin,
  pending,
  reportFixture,
  reportPath,
  session,
  type ReportFixture,
} from "./report-fixture.ts";

const reportTest = (name: string, run: () => Promise<void>) =>
  test(name, run, 15_000);
const random = "a".repeat(43);
const secure = "; Path=/; Secure; HttpOnly; SameSite=Lax";
const cookieHeader = (Cookie: string) => ({ headers: { Cookie } });
const logout = { method: "POST", headers: { Origin: origin } };
const refused = async (response: Promise<Response>, status: number) => {
  const reply = await response;
  expect(reply.status).toBe(status);
  noStore(reply);
  return reply;
};
async function page(f: ReportFixture, jar: Jar, signedIn: boolean, query = "") {
  const response = await refused(f.send("/app/" + query, jar), 200);
  const headers = response.headers;
  expect(headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  expect(headers.get("Referrer-Policy")).toBe("same-origin");
  expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(headers.get("X-Frame-Options")).toBe("DENY");
  expect(headers.get("Content-Security-Policy")).toContain(
    "form-action 'self'",
  );
  const body = await response.text();
  expect(body).toContain(signedIn ? "Sign out" : "Sign in");
  expect(body).not.toContain(signedIn ? "Sign in" : "Sign out");
  return body;
}

reportTest("report sign-in is bound and single-use", async () => {
  const f = reportFixture();
  const jar = new Jar();
  const start = await f.send("/app/sign-in?issue=fixture-12", jar);
  expect(start.status).toBe(302);
  noStore(start);
  const location = new URL(start.headers.get("Location")!);
  const state = location.searchParams.get("state")!;
  expect(state).toMatch(/^forge-report\.[\w-]{43}$/);
  expect(location.href.split("?")[0]).toBe(issuer + "/oauth/authorize");
  expect(location.searchParams.get("redirect_uri")).toBe(origin + "/callback");
  expect(location.searchParams.get("code_challenge_method")).toBe("S256");
  expect(location.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
  const pendingCookie = start.headers.getSetCookie()[0]!;
  expect(pendingCookie).toContain(pending + "=");
  expect(pendingCookie).toContain(secure + "; Max-Age=600");
  expect(pendingCookie).not.toMatch(/;\s*Domain=/i);
  expect(jar.get(pending)!.length).toBeLessThanOrEqual(1024);
  const second = await begin(f, new Jar());
  expect(second.searchParams.get("state")).not.toBe(state);
  expect(second.searchParams.get("code_challenge")).not.toBe(
    location.searchParams.get("code_challenge"),
  );
  const path = callback(state);
  for (const cookie of [
    "",
    jar.header() + "x",
    jar.header() + "; " + jar.header(),
    pending + "=" + "x".repeat(1025),
  ])
    await refused(f.send(path, new Jar(), cookieHeader(cookie)), 401);
  await refused(f.send(callback("forge-report." + random), jar), 401);
  expect(f.trace.durable).toEqual([]);
  expect(f.trace.exchanges).toEqual([]);
  const copy = new Jar(jar);
  const results = await Promise.all([f.send(path, jar), f.send(path, copy)]);
  expect(results.map(({ status }) => status).sort()).toEqual([303, 401]);
  const winner = results.find(({ status }) => status === 303)!;
  for (const result of results) noStore(result);
  expect(winner.headers.get("Location")).toBe("/app/?issue=fixture-12");
  const cookies = winner.headers.getSetCookie();
  expect(cookies).toHaveLength(2);
  expect(cookies[0]).toStartWith(active + "=");
  expect(cookies[1]).toStartWith(pending + "=");
  expect(cookies[1]).toContain("Max-Age=0");
  expect(f.trace.exchanges).toHaveLength(1);
  const verifier = f.trace.exchanges[0]!.get("code_verifier")!;
  expect(verifier).not.toBe(state.split(".")[1]);
  const digest = await crypto.subtle.digest("SHA-256", Buffer.from(verifier));
  expect(Buffer.from(digest).toString("base64url")).toBe(
    location.searchParams.get("code_challenge")!,
  );
  const replay = cookieHeader(pendingCookie.split(";")[0]!);
  await refused(f.send(path, new Jar(), replay), 401);
  expect(f.trace.exchanges).toHaveLength(1);
  const [claim, record] = [...f.objects.keys()];
  expect(claim).toBe(await sha256("report-login:" + state));
  expect(record).toMatch(/^forge-report-session:v1:[a-f0-9]{64}$/);
  expect(f.objects.size).toBe(2);
  expect(f.trace.projects).toEqual([]);
});

reportTest("report rejects expired sign-in", async () => {
  const f = reportFixture();
  const jar = new Jar();
  await refused(f.send("http://reports.example/app/sign-in"), 503);
  await refused(f.send("https://other.example/app/sign-in"), 503);
  for (const name of ["FORGE_OWNER_SUBJECT", "CODE_REDEMPTION"])
    await refused(f.send("/app/sign-in", jar, {}, { [name]: undefined }), 503);
  for (const query of [
    "?issue=",
    "?issue=a",
    "?issue=p-1&issue=p-2",
    "?issue=" + "p".repeat(199) + "-1",
  ])
    await refused(f.send("/app/sign-in" + query, jar), 400);
  const url = await begin(f, jar);
  f.advance(600_000);
  await refused(f.send(callback(url.searchParams.get("state")!), jar), 401);
  expect(f.trace.durable).toEqual([]);
  expect(f.trace.exchanges).toEqual([]);
});

reportTest("report session requires verified Clerk owner claims", async () => {
  for (const [claim, value, status] of [
    ["sub", "user_Other2", 403],
    ["iss", "https://other.example", 401],
    ["aud", "other-audience", 401],
    ["exp", 1, 401],
    ["auth_time", 2_000_000_000, 401],
  ] as const) {
    const f = reportFixture({ [claim]: value }),
      jar = new Jar();
    const url = await begin(f, jar);
    const reply = f.send(callback(url.searchParams.get("state")!), jar);
    await refused(reply, status);
    expect(jar.has(active)).toBe(false);
    expect(f.trace.exchanges).toHaveLength(1);
    expect(f.trace.durable).toHaveLength(1);
  }
});

reportTest("report logout revokes copies", async () => {
  const f = reportFixture();
  const jar = new Jar();
  const { response, record } = await session(f, jar);
  const cookie = response.headers.getSetCookie()[0]!;
  expect(cookie).toContain(secure + "; Max-Age=900");
  expect(cookie).not.toMatch(/;\s*Domain=/i);
  expect(record.values.get("report-session")).toBe(f.clock.now() + 900_000);
  expect(record.alarm.at).toBe(record.values.get("report-session")!);
  const copy = new Jar(jar);
  await page(f, jar, true);
  await page(f, copy, true);
  for (const headers of [
    {},
    { Origin: "https://other.example" },
    { Origin: origin + "/" },
  ])
    await refused(f.send("/app/logout", jar, { method: "POST", headers }), 403);
  await page(f, copy, true);
  f.fault.method = "DELETE";
  const failure = await refused(f.send("/app/logout", jar, logout), 503);
  expect(failure.headers.getSetCookie()).toEqual([]);
  await page(f, copy, true);
  f.fault.method = "";
  const revoked = await refused(f.send("/app/logout", jar, logout), 303);
  expect(revoked.headers.get("Location")).toBe("/app/");
  expect(revoked.headers.getSetCookie()[0]).toContain("Max-Age=0");
  expect(jar.has(active)).toBe(false);
  expect(record.values.size).toBe(0);
  await page(f, copy, false);
  await refused(f.send("/app/logout", copy, logout), 303);
  expect(f.trace.projects).toEqual([]);
});

reportTest("report expiry revokes copies", async () => {
  for (const removal of ["alarm", "read", "logout"]) {
    const f = reportFixture();
    const jar = new Jar();
    const { record } = await session(f, jar);
    const copy = new Jar(jar);
    f.advance(899_999);
    await page(f, copy, true);
    f.advance(1);
    if (removal === "alarm") await record.object.alarm();
    if (removal === "logout")
      await refused(f.send("/app/logout", jar, logout), 303);
    if (removal !== "read") expect(record.values.size).toBe(0);
    await page(f, copy, false);
    expect(record.values.size).toBe(0);
  }
});

reportTest("report page dispatch and cookies", async () => {
  const f = reportFixture();
  const jar = new Jar();
  await page(f, jar, false, "?issue=fixture-12");
  const { record } = await session(f, jar);
  expect(await page(f, jar, true, "?issue=fixture-12")).not.toContain(
    "fixture-12",
  );
  for (const [path, method, allow] of [
    ["/app/", "POST", "GET"],
    ["/app/sign-in", "POST", "GET"],
    ["/app/logout", "GET", "POST"],
    [callback("forge-report." + random), "POST", "GET"],
  ] as const) {
    const response = await refused(f.send(path, jar, { method }), 405);
    expect(response.headers.get("Allow")).toBe(allow);
  }
  const operations = f.trace.durable.length;
  await refused(f.send("/app", jar), 404);
  await refused(f.send("/app/unknown", jar), 404);
  for (const payload of [jar.get(active)! + "x", "x".repeat(1025)])
    await page(f, new Jar([[active, payload]]), false);
  const duplicate = new Jar([[active, jar.get(active)! + "; " + jar.header()]]);
  await page(f, duplicate, false);
  expect(record.values.size).toBe(1);
  expect(f.trace.durable).toHaveLength(operations);
  expect(f.trace.projects).toEqual([]);
});

reportTest("report session fails closed when the store fails", async () => {
  const f = reportFixture();
  const jar = new Jar();
  const url = await begin(f, jar);
  f.fault.method = "POST";
  await refused(f.send(callback(url.searchParams.get("state")!), jar), 503);
  expect(jar.has(active)).toBe(false);
  f.fault.method = "";
  await session(f, jar);
  f.fault.method = "GET";
  await refused(f.send("/app/", jar), 503);
});

reportTest("report refuses mixed callback state", async () => {
  const f = reportFixture();
  const jar = new Jar();
  const report = "forge-report." + random,
    device = "forge-device." + random,
    lane = "forge-lane." + random,
    oauth = random;
  for (const states of [
    [device, report],
    [lane, report],
    [device, lane],
    [device, lane, report],
    [oauth, report],
    [oauth, device],
    [oauth, lane],
    [report, report],
  ])
    for (const order of [states, [...states].reverse()]) {
      const response = await refused(f.send(callback(...order), jar), 400);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
  expect(f.trace.projects).toEqual([]);
  expect(f.trace.durable).toEqual([]);
  expect(f.trace.exchanges).toEqual([]);
});

reportTest("report cookies add no authority on existing routes", async () => {
  const f = reportFixture();
  const jar = new Jar();
  await session(f, jar);
  const operations = f.trace.durable.length;
  const reads =
    "/authorize /.well-known/oauth-authorization-server /.well-known/oauth-protected-resource /device /lane-approval/fixture /p/p/holder /p/p/status /p/p/dump".split(
      " ",
    );
  reads.push(
    ...["", "forge-device.", "forge-lane."].map((prefix) =>
      callback(prefix + random),
    ),
  );
  const writes =
    "/authorize /oauth/token /oauth/revoke /register /device /device/approve /device/deny /lane-approval/fixture/approve /lane-approval/fixture/deny".split(
      " ",
    );
  const routes =
    "loginstart loginpoll command state/read state/commit claim renew release restore upgrade devices revoke";
  writes.push(...routes.split(" ").map((route) => "/p/p/" + route));
  const normalize = (body: string) =>
    body.replace(/name="csrf" value="[\w-]+"/g, 'name="csrf" value=""');
  for (const [paths, method] of [
    [reads, "GET"],
    [writes, "POST"],
  ] as const)
    for (const path of paths) {
      const init =
        method === "POST"
          ? { method: "POST", body: "", headers: { Origin: origin } }
          : { method: "GET" };
      const reached = f.trace.projects.length;
      const before = await f.send(path, new Jar(), init);
      const baseline = f.trace.projects.length - reached;
      const writes = f.trace.writes.length;
      const withCookie = await f.send(path, new Jar(jar), init);
      const snapshot = async (reply: Response) => [
        reply.status,
        reply.headers.get("Location"),
        normalize(await reply.text()),
      ];
      expect(await snapshot(withCookie)).toEqual(await snapshot(before));
      expect(
        withCookie.headers
          .getSetCookie()
          .some((cookie) => cookie.startsWith(active)),
      ).toBe(false);
      expect(f.trace.writes).toHaveLength(writes);
      expect(f.trace.projects).toHaveLength(reached + 2 * baseline);
      if (path === "/p/p/upgrade")
        expect([withCookie.status, baseline]).toEqual([401, 0]);
    }
  for (const method of ["GET", "POST", "DELETE"]) {
    const headers = { "X-Forge-Owner": "fixture" };
    expect((await f.send(reportPath, jar, { method, headers })).status).toBe(
      404,
    );
  }
  expect(f.trace.durable).toHaveLength(operations);
  expect(f.trace.exchanges).toHaveLength(1);
});

reportTest("report cookies bind to identity", async () => {
  const f = reportFixture();
  const jar = new Jar();
  await session(f, jar);
  const names = [
    "device",
    "lane_preview",
    "report_login",
    "device_" + random.slice(0, 24),
    "lane_" + random.slice(0, 24),
  ];
  const headers = {
    Cookie: names
      .map((name) => "__Host-forge_" + name + "=" + random)
      .join("; "),
    Authorization: "Bearer fixture-admin",
  };
  const response = await refused(f.send("/app/", new Jar(), { headers }), 200);
  expect(await response.text()).toContain("Sign in");
  const operations = f.trace.durable.length;
  for (const overrides of [
    { FORGE_OWNER_SUBJECT: "user_Other2" },
    { FORGE_CLOUD_PROJECT: "other" },
  ]) {
    const changed = await refused(f.send("/app/", jar, {}, overrides), 200);
    expect(await changed.text()).toContain("Sign in");
  }
  expect(f.trace.durable).toHaveLength(operations);
  expect(f.trace.projects).toEqual([]);
});
