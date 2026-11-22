import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { Project } from "../../cloud/src/project.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { authorityFault } from "../../cloud/src/v3-authority.ts";
import { readV3Value, recoverV3, viewV3 } from "../../cloud/src/v3-store.ts";
import {
  guardFixture,
  noWrites,
  probe,
  verifiedPortable,
} from "./v3-project.fixture.ts";

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
const update = {
  op: "issue.update",
  requestId: "update",
  input: { id: "forge-1", expectRevision: 1, title: "After" },
  context: { ...holder, leaseGeneration: 1 },
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
type Mode = "owner" | "token";
const modes: Mode[] = ["owner", "token"];
type Issued = { id: string; token: string };
const tokens = new WeakMap<Fixture, Map<string, Issued>>();
async function enroll(f: Fixture, mode: Mode) {
  if (mode === "owner") return;
  const issued = new Map<string, Issued>();
  for (const [device, session] of [
    ["laptop", "fixture"],
    ["tablet", "fixture"],
    ["laptop", "second"],
  ] as const) {
    const reply = await f.send("devices", {
      device,
      session,
      ttlMs: 2 * ttlMs,
    });
    expect(reply.status).toBe(200);
    issued.set(`${device}/${session}`, (reply.body as { value: Issued }).value);
  }
  tokens.set(f, issued);
}
const principalOf = (f: Fixture, device: string) =>
  tokens.has(f)
    ? (["token", tokens.get(f)!.get(`${device}/fixture`)!.id, device] as const)
    : (["owner", device, device] as const);
const tokenRows = (f: Fixture) =>
  tokens.has(f)
    ? JSON.stringify(
        f.db.query("SELECT * FROM cloud_v3_tokens ORDER BY id").all(),
      )
    : "";
const send = (
  f: Fixture,
  body: object,
  owner = "laptop",
  session = "fixture",
) => {
  const issued = tokens.get(f)?.get(`${owner}/${session}`);
  if (tokens.has(f) && issued === undefined) throw new Error("no such token");
  return issued
    ? f.send("command", body, { authorization: `Bearer ${issued.token}` })
    : f.send(`${probe}/command`, body, headers(owner));
};
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
  const rows = tokenRows(f);
  const effects = f.observeEffects();
  const response = await run();
  const { sqlWriteAttempts, alarmWrites } = effects();
  expect(tokenRows(f)).toBe(rows);
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
  const image = recoverV3(db, f.seal());
  return {
    value: readV3Value(db, image, "record", key),
    revision: image.entries.record.get(key)?.revision,
  };
}

async function checkpoint(f: Fixture) {
  const db = writableStore(f.storage);
  const { image, coveredHead: start } = viewV3(recoverV3(db, f.seal()));
  const { head } = image;
  let coveredHead = start;
  let reply: Awaited<ReturnType<Fixture["send"]>>;
  do {
    reply = await f.send(`${probe}/checkpoint`, {});
    expect(reply.status).toBe(200);
    const { value } = reply.body as {
      value: { coveredHead: number; more: boolean };
    };
    if (coveredHead < head)
      expect(value.coveredHead).toBeGreaterThan(coveredHead);
    expect(value.coveredHead).toBeLessThanOrEqual(head);
    expect(value.coveredHead - coveredHead).toBeLessThanOrEqual(12);
    coveredHead = value.coveredHead;
    expect(value.more).toBe(coveredHead < head);
  } while (coveredHead < head);
  expect(reply).toMatchObject({
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

test.each(modes)(
  "v3 typed create writes one scoped result, record and event and replays it after collection (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
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
      const principal = principalOf(f, owner);
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

function tamper(f: Fixture, sequence: number, edit: (frame: Json) => void) {
  const frame = frames(f)[sequence - 1]!;
  edit(frame);
  f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=?", [
    canonicalJson(frame),
    sequence,
  ]);
  f.restart();
}

for (const command of [create, update]) {
  test(
    `v3 refuses a coordinated stored ${command.op} edit after restart`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await oneRow(f, () => send(f, create));
      if (command === update) {
        await rawClaim(f);
        await oneRow(f, () => send(f, update));
      }
      tamper(f, frames(f).length, (frame) => {
        const event = (frame.events as Json[])[0]!;
        const change = (frame.changes as Json[])[0]!.value as Json;
        const result = (frame.outcome as Json).result as Json;
        const input = (event.patch ?? event.value) as Json;
        for (const value of [input, change.value as Json, result])
          value.title = "Edited in storage";
      });
      const effects = f.observeEffects();
      expect(await send(f, command)).toMatchObject(error(503, "UNAVAILABLE"));
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );
}

const refusalEdits: [string, (outcome: Json) => void][] = [
  [
    "swapped code",
    (outcome) => {
      const result = outcome.result as Json;
      outcome.status = "REVISION_CONFLICT";
      result.code = "REVISION_CONFLICT";
    },
  ],
  [
    "edited message",
    (outcome) => {
      (outcome.result as Json).message = "Edited in storage";
    },
  ],
  [
    "status turned into ok",
    (outcome) => {
      outcome.status = "ok";
    },
  ],
];

for (const [label, edit] of refusalEdits)
  test(
    `v3 refuses a stored update refusal with a ${label} after restart`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await oneRow(f, () => send(f, create));
      await updateRefusal(f, update, 409, "LEASE_NOT_HELD");
      tamper(f, 2, (frame) => edit(frame.outcome as Json));
      const effects = f.observeEffects();
      expect(await send(f, update)).toMatchObject(error(503, "UNAVAILABLE"));
      expect(frames(f)).toHaveLength(2);
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );

test(
  "v3 refuses a lowered stored retry deadline and does not run the same request again",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await oneRow(f, () => send(f, create));
    await updateRefusal(f, update, 409, "LEASE_NOT_HELD");
    await rawClaim(f);
    tamper(f, 2, (frame) => {
      (frame.outcome as Json).retryUntil = time + 1;
    });
    setSystemTime(time + 2);
    const effects = f.observeEffects();
    expect(await send(f, update)).toMatchObject(error(503, "UNAVAILABLE"));
    expect(frames(f)).toHaveLength(3);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

async function updateRefusal(
  f: Fixture,
  body: typeof update,
  status: number,
  code: string,
  owner?: string,
) {
  const before = frames(f).length;
  const rows = tokenRows(f);
  const effects = f.observeEffects();
  const response = await send(f, body, owner);
  expect(tokenRows(f)).toBe(rows);
  expect(response).toMatchObject(error(status, code));
  expect(frames(f)).toHaveLength(before + 1);
  expect(effects()).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
  expect(frames(f).at(-1)).toMatchObject({
    operation: update.op,
    events: [],
    outcome: { status: code },
  });
  expect(frames(f).at(-1)?.changes).toBeUndefined();
  const replay = f.observeEffects();
  expect(await send(f, body, owner)).toEqual(response);
  expect(
    await send(
      f,
      { ...body, input: { ...body.input, title: "Changed" } },
      owner,
    ),
  ).toMatchObject(error(409, "INPUT_CONFLICT"));
  expect(replay()).toEqual(noWrites);
}

test.each(modes)(
  "v3 typed update writes one row and preserves the revision and lease checks across collection (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await oneRow(f, () => send(f, create));
    await checkpoint(f);
    await rawClaim(f);
    const first = await oneRow(f, () => send(f, update));
    expect(first.body).toMatchObject({
      ok: true,
      op: update.op,
      status: "OK",
      result: {
        id: "forge-1",
        title: "After",
        revision: 2,
        lease: { generation: 1 },
      },
    });
    expect(frames(f).at(-1)).toMatchObject({
      operation: update.op,
      events: [
        {
          key: "r1",
          revision: 2,
          expectRevision: 1,
          patch: { title: "After" },
        },
      ],
      outcome: { status: "ok", result: { id: "forge-1", revision: 2 } },
    });
    await checkpoint(f);
    const replay = f.observeEffects();
    expect(await send(f, update)).toEqual(first);
    expect(
      await send(f, {
        ...update,
        input: { ...update.input, title: "Changed" },
      }),
    ).toMatchObject(error(409, "INPUT_CONFLICT"));
    expect(replay()).toEqual(noWrites);

    const current = { ...update.input, expectRevision: 2 };
    await updateRefusal(
      f,
      { ...update, requestId: "old-revision" },
      409,
      "REVISION_CONFLICT",
    );
    await updateRefusal(
      f,
      {
        ...update,
        requestId: "stale-fence",
        input: current,
        context: { ...update.context, leaseGeneration: 2 },
      },
      409,
      "LEASE_STALE",
    );
    await updateRefusal(
      f,
      { ...update, requestId: "other-holder", input: current },
      409,
      "LEASE_NOT_HELD",
      "tablet",
    );
    await updateRefusal(
      f,
      { ...update, requestId: "stale-revision-and-fence" },
      409,
      "LEASE_NOT_HELD",
      "tablet",
    );
    setSystemTime(time + ttlMs);
    await updateRefusal(
      f,
      { ...update, requestId: "expired-lease", input: current },
      409,
      "LEASE_EXPIRED",
    );
    const lost = f.observeEffects();
    expect(await send(f, update)).toMatchObject(error(409, "LEASE_STALE"));
    expect(lost()).toEqual(noWrites);
    await checkpoint(f);
    expect(record(f)).toEqual({
      revision: 2,
      value: { ...initial, title: "After" },
    });
  },
  timeout,
);

test.each(modes)(
  "v3 typed update records only refusals for bad input, a missing issue and an absent lease (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await oneRow(f, () => send(f, create));
    const graph = { ...update.input, dependsOn: ["forge-9"] };
    await updateRefusal(
      f,
      { ...update, requestId: "update-graph", input: graph },
      400,
      "INPUT_INVALID",
    );
    await updateRefusal(
      f,
      {
        ...update,
        requestId: "update-missing",
        input: { ...update.input, id: "forge-9" },
      },
      404,
      "NOT_FOUND",
    );
    await updateRefusal(f, update, 409, "LEASE_NOT_HELD");
    expect(record(f)).toEqual({ revision: 1, value: initial });
    expect(record(f, "r9")).toEqual({ revision: undefined, value: undefined });
  },
  timeout,
);

test(
  "v3 checkpoint refuses an update change that differs from the frame patch",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await oneRow(f, () => send(f, create));
    await rawClaim(f);
    await oneRow(f, () => send(f, update));
    tamper(f, 3, (frame) => {
      const [change] = frame.changes as Json[];
      ((change!.value as Json).value as Json).title = "Tampered";
    });
    const effects = f.observeEffects();
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(
      error(503, "UNAVAILABLE"),
    );
    expect(effects()).toEqual(noWrites);
    expect(frames(f)).toHaveLength(3);
  },
  timeout,
);

test(
  "v3 recovery, replay and checkpoint refuse a forged update result",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await oneRow(f, () => send(f, create));
    await rawClaim(f);
    await oneRow(f, () => send(f, update));
    tamper(f, 3, (frame) => {
      ((frame.outcome as Json).result as Json).title = "Invented";
    });
    const effects = f.observeEffects();
    expect(await f.send(probe)).toMatchObject(error(503, "UNAVAILABLE"));
    expect(await send(f, update)).toMatchObject(error(503, "UNAVAILABLE"));
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(
      error(503, "UNAVAILABLE"),
    );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "portable v3 recovery derives an update from its patch and refuses a forged change",
  async () => {
    const f = guardFixture(env);
    using db = f.db;
    await provision(f);
    expect(
      await f.send(`${probe}/commits`, {
        frames: [
          {
            operation: "fixture.put",
            time,
            events: [{ key: "r1", revision: 1, value: initial }],
            changes: [{ key: "r1", value: { revision: 1, value: initial } }],
          },
        ],
      }),
    ).toMatchObject({ status: 200 });
    await rawClaim(f);
    await oneRow(f, () => send(f, update));
    await checkpoint(f);
    const transcript = db
      .query<{ body: string }, []>(
        "SELECT body FROM cloud_v3_pages WHERE id='transcript:0'",
      )
      .get()!.body;
    const store = writableStore(f.storage);
    const verify = (portableTranscript: string) =>
      recoverV3(store, f.seal(), {
        admit: Project.admitLeaseRequest,
        manifest: verifiedPortable(f.seal(), portableTranscript),
        portableTranscript,
      });
    expect(readV3Value(store, verify(transcript), "record", "r1")).toEqual({
      ...initial,
      title: "After",
    });
    const receiptEdited = JSON.parse(transcript) as Json[];
    const outcome = receiptEdited[2]!.outcome as Json;
    outcome.resultDigest = `sha256:${"0".repeat(64)}`;
    expect(() => verify(canonicalJson(receiptEdited))).toThrow(
      "Cloud v3 root is unavailable",
    );
    const archived = JSON.parse(transcript) as Json[];
    const [change] = archived[2]!.changes as Json[];
    ((change!.value as Json).value as Json).title = "Tampered";
    expect(() => verify(canonicalJson(archived))).toThrow(
      "Cloud v3 root is unavailable",
    );
  },
  timeout,
);

test(
  "v3 recovery and checkpoint refuse a create frame whose receipt id collides with a live receipt",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await oneRow(f, () => send(f, create));
    await oneRow(f, () =>
      send(f, { ...create, requestId: "second", input: { title: "Second" } }),
    );
    const [first] = frames(f);
    tamper(f, 2, (frame) => {
      (frame.outcome as Json).id = (first!.outcome as Json).id;
    });
    expect(
      await send(f, { ...create, input: { title: "Second" } }),
    ).toMatchObject(error(503, "UNAVAILABLE"));
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(
      error(503, "UNAVAILABLE"),
    );
    expect(frames(f)).toHaveLength(2);
  },
  timeout,
);

for (const [fault, edit] of [
  [
    "a saved result that names another issue",
    (frame: Json) => {
      ((frame.outcome as Json).result as Json).id = "forge-2";
    },
  ],
  [
    "an event value that names another issue",
    (frame: Json) => {
      const [event] = frame.events as Json[];
      const [change] = frame.changes as Json[];
      (event!.value as Json).id = "work-2";
      ((change!.value as Json).value as Json).id = "work-2";
    },
  ],
] as const) {
  test(
    `v3 recovery refuses a create frame with ${fault}`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await oneRow(f, () => send(f, create));
      tamper(f, 1, edit);
      expect(await send(f, create)).toMatchObject(error(503, "UNAVAILABLE"));
    },
    timeout,
  );
}

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
    expect(await f.send("command", update, headers())).toMatchObject(
      error(403, "AUTH_FORBIDDEN"),
    );
    f.restart(false);
    expect(await send(f, create)).toMatchObject(error(404, "UNKNOWN_COMMAND"));
    expect(await send(f, update)).toMatchObject(error(404, "UNKNOWN_COMMAND"));
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
  "v2 typed update still uses the v2 writer when the selector is enabled",
  async () => {
    const f = guardFixture(env);
    using db = f.db;
    f.restart(false);
    const device = await f.send("devices", { device: "laptop", ttlMs });
    expect(device.status).toBe(200);
    const { token } = (device.body as { value: { token: string } }).value;
    f.restart();
    const auth = { authorization: `Bearer ${token}` };
    expect(await f.send("command", create, auth)).toMatchObject({
      status: 200,
    });
    expect(
      await f.send(
        "command",
        {
          op: "issue.claim",
          requestId: "claim",
          input: { id: "forge-1", ttlSeconds: 60 },
          context: holder,
        },
        auth,
      ),
    ).toMatchObject({ status: 200, body: { result: { generation: 1 } } });
    expect(await f.send("command", update, auth)).toMatchObject({
      status: 200,
      body: { result: { id: "forge-1", title: "After", revision: 2 } },
    });
    expect(
      db
        .query(
          "SELECT revision FROM state_records WHERE namespace='forge/work' AND key=?",
        )
        .get(subject),
    ).toEqual({ revision: 2 });
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

const typedClaim = {
  op: "issue.claim",
  requestId: "typed-claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: holder,
};

test.each(modes)(
  "v3 typed claim writes one lease, read set, result and witness and rechecks replay (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await oneRow(f, () => send(f, create));
    const first = await oneRow(f, () => send(f, typedClaim));
    const principal = principalOf(f, "laptop");
    const id = scopeRequestId("command", principal, typedClaim.requestId);
    const expiresAt = new Date(time + 60_000).toISOString();
    const result = { id: "forge-1", generation: 1, expiresAt };
    expect(first.body).toMatchObject({ ok: true, result });
    const frame = frames(f).at(-1)!;
    expect(frame).toMatchObject({
      operation: typedClaim.op,
      events: [{ readSet: [{ key: subject, expectRevision: 1 }] }],
      lease: {
        subject,
        holder: { actor, session: { ...session, device: "laptop" } },
        generation: 1,
        expiresAt,
      },
      outcome: {
        id,
        scope: { family: "command", ...receiptScope(principal) },
        status: "ok",
        result,
      },
      witness: {
        id,
        namespace: "forge/work",
        subject,
        generation: 1,
        digest: digestBytes(String((frame.outcome as Json).fingerprint)),
      },
    });
    expect(frame.changes).toBeUndefined();
    await claimRefusal(f, typedClaim, 409, "LEASE_HELD", "tablet");
    await oneRow(f, () => send(f, update));
    await oneRow(f, () =>
      f.send(
        `${probe}/renew`,
        { requestId: "renew", subject, holder, generation: 1, ttlMs },
        headers(),
      ),
    );
    await checkpoint(f);
    const replay = f.observeEffects();
    expect(await send(f, typedClaim)).toEqual(first);
    expect(
      await send(f, {
        ...typedClaim,
        input: { ...typedClaim.input, ttlSeconds: 30 },
      }),
    ).toMatchObject(error(409, "INPUT_CONFLICT"));
    for (const [changed, status, code] of [
      [
        { ...typedClaim, input: { ...typedClaim.input, id: "forge-2" } },
        409,
        "INPUT_CONFLICT",
      ],
      [
        { ...typedClaim, context: { ...holder, session: { id: "second" } } },
        mode === "token" ? 403 : 409,
        mode === "token" ? "AUTH_DEVICE_MISMATCH" : "INPUT_CONFLICT",
      ],
    ] as const) {
      expect(await send(f, changed)).toMatchObject(error(status, code));
    }
    expect(replay()).toEqual(noWrites);

    await oneRow(f, () =>
      f.send(
        `${probe}/release`,
        { requestId: "release", subject, holder, generation: 1 },
        headers(),
      ),
    );
    const released = f.observeEffects();
    expect(await send(f, typedClaim)).toMatchObject(error(409, "LEASE_STALE"));
    expect(released()).toEqual(noWrites);
    expect(
      (
        await oneRow(f, () =>
          send(f, { ...typedClaim, requestId: "next-claim" }),
        )
      ).body,
    ).toMatchObject({ result: { generation: 2 } });
    const db = writableStore(f.storage);
    expect(
      readV3Value(db, recoverV3(db, f.seal()), "lease", subject),
    ).toMatchObject({
      generation: 2,
    });
    await checkpoint(f);
  },
  timeout,
);

async function claimRefusal(
  f: Fixture,
  body: typeof typedClaim,
  status: number,
  code: string,
  owner?: string,
  as?: string,
) {
  const before = frames(f).length;
  const rows = tokenRows(f);
  const effects = f.observeEffects();
  const reply = await send(f, body, owner, as);
  expect(tokenRows(f)).toBe(rows);
  expect(reply).toMatchObject(error(status, code));
  expect(frames(f)).toHaveLength(before + 1);
  expect(effects()).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
  const frame = frames(f).at(-1)!;
  expect(frame).toMatchObject({
    operation: typedClaim.op,
    events: [],
    outcome: { status: code },
  });
  for (const member of ["changes", "lease", "witness"])
    expect(frame[member]).toBeUndefined();
  const replay = f.observeEffects();
  expect(await send(f, body, owner, as)).toEqual(reply);
  expect(replay()).toEqual(noWrites);
  return reply;
}

async function fixtureIssue(
  f: Fixture,
  value: Omit<typeof initial, "dependsOn"> & { dependsOn: string[] } = initial,
  revision = 1,
) {
  const key = `r${value.id.slice(5)}`;
  expect(
    await f.send(`${probe}/commits`, {
      frames: [
        {
          operation: "fixture.put",
          time,
          events: [{ key, revision, value }],
          changes: [{ key, value: { revision, value } }],
        },
      ],
    }),
  ).toMatchObject({ status: 200 });
}

test.each(modes)(
  "v3 typed claim records v2 refusals in check order without changing the issue or lease (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    const body = (name: string, ttlSeconds = 60, id = "forge-1") => ({
      ...typedClaim,
      requestId: name,
      input: { id, ttlSeconds },
    });
    await claimRefusal(f, body("not-found"), 404, "NOT_FOUND");
    await claimRefusal(f, body("bad-schema", 0), 400, "INPUT_INVALID");
    await fixtureIssue(f, { ...initial, status: "closed" });
    await claimRefusal(f, body("closed", 7_201), 409, "INPUT_CONFLICT");
    await fixtureIssue(f, { ...initial, id: "work-2", dependsOn: ["work-1"] });
    await oneRow(f, () => send(f, body("unblocked", 60, "forge-2")));
    await fixtureIssue(f, initial, 2);
    await claimRefusal(
      f,
      body("held-and-blocked", 60, "forge-2"),
      409,
      "LEASE_HELD",
    );
    await rawClaim(f);
    await fixtureIssue(f, {
      ...initial,
      id: "work-3",
      dependsOn: ["work-1", "work-9"],
    });
    const blocked = await claimRefusal(
      f,
      body("blocked", 7_201, "forge-3"),
      409,
      "CLAIM_BLOCKED",
    );
    expect(blocked.body).toMatchObject({
      error: {
        observed: {
          blockers: [
            {
              id: "forge-1",
              holder: { actor, session: { ...session, device: "laptop" } },
              holderUnverified: true,
            },
            { id: "forge-9" },
          ],
        },
      },
    });
    expect(
      (blocked.body as { error: { message: string } }).error.message,
    ).toContain("forge-1 (open)");
    expect(
      (blocked.body as { error: { message: string } }).error.message,
    ).toContain("forge-9 (missing)");
    await claimRefusal(f, body("ttl-before-held", 7_201), 400, "INPUT_INVALID");
    await claimRefusal(f, body("same-holder"), 409, "LEASE_HELD");
    await claimRefusal(
      f,
      {
        ...body("same-device"),
        context: { ...holder, session: { id: "second" } },
      },
      409,
      "LEASE_HELD",
      "laptop",
      "second",
    );
    setSystemTime(time + ttlMs);
    expect(
      (
        await claimRefusal(
          f,
          body("expired-blocker-holder", 60, "forge-3"),
          409,
          "CLAIM_BLOCKED",
        )
      ).body,
    ).toMatchObject({
      error: {
        observed: {
          blockers: [
            {
              id: "forge-1",
              holder: { actor, session: { ...session, device: "laptop" } },
              holderUnverified: true,
            },
            { id: "forge-9" },
          ],
        },
      },
    });
    expect(record(f)).toEqual({ value: initial, revision: 2 });
    expect(record(f, "r3").revision).toBe(1);
    await checkpoint(f);
  },
  timeout,
);

for (const loss of [
  "expiry",
  "takeover after expiry",
  "takeover after release",
] as const) {
  test(
    `v3 typed claim replay refuses ${loss} without replacing its receipt`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await fixtureIssue(f);
      await oneRow(f, () => send(f, typedClaim));
      if (loss === "takeover after release") {
        await oneRow(f, () =>
          f.send(
            `${probe}/release`,
            {
              requestId: "release",
              subject,
              holder,
              generation: 1,
            },
            headers(),
          ),
        );
      } else {
        setSystemTime(time + 60_000);
      }
      if (loss !== "expiry") {
        const next = {
          ...typedClaim,
          requestId: "takeover",
          context: { ...holder, session: { id: "second" } },
        };
        const owner = loss === "takeover after release" ? "tablet" : "laptop";
        expect(
          (await oneRow(f, () => send(f, next, owner))).body,
        ).toMatchObject({
          result: { generation: 2 },
        });
      }
      const effects = f.observeEffects();
      const replay = await send(f, typedClaim);
      expect(replay).toMatchObject(error(409, "LEASE_STALE"));
      expect((replay.body as Json).result).toBeUndefined();
      expect(
        await send(f, {
          ...typedClaim,
          input: { ...typedClaim.input, ttlSeconds: 61 },
        }),
      ).toMatchObject(error(409, "INPUT_CONFLICT"));
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );
}

const claimEdits: Record<string, (frame: Json) => void> = {
  lease: (frame) => {
    (frame.lease as Json).expiresAt = new Date(time + 61_000).toISOString();
  },
  witness: (frame) => {
    (frame.witness as Json).digest = `sha256:${"0".repeat(64)}`;
  },
  result: (frame) => {
    ((frame.outcome as Json).result as Json).id = "forge-2";
  },
  "read set": (frame) => {
    ((frame.events as Json[])[0]!.readSet as Json[])[0]!.expectRevision = 9;
  },
  generation: (frame) => {
    (frame.lease as Json).generation = 1;
    (frame.witness as Json).generation = 1;
    ((frame.outcome as Json).result as Json).generation = 1;
  },
};

for (const [field, edit] of Object.entries(claimEdits)) {
  test(
    `v3 recovery, replay and checkpoint reject a signed claim row with an inconsistent ${field}`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await fixtureIssue(f);
      await rawClaim(f);
      setSystemTime(time + ttlMs);
      await oneRow(f, () => send(f, typedClaim));
      const frame = frames(f)[2]!;
      edit(frame);
      const body = canonicalJson(frame);
      f.db.run("UPDATE cloud_v3_commits SET body=?, mac=? WHERE sequence=3", [
        body,
        f.sign(3, body),
      ]);
      f.restart();
      const effects = f.observeEffects();
      expect(await f.send(probe)).toMatchObject(error(503, "UNAVAILABLE"));
      expect(await send(f, typedClaim)).toMatchObject(
        error(503, "UNAVAILABLE"),
      );
      expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(
        error(503, "UNAVAILABLE"),
      );
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );
}

test(
  "v3 rejects a coordinated storage edit to the typed claim holder",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await fixtureIssue(f);
    await oneRow(f, () => send(f, typedClaim));
    const replacement = {
      actor: { ...actor, id: "other" },
      session: { id: "other", device: "tablet" },
    };
    tamper(f, 2, (frame) => {
      (frame.events as Json[])[0]!.holder = replacement;
      (frame.lease as Json).holder = replacement;
    });
    const effects = f.observeEffects();
    expect(await f.send(probe)).toMatchObject(error(503, "UNAVAILABLE"));
    expect(await send(f, typedClaim)).toMatchObject(error(503, "UNAVAILABLE"));
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(
      error(503, "UNAVAILABLE"),
    );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "portable v3 recovery rederives the claim and checks the archived result digest",
  async () => {
    const f = guardFixture(env);
    using db = f.db;
    await provision(f);
    await fixtureIssue(f);
    await oneRow(f, () => send(f, typedClaim));
    await checkpoint(f);
    const transcript = db
      .query<{ body: string }, []>(
        "SELECT body FROM cloud_v3_pages WHERE id='transcript:0'",
      )
      .get()!.body;
    const store = writableStore(f.storage);
    const verify = (portableTranscript: string) =>
      recoverV3(store, f.seal(), {
        admit: Project.admitLeaseRequest,
        manifest: verifiedPortable(f.seal(), portableTranscript),
        portableTranscript,
      });
    expect(
      readV3Value(store, verify(transcript), "lease", subject),
    ).toMatchObject({ generation: 1 });
    for (const edit of [
      claimEdits.lease!,
      claimEdits.witness!,
      (frame: Json) => {
        (frame.outcome as Json).resultDigest = `sha256:${"0".repeat(64)}`;
      },
    ]) {
      const edited = JSON.parse(transcript) as Json[];
      edit(edited[1]!);
      expect(() => verify(canonicalJson(edited))).toThrow(
        "Cloud v3 root is unavailable",
      );
    }
  },
  timeout,
);

test(
  "the ordinary command route and disabled selector refuse typed claim on v3",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const effects = f.observeEffects();
    expect(await f.send("command", typedClaim, headers())).toMatchObject(
      error(403, "AUTH_FORBIDDEN"),
    );
    f.restart(false);
    expect(await send(f, typedClaim)).toMatchObject(
      error(404, "UNKNOWN_COMMAND"),
    );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);
