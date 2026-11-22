import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { guardFixture, probe } from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor: { kind: "agent", id: "fixture" } },
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;

const frames = ({ db }: Fixture) =>
  db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Json);
const tokenRows = ({ db }: Fixture) =>
  JSON.stringify(db.query("SELECT * FROM cloud_v3_tokens ORDER BY id").all());

async function issue(f: Fixture, device: string, session: string) {
  const reply = await f.send("devices", { device, session, ttlMs: 2 * ttlMs });
  expect(reply.status).toBe(200);
  return (reply.body as { value: { id: string; token: string } }).value;
}

test(
  "a v3 device token creates an issue through the ordinary command route as its own principal",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    expect((await f.send(probe, {})).status).toBe(200);
    const token = await issue(f, "laptop", "fixture");
    const rows = tokenRows(f);
    const before = frames(f).length;
    const effects = f.observeEffects();
    const reply = await f.send("command", create, {
      authorization: `Bearer ${token.token}`,
    });
    const { error } = reply.body as { error?: { code: string } };
    expect([reply.status, error?.code]).toEqual([200, undefined]);
    expect(reply.body).toMatchObject({
      ok: true,
      op: create.op,
      status: "OK",
      result: { id: "forge-1", title: "Before", revision: 1 },
    });
    const { sqlWriteAttempts, alarmWrites } = effects();
    expect({
      commitRows: frames(f).length - before,
      sqlWriteAttempts,
      alarmWrites,
    }).toEqual({ commitRows: 1, sqlWriteAttempts: 1, alarmWrites: 0 });
    expect(tokenRows(f)).toBe(rows);
    const principal = ["token", token.id, "laptop"] as const;
    expect(frames(f).at(-1)).toMatchObject({
      operation: create.op,
      outcome: {
        id: scopeRequestId("command", principal, create.requestId),
        scope: { family: "command", ...receiptScope(principal) },
        status: "ok",
      },
    });
  },
  timeout,
);
