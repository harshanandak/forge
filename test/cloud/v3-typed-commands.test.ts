import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  issueToken,
  TOKEN_MIGRATION,
  tokenParts,
} from "../../cloud/src/tokens.ts";
import { readV3Value, recoverV3, viewV3 } from "../../cloud/src/v3-store.ts";
import { digestValue } from "../../src/core/config/pointer.ts";
import { guardFixture, noWrites, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
const ttlMs = 7_200_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const actor = { kind: "agent", id: "fixture" };
const session = { id: "fixture" };
const id = "forge-1";
const subject = "issue:work-1";
const calls = [
  {
    op: "issue.create",
    requestId: "create",
    input: { title: "Before" },
    context: { actor },
  },
  {
    op: "issue.claim",
    requestId: "claim",
    input: { id },
    context: { actor, session },
  },
  {
    op: "issue.update",
    requestId: "update",
    input: { id, expectRevision: 1, title: "After" },
    context: { actor, session, leaseGeneration: 1 },
  },
] as const;
const [create, claim, update] = calls;

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
const send = (f: Fixture, token: string, body: object) =>
  f.send("command", body, { authorization: `Bearer ${token}` });
const frames = ({ db }: Fixture) =>
  db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Json);
const recover = (f: Fixture) => recoverV3(writableStore(f.storage));

function collections(f: Fixture) {
  const db = writableStore(f.storage);
  const image = recoverV3(db);
  const read = (collection: keyof typeof image.entries) =>
    [...image.entries[collection]]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, slot]) => [
        key,
        slot.revision,
        readV3Value(db, image, collection, key),
      ]);
  return {
    record: read("record"),
    outcome: read("outcome"),
    witness: read("witness"),
    lease: read("lease"),
    recordFloor: image.recordFloor,
  };
}

async function device(f: Fixture, name: string) {
  const db = writableStore(f.storage);
  for (const statement of TOKEN_MIGRATION.statements) db.exec(statement);
  const result = await issueToken(
    db,
    {
      device: name,
      session: session.id,
      ttlMs,
      agent: null,
      harness: null,
    },
    time,
  );
  return result as { id: string; token: string };
}

async function restore(
  source: Fixture,
  target: Fixture,
  head: number,
  eventWatermark: number,
) {
  const exported = await source.send("dump");
  expect(exported).toMatchObject({
    status: 200,
    body: {
      ok: true,
      value: {
        manifest: {
          format: "forge-cloud-portable/3",
          head,
          eventWatermark,
          recordFloor: 1,
        },
      },
    },
  });
  const { manifest, pages } = (
    exported.body as {
      value: {
        manifest: Json;
        pages: { id: string; body: string }[];
      };
    }
  ).value;
  expect(pages.map(({ id }) => id)).toEqual([
    "directory:0",
    "snapshot:0",
    "transcript:0",
  ]);
  for (const [page, data] of pages.entries()) {
    expect(
      await target.send(
        "restore",
        { page, ...data, ...(page === 0 && { manifest }) },
        page === 0 ? { "X-Forge-Manifest-Digest": digestValue(manifest) } : {},
      ),
    ).toEqual({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  }
  return JSON.parse(pages[2]!.body) as Json[];
}

const refusal = (status: number, code: string) => ({
  status,
  body: { ok: false, error: { code } },
});

async function conflicts(f: Fixture, token: string, other: string) {
  expect(
    await send(f, token, { ...create, input: { title: "Different" } }),
  ).toMatchObject(refusal(409, "INPUT_CONFLICT"));
  expect(await send(f, other, claim)).toMatchObject(refusal(409, "LEASE_HELD"));
}

async function regressions(f: Fixture, token: string) {
  expect(
    await send(f, token, { ...update, requestId: "old-revision" }),
  ).toMatchObject(refusal(409, "REVISION_CONFLICT"));
  expect(
    await send(f, token, {
      ...update,
      requestId: "stale-fence",
      input: { ...update.input, expectRevision: 2 },
      context: { ...update.context, leaseGeneration: 2 },
    }),
  ).toMatchObject(refusal(409, "LEASE_STALE"));
  expect(
    await send(f, token, {
      ...update,
      requestId: "graph",
      input: { ...update.input, dependsOn: [id] },
    }),
  ).toMatchObject(refusal(400, "INPUT_INVALID"));
}

test(
  "v3 typed create, claim and update commit once and survive collection, restart and restore",
  async () => {
    const source = guardFixture(env);
    const target = guardFixture(env);
    using _sourceDb = source.db;
    using targetDb = target.db;
    expect(await source.send(probe, {})).toMatchObject({ status: 200 });
    const { id: tokenId, token } = await device(source, "laptop");
    const other = await device(source, "tablet");
    const results = [];
    const profile = [];
    for (const call of calls) {
      const before = frames(source).length;
      const writes = source.observeEffects();
      const got = await send(source, token, call);
      results.push(got);
      const { sqlWriteAttempts, alarmWrites } = writes();
      const { error } = got.body as { error?: { code: string } };
      profile.push([
        call.op,
        got.status,
        error?.code ?? null,
        frames(source).length - before,
        sqlWriteAttempts,
        alarmWrites,
      ]);
    }
    expect(profile).toEqual(calls.map(({ op }) => [op, 200, null, 1, 1, 0]));
    const lease = {
      subject,
      generation: 1,
      holder: { actor, session: { ...session, device: "laptop" } },
    };
    expect(results.map(({ body }) => body)).toMatchObject([
      {
        ok: true,
        op: create.op,
        status: "OK",
        result: { id, title: "Before", revision: 1 },
      },
      { ok: true, op: claim.op, status: "OK", result: { id, generation: 1 } },
      {
        ok: true,
        op: update.op,
        status: "OK",
        result: { id, title: "After", revision: 2 },
      },
    ]);
    const log = frames(source);
    const principal = ["token", tokenId, "laptop"] as const;
    const scope = { family: "command", ...receiptScope(principal) };
    for (const [i, { requestId, op }] of calls.entries()) {
      expect(log[i]).toMatchObject({
        sequence: i + 1,
        operation: op,
        outcome: {
          id: scopeRequestId("command", principal, requestId),
          scope,
          status: "ok",
        },
      });
    }
    expect(log[0]).toMatchObject({
      changes: [{ value: { revision: 1, value: { title: "Before" } } }],
      events: [{ key: subject, revision: 1 }],
    });
    expect(log[1]).toMatchObject({
      lease,
      events: [
        {
          key: subject,
          revision: 1,
          requestId: scopeRequestId("command", principal, claim.requestId),
          data: { lease },
        },
      ],
    });
    expect(log[2]).toMatchObject({
      changes: [{ value: { revision: 2, value: { title: "After" } } }],
      events: [{ key: subject, revision: 2 }],
    });
    const before = recover(source);
    const image = viewV3(before).image;
    const expected = collections(source);
    expect(expected.record).toHaveLength(1);
    expect(expected.outcome).toHaveLength(3);
    expect(expected.witness).toHaveLength(1);
    expect(expected.lease).toHaveLength(1);
    expect(expected.recordFloor).toBe(1);
    expect(await source.send(`${probe}/checkpoint`, {})).toMatchObject({
      status: 200,
      body: { value: { coveredHead: 3, more: false } },
    });
    expect(frames(source)).toEqual([]);
    source.restart();
    expect(await source.send(probe)).toMatchObject({
      status: 200,
      body: { value: { image } },
    });
    expect(collections(source)).toEqual(expected);
    const replay = source.observeEffects();
    for (const [i, call] of calls.entries())
      expect(await send(source, token, call)).toEqual(results[i]!);
    expect(replay()).toEqual(noWrites);

    setSystemTime(time + 1);
    const transcript = await restore(
      source,
      target,
      before.head,
      before.eventWatermark,
    );
    expect(
      transcript.map(({ sequence, operation, events }) => ({
        sequence,
        operation,
        events,
      })),
    ).toEqual(
      log.map(({ sequence, operation, events }) => ({
        sequence,
        operation,
        events,
      })),
    );
    target.restart();
    const restored = recover(target);
    const { lease: _liveLease, ...unchanged } = expected;
    expect(collections(target)).toEqual({
      ...unchanged,
      lease: [
        [
          subject,
          undefined,
          {
            ...readV3Value(
              writableStore(source.storage),
              before,
              "lease",
              subject,
            ),
            releasedAt: new Date(time + 1).toISOString(),
          },
        ],
      ],
    });
    expect(restored.head).toBe(before.head + 1);
    expect(restored.eventWatermark).toBe(before.eventWatermark + 1);
    expect(frames(target)).toMatchObject([{ operation: "restore.activate" }]);

    const { hash } = await tokenParts(token);
    for (const statement of TOKEN_MIGRATION.statements)
      targetDb.exec(statement);
    targetDb.run(
      "INSERT INTO domain_cloud_tokens (id, hash, device, session, expires_at) VALUES (?, ?, ?, ?, ?)",
      [tokenId, hash, "laptop", session.id, time + ttlMs],
    );
    const attempted = target.observeEffects();
    expect(await send(target, token, claim)).toMatchObject({
      status: 409,
      body: { ok: false },
    });
    expect(attempted()).toEqual(noWrites);

    const rejected = source.observeEffects();
    await conflicts(source, token, other.token);
    expect(rejected()).toEqual(noWrites);
    await regressions(source, token);
    const { record, lease: current } = collections(source);
    expect({ record, lease: current }).toEqual({
      record: expected.record,
      lease: expected.lease,
    });

    source.restart(false);
    const unselected = source.observeEffects();
    expect(await send(source, token, create)).toMatchObject({
      body: { ok: false },
    });
    expect(unselected()).toEqual(noWrites);
  },
  timeout,
);

test(
  "the v3 test selector preserves typed v2 commands and their refusals on a v2 project",
  async () => {
    const f = guardFixture(env);
    using db = f.db;
    f.restart(false);
    const provision = async (device: string) => {
      const response = await f.send("devices", {
        device,
        session: session.id,
        ttlMs,
      });
      expect(response.status).toBe(200);
      return (response.body as { value: { token: string } }).value.token;
    };
    const token = await provision("laptop");
    const other = await provision("tablet");
    f.restart();
    for (const call of calls)
      expect(await send(f, token, call)).toMatchObject({
        status: 200,
        body: { ok: true, op: call.op },
      });
    await conflicts(f, token, other);
    await regressions(f, token);
    expect(
      db
        .query("SELECT name FROM sqlite_schema WHERE name GLOB 'cloud_v3_*'")
        .all(),
    ).toEqual([]);
  },
  timeout,
);
