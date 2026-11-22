import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { authorityFault } from "../../cloud/src/v3-authority.ts";
import { readV3Value, recoverV3, viewV3 } from "../../cloud/src/v3-store.ts";
import { guardFixture, noWrites, probe } from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 3_600_000;
const expiry = time + 2 * ttlMs;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" };
const session = { id: "fixture" };
const holder = { actor, session };
const subject = "issue:work-1";
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor },
};
const initial = {
  id: "work-1",
  prefix: "forge",
  title: "Before",
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: new Date(time).toISOString(),
};

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
const headers = (owner = "laptop", expiresAt = expiry) => ({
  "X-Forge-Owner": owner,
  "X-Forge-Owner-Expires": String(expiresAt),
});
const send = (f: Fixture, body: object, owner?: string) =>
  f.send(`${probe}/command`, body, headers(owner));
const frames = ({ db }: Fixture) =>
  db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Json);
const error = (status: number, code: string) => ({
  status,
  body: { ok: false, error: { code } },
});

async function provision(f: Fixture) {
  expect(await f.send(probe, {})).toMatchObject({ status: 200 });
}

async function rawClaim(f: Fixture) {
  const reply = await f.send(
    `${probe}/claim`,
    { requestId: "raw-claim", subject, holder, ttlMs },
    headers(),
  );
  expect(reply).toMatchObject({
    status: 200,
    body: {
      value: {
        subject,
        generation: 1,
        holder: { actor, session: { ...session, device: "laptop" } },
      },
    },
  });
  return reply;
}

async function oneRow(
  f: Fixture,
  run: () => ReturnType<Fixture["send"]>,
  status = 200,
) {
  const before = frames(f).length;
  const effects = f.observeEffects();
  const response = await run();
  const { sqlWriteAttempts, alarmWrites } = effects();
  const { error } = response.body as { error?: { code: string } };
  expect({
    status: response.status,
    code: error?.code ?? null,
    commitRows: frames(f).length - before,
    sqlWriteAttempts,
    alarmWrites,
  }).toEqual({
    status,
    code: status === 200 ? null : "INPUT_INVALID",
    commitRows: 1,
    sqlWriteAttempts: 1,
    alarmWrites: 0,
  });
  return response;
}

function record(f: Fixture, key = "r1") {
  const db = writableStore(f.storage);
  const image = recoverV3(db);
  return {
    value: readV3Value(db, image, "record", key),
    revision: image.entries.record.get(key)?.revision,
  };
}

async function checkpoint(f: Fixture) {
  const db = writableStore(f.storage);
  const image = viewV3(recoverV3(db)).image;
  const { head } = image;
  expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject({
    status: 200,
    body: { value: { coveredHead: head, more: false } },
  });
  expect(frames(f)).toEqual([]);
  f.restart();
  expect(await f.send(probe)).toMatchObject({
    status: 200,
    body: { value: { image } },
  });
}

test(
  "v3 typed create writes one scoped result, record and event and replays it after collection",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const first = await oneRow(f, () => send(f, create));
    expect(first.body).toMatchObject({
      ok: true,
      op: create.op,
      status: "OK",
      result: { id: "forge-1", title: "Before", revision: 1 },
    });
    expect(record(f)).toEqual({ revision: 1, value: initial });
    const other = await oneRow(f, () => send(f, create, "tablet"));
    expect(other.body).toMatchObject({
      result: { id: "forge-2", revision: 1 },
    });
    expect(record(f, "r2")).toEqual({
      revision: 1,
      value: { ...initial, id: "work-2" },
    });
    for (const [i, owner] of ["laptop", "tablet"].entries()) {
      const principal = ["owner", owner, owner] as const;
      const frame = frames(f)[i]!;
      const scope = receiptScope(principal);
      expect(frame).toMatchObject({
        operation: create.op,
        events: [
          {
            key: `r${i + 1}`,
            revision: 1,
            value: { id: `work-${i + 1}`, title: "Before" },
          },
        ],
        outcome: {
          id: scopeRequestId("command", principal, create.requestId),
          scope: { family: "command", ...scope },
          status: "ok",
        },
      });
      expect(
        authorityFault({
          ...frame,
          outcome: {
            ...(frame.outcome as Json),
            scope: { family: "lease", ...scope },
          },
        }),
      ).toBe("outcome scope");
    }
    const invalid = {
      ...create,
      requestId: "graph",
      input: { ...create.input, dependsOn: ["forge-1"] },
    };
    const denied = await oneRow(f, () => send(f, invalid), 400);
    expect(frames(f).at(-1)).toMatchObject({
      events: [],
      outcome: { status: "INPUT_INVALID" },
    });
    expect(frames(f).at(-1)?.changes).toBeUndefined();
    await checkpoint(f);
    expect(record(f)).toEqual({ revision: 1, value: initial });
    expect(record(f, "r2")).toEqual({
      revision: 1,
      value: { ...initial, id: "work-2" },
    });
    const replay = f.observeEffects();
    expect(await send(f, create)).toEqual(first);
    expect(await send(f, create, "tablet")).toEqual(other);
    expect(
      await send(f, { ...create, input: { title: "Changed" } }),
    ).toMatchObject(error(409, "INPUT_CONFLICT"));
    expect(await send(f, invalid)).toEqual(denied);
    expect(await send(f, { ...invalid, input: create.input })).toMatchObject(
      error(409, "INPUT_CONFLICT"),
    );
    expect(replay()).toEqual(noWrites);
  },
  timeout,
);

test(
  "the ordinary command route refuses owner headers on v3 and the disabled selector refuses the probe",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const effects = f.observeEffects();
    expect(await f.send("command", create, headers())).toMatchObject(
      error(403, "AUTH_FORBIDDEN"),
    );
    f.restart(false);
    expect(await send(f, create)).toMatchObject(error(404, "UNKNOWN_COMMAND"));
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v2 typed create still uses v2 storage when the selector is enabled",
  async () => {
    const f = guardFixture(env);
    using db = f.db;
    f.restart(false);
    const device = await f.send("devices", { device: "laptop", ttlMs });
    expect(device.status).toBe(200);
    const { token } = (device.body as { value: { token: string } }).value;
    f.restart();
    expect(
      await f.send("command", create, { authorization: `Bearer ${token}` }),
    ).toMatchObject({
      status: 200,
      body: { ok: true, op: create.op, result: { id: "forge-1", revision: 1 } },
    });
    expect(
      db
        .query(
          "SELECT key, revision FROM state_records WHERE namespace='forge/work' AND key=?",
        )
        .all(subject),
    ).toEqual([{ key: subject, revision: 1 }]);
    expect(
      db
        .query("SELECT name FROM sqlite_schema WHERE name GLOB 'cloud_v3_*'")
        .all(),
    ).toEqual([]);
  },
  timeout,
);

test(
  "the raw v3 claim probe still writes once and replays its grant without another write",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const first = await oneRow(f, () => rawClaim(f));
    const replay = f.observeEffects();
    expect(await rawClaim(f)).toEqual(first);
    expect(replay()).toEqual(noWrites);
  },
  timeout,
);
