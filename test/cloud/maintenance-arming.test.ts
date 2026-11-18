import { expect, spyOn, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
import { createWorker } from "../../cloud/src/worker.ts";
import { fixture as projectFixture } from "./dump-capacity.fixture.ts";
import { actor } from "../core/l5-state/retention.fixture.ts";
import type { DurableStorage } from "../../cloud/src/store.ts";

async function armed() {
  const p = await projectFixture();
  const issued = await p.send("devices", {
    device: "arming",
    ttlMs: 86400000,
  });
  const token = (issued.value as unknown as { token: string }).token;
  const storage: DurableStorage = p.storage;
  const times: number[] = [];
  const state = { fail: false };
  storage.getAlarm = () => Promise.resolve(null);
  storage.setAlarm = (time) => {
    if (state.fail) return Promise.reject(new Error("alarm unavailable"));
    times.push(time);
    return Promise.resolve();
  };
  const project = new Project(
    { storage },
    { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" },
  );
  const request = (route: string, body?: unknown) =>
    new Request(`https://fixture.example/p/a/${route}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const post = (route: string, body: unknown) =>
    project.fetch(request(route, body));
  const claim = (requestId: string, ttlMs: number) =>
    post("claim", {
      subject: "alarm",
      requestId,
      ttlMs,
      holder: { actor, session: { id: "raw" } },
    });
  return { p, project, state, times, post, claim, request };
}

test("a refused claim still arms maintenance for its denial witness", async () => {
  const s = await armed();
  const response = await s.claim("refused", 172_800_000);
  expect(response.status).not.toBe(200);
  expect(
    s.p.db.query("SELECT outcome FROM domain_cloud_requests").all(),
  ).toEqual([{ outcome: "INPUT_INVALID" }]);
  expect(s.times).toHaveLength(1);
}, 30_000);

test("a failed arm refuses the claim before anything is written and a retry succeeds", async () => {
  const s = await armed();
  s.state.fail = true;
  expect((await s.claim("retry", 1000)).status).toBe(500);
  expect(s.p.db.query("SELECT * FROM state_leases").all()).toEqual([]);
  expect(s.p.db.query("SELECT * FROM domain_cloud_requests").all()).toEqual([]);
  s.state.fail = false;
  expect((await s.claim("retry", 1000)).status).toBe(200);
  expect(s.times).toHaveLength(1);
}, 30_000);

test("a restore staged during the arm cannot let an owner write through", async () => {
  const s = await armed();
  const storage = s.p.storage;
  storage.setAlarm = async () => {
    await storage.put("restore:next", { staged: true });
  };
  const response = await s.project.fetch(
    new Request("https://fixture.example/p/a/claim", {
      method: "POST",
      headers: {
        "X-Forge-Owner": "phone",
        "X-Forge-Owner-Expires": String(Date.now() + 100_000),
      },
      body: JSON.stringify({
        subject: "alarm",
        requestId: "staged",
        ttlMs: 1000,
        holder: { actor, session: { id: "raw" } },
      }),
    }),
  );
  expect(response.status).toBe(409);
  expect(s.p.db.query("SELECT * FROM state_leases").all()).toEqual([]);
}, 30_000);

test("a refused write command still arms maintenance", async () => {
  const s = await armed();
  const response = await s.post("command", {
    op: "issue.comment",
    input: {},
    requestId: "refused-command",
    context: { actor },
  });
  expect(response.status).not.toBe(200);
  expect(s.times).toHaveLength(1);
}, 30_000);

test("a committed command returns and replays its result when the alarm fails", async () => {
  const s = await armed();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    s.state.fail = true;
    const body = {
      op: "issue.create",
      input: { title: "Alarm failure" },
      requestId: "committed",
      context: { actor },
    };
    const worker = createWorker();
    const send = () =>
      worker.fetch(s.request("command", body), {
        FORGE_CLOUD_PROJECT: "a",
        PROJECTS: { idFromName: () => "a", get: () => s.project },
      });
    const first = await send();
    expect(first.status).toBe(200);
    const result = await first.json();
    expect(result).toMatchObject({
      ok: true,
      status: "OK",
      result: { id: "forge-1" },
    });
    const retry = await send();
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(result);
    expect(
      s.p.db.query("SELECT outcome FROM domain_cloud_command_receipts").all(),
    ).toEqual([{ outcome: "ok" }]);
    expect(
      s.p.db
        .query("SELECT key FROM state_records WHERE key LIKE 'issue:%'")
        .all(),
    ).toEqual([{ key: "issue:work-1" }]);
    expect(log).toHaveBeenCalledTimes(2);
  } finally {
    log.mockRestore();
  }
}, 30_000);

test("a refused command keeps its FAIL envelope and discards after a failed arm", async () => {
  const s = await armed();
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    s.state.fail = true;
    const request = s.request("command", {
      op: "issue.create",
      input: {},
      requestId: "denied",
      context: { actor },
    });
    const body = request.body;
    let bodyReads = 0;
    Object.defineProperty(request, "body", {
      get: () => {
        bodyReads++;
        return body;
      },
    });
    const response = await s.project.fetch(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "FAIL",
      error: { code: "INPUT_INVALID", retry: "never" },
      warnings: [],
    });
    expect(bodyReads).toBe(2);
    expect(
      s.p.db.query("SELECT outcome FROM domain_cloud_command_receipts").all(),
    ).toEqual([{ outcome: "refused" }]);
    expect(log).toHaveBeenCalledTimes(1);
  } finally {
    log.mockRestore();
  }
}, 30_000);

test("a landed lease request replays while alarm arming fails", async () => {
  const s = await armed();
  const first = await s.claim("landed", 60_000);
  expect(first.status).toBe(200);
  const recorded = await first.json();
  s.state.fail = true;
  const restarted = new Project(
    { storage: s.p.storage },
    { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" },
  );
  const response = await restarted.fetch(
    s.request("claim", {
      subject: "alarm",
      requestId: "landed",
      ttlMs: 60_000,
      holder: { actor, session: { id: "raw" } },
    }),
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(recorded);
  expect(
    s.p.db.query("SELECT outcome FROM domain_cloud_requests").all(),
  ).toEqual([{ outcome: "ok" }]);
}, 30_000);

test("holder and every issue read command never arm maintenance", async () => {
  const s = await armed();
  const arm = spyOn(s.p.storage, "setAlarm");
  s.state.fail = true;
  expect(
    (await s.project.fetch(s.request("holder?subject=alarm"))).status,
  ).toBe(200);
  for (const op of [
    "issue.show",
    "issue.comments",
    "issue.links",
    "issue.list",
    "issue.ready",
    "issue.blocked",
    "issue.stale",
  ]) {
    const response = await s.post("command", {
      op,
      input:
        op === "issue.show" || op === "issue.comments" || op === "issue.links"
          ? { id: "forge-1" }
          : {},
      requestId: op,
      context: { actor },
    });
    expect([200, 404]).toContain(response.status);
  }
  expect(arm).not.toHaveBeenCalled();
}, 30_000);
