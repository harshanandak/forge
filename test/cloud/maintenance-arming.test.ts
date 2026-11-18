import { expect, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
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
  const post = (route: string, body: unknown) =>
    project.fetch(
      new Request(`https://fixture.example/p/a/${route}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    );
  const claim = (requestId: string, ttlMs: number) =>
    post("claim", {
      subject: "alarm",
      requestId,
      ttlMs,
      holder: { actor, session: { id: "raw" } },
    });
  return { p, state, times, post, claim };
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
