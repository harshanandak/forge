import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import {
  receiptScope,
  scopeRequestId,
} from "../../cloud/src/issue-request-id.ts";
import { failed } from "../../cloud/src/issue-commands.ts";
import { Project } from "../../cloud/src/project.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import contextSchema from "../../schemas/context.json" with { type: "json" };
import { exitCode } from "../../src/surface/result.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { authorityFault } from "../../cloud/src/v3-authority.ts";
import { signToken } from "../../cloud/src/v3-seal.ts";
import { readV3Value, recoverV3, viewV3 } from "../../cloud/src/v3-store.ts";
import {
  guardFixture,
  noWrites,
  probe,
  recovered,
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

const exits: Record<string, number> = {
  INPUT_INVALID: 6,
  NOT_FOUND: 3,
  UNKNOWN_COMMAND: 3,
  INPUT_CONFLICT: 4,
  REVISION_CONFLICT: 4,
  LEASE_HELD: 4,
  LEASE_STALE: 4,
  LEASE_NOT_HELD: 4,
  LEASE_EXPIRED: 4,
};
function exited(response: { body: unknown }, code?: string) {
  const body = response.body as { status?: string; error?: ForgeError };
  expect(
    exitCode(
      "status" in body
        ? (response.body as ReturnType<typeof failed>)
        : failed(body.error!),
    ),
  ).toBe(code === undefined ? 0 : (exits[code] ?? 1));
}
function refused(
  response: { status: number; body: unknown },
  status: number,
  code: string,
) {
  expect(response).toMatchObject(error(status, code));
  exited(response, code);
}
function deadlines(f: Fixture, before: number) {
  if (!tokens.has(f)) return;
  for (const frame of frames(f).slice(before)) {
    const outcome = frame.outcome as Json | undefined;
    if ((outcome?.scope as Json | undefined)?.family === "command")
      expect(outcome?.retryUntil).toBe(expiry);
  }
}

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
  const reply = response.body as Json;
  if ("op" in reply || "error" in reply)
    exited(response, status === 200 ? undefined : "INPUT_INVALID");
  deadlines(f, before);
  return response;
}

function record(f: Fixture, key = "r1") {
  const db = writableStore(f.storage);
  const image = recovered(db, f.seal());
  return {
    value: readV3Value(db, image, "record", key),
    revision: image.entries.record.get(key)?.revision,
  };
}

async function checkpoint(f: Fixture) {
  const db = writableStore(f.storage);
  const { image, coveredHead: start } = viewV3(recovered(db, f.seal()));
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
    refused(
      await send(f, { ...create, input: { title: "Changed" } }),
      409,
      "INPUT_CONFLICT",
    );
    expect(await send(f, invalid)).toEqual(denied);
    refused(
      await send(f, { ...invalid, input: create.input }),
      409,
      "INPUT_CONFLICT",
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
  refused(response, status, code);
  expect(frames(f)).toHaveLength(before + 1);
  deadlines(f, before);
  expect(effects()).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
  expect(frames(f).at(-1)).toMatchObject({
    operation: update.op,
    events: [],
    outcome: { status: code },
  });
  expect(frames(f).at(-1)?.changes).toBeUndefined();
  const replay = f.observeEffects();
  expect(await send(f, body, owner)).toEqual(response);
  refused(
    await send(
      f,
      { ...body, input: { ...body.input, title: "Changed" } },
      owner,
    ),
    409,
    "INPUT_CONFLICT",
  );
  expect(replay()).toEqual(noWrites);
  return response;
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
    refused(
      await send(f, {
        ...update,
        input: { ...update.input, title: "Changed" },
      }),
      409,
      "INPUT_CONFLICT",
    );
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
    refused(await send(f, update), 409, "LEASE_STALE");
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
    const patched = JSON.parse(transcript) as Json[];
    ((patched[2]!.events as Json[])[0]!.patch as Json).title = "Patched";
    expect(() => verify(canonicalJson(patched))).toThrow(
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
    refused(
      await send(f, {
        ...typedClaim,
        input: { ...typedClaim.input, ttlSeconds: 30 },
      }),
      409,
      "INPUT_CONFLICT",
    );
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
      refused(await send(f, changed), status, code);
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
    refused(await send(f, typedClaim), 409, "LEASE_STALE");
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
      readV3Value(db, recovered(db, f.seal()), "lease", subject),
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
  refused(reply, status, code);
  expect(frames(f)).toHaveLength(before + 1);
  deadlines(f, before);
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

const never = (code: string, message: string) => ({
  code,
  message,
  retry: "never",
});
const wire = (reply: { body: unknown }) =>
  (reply.body as { error: unknown }).error;
type Reply = Awaited<ReturnType<Fixture["send"]>>;
type Seen = [object, string | undefined, Reply][];
const upd = (
  requestId: string,
  input: object,
  context: object = update.context,
) => ({ ...update, requestId, input, context }) as typeof update;
const clm = (requestId: string, input: object) =>
  ({ ...typedClaim, requestId, input }) as typeof typedClaim;

function lease(f: Fixture) {
  const db = writableStore(f.storage);
  const stored = readV3Value(db, recovered(db, f.seal()), "lease", subject);
  const { holder, generation, expiresAt } = stored as unknown as {
    holder: object;
    generation: number;
    expiresAt: string;
  };
  return { subject, holder, generation, expiresAt };
}
const heldBy = (l: ReturnType<typeof lease>) =>
  `${l.subject} is leased by device laptop, agent fixture, harness unspecified, session fixture until ${l.expiresAt}`;
const leased = (code: string, message: string, member: object) => ({
  code,
  message,
  retry: "reconcile_first",
  lease: member,
});

async function replayed(f: Fixture, seen: Seen) {
  await checkpoint(f);
  const effects = f.observeEffects();
  for (const [body, owner, reply] of seen) {
    expect(await send(f, body, owner)).toEqual(reply);
    const changed = await send(f, { ...body, input: { changed: true } }, owner);
    expect(wire(changed)).toEqual({
      code: "INPUT_CONFLICT",
      message: "Request ID belongs to a different input",
      retry: "reconcile_first",
    });
    expect(changed.status).toBe(409);
    exited(changed, "INPUT_CONFLICT");
  }
  expect(effects()).toEqual(noWrites);
}

test.each(modes)(
  "v3 typed create records the exact refusal for each bad input (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    const seen: Seen = [];
    for (const [name, input, message] of [
      [
        "graph",
        { title: "Before", parent: "forge-1" },
        "Parent and dependencies are not supported in cloud yet",
      ],
      ["schema", {}, "input must be a valid issue.create input"],
      [
        "kind",
        { title: "Before", kind: "chore" },
        "kind must be one of task, bug, feature, epic",
      ],
    ] as const) {
      const body = { ...create, requestId: name, input };
      const before = snap(f);
      const reply = await oneRow(f, () => send(f, body), 400);
      expect(wire(reply)).toEqual(never("INPUT_INVALID", message));
      expect(frames(f).at(-1)).toMatchObject({ events: [] });
      expect(frames(f).at(-1)?.changes).toBeUndefined();
      expect(snap(f)).toEqual(before);
      seen.push([body, undefined, reply]);
    }
    expect(record(f)).toEqual({ revision: undefined, value: undefined });
    await replayed(f, seen);
  },
  timeout,
);

test.each(modes)(
  "v3 typed update records the exact error object for every refusal (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await oneRow(f, () => send(f, create));
    const seen: Seen = [];
    const refuse = async (
      name: string,
      input: object,
      status: number,
      error: object,
      owner?: string,
      context?: object,
    ) => {
      const body = upd(name, input, context);
      const code = (error as ForgeError).code;
      const before = snap(f);
      const reply = await updateRefusal(f, body, status, code, owner);
      expect(wire(reply)).toEqual(error);
      expect(snap(f)).toEqual(before);
      seen.push([body, owner, reply]);
    };
    const bad = (message: string) => never("INPUT_INVALID", message);
    const graph =
      "Kind, parent and dependencies are not supported in cloud yet";
    await refuse("graph", { ...update.input, parent: "x" }, 400, bad(graph));
    await refuse(
      "schema",
      { id: "forge-1" },
      400,
      bad("input must be a valid issue.update input"),
    );
    await refuse(
      "shape",
      { ...update.input, id: "bad" },
      400,
      bad("Invalid issue id"),
    );
    await refuse(
      "prefix",
      { ...update.input, id: "other-1" },
      400,
      bad("Unknown issue id prefix"),
    );
    await refuse(
      "missing",
      { ...update.input, id: "forge-9" },
      404,
      never("NOT_FOUND", "Issue was not found"),
    );
    await refuse(
      "no-lease",
      update.input,
      409,
      leased("LEASE_NOT_HELD", `${subject} has no lease`, { subject }),
    );
    await rawClaim(f);
    await oneRow(f, () => send(f, update));
    const l = lease(f);
    const current = { ...update.input, expectRevision: 2 };
    await refuse("revision", update.input, 409, {
      code: "REVISION_CONFLICT",
      message: "Expected revision 1; current revision is 2",
      retry: "reconcile_first",
      currentRevision: 2,
    });
    await refuse(
      "stale",
      current,
      409,
      leased(
        "LEASE_STALE",
        `generation 2 is not the current generation 1 of ${subject}`,
        l,
      ),
      undefined,
      { ...update.context, leaseGeneration: 2 },
    );
    const notHeld = (m: ReturnType<typeof lease>) =>
      leased(
        "LEASE_NOT_HELD",
        `${heldBy(m)}; this caller does not hold that lease`,
        m,
      );
    await refuse("other", current, 409, notHeld(l), "tablet");
    setSystemTime(time + ttlMs);
    await refuse(
      "expired",
      current,
      409,
      leased(
        "LEASE_EXPIRED",
        `the lease on ${subject} expired at ${l.expiresAt}; a lapsed lease is reacquired, never renewed`,
        l,
      ),
    );
    await oneRow(f, () => send(f, { ...typedClaim, requestId: "again" }));
    await oneRow(f, () =>
      f.send(
        `${probe}/release`,
        { requestId: "release", subject, holder, generation: 2 },
        headers(),
      ),
    );
    const released = lease(f);
    await refuse("released", current, 409, notHeld(released), undefined, {
      ...update.context,
      leaseGeneration: 2,
    });
    const lost = f.observeEffects();
    expect(wire(await send(f, update))).toEqual(
      leased(
        "LEASE_STALE",
        `Request no longer matches the current lease on ${subject}`,
        released,
      ),
    );
    expect(lost()).toEqual(noWrites);
    const again = f.observeEffects();
    const stale = await send(f, update);
    expect(stale.status).toBe(409);
    exited(stale, "LEASE_STALE");
    expect(again()).toEqual(noWrites);
    await replayed(f, seen);
  },
  timeout,
);

test.each(modes)(
  "v3 typed claim records the exact error object for every refusal (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    const seen: Seen = [];
    const refuse = async (
      name: string,
      input: object,
      status: number,
      error: object,
    ) => {
      const body = clm(name, input);
      const code = (error as ForgeError).code;
      const before = snap(f);
      const reply = await claimRefusal(f, body, status, code);
      expect(wire(reply)).toEqual(error);
      expect(snap(f)).toEqual(before);
      seen.push([body, undefined, reply]);
    };
    const bad = (message: string) => never("INPUT_INVALID", message);
    const ok = { id: "forge-1", ttlSeconds: 60 };
    await refuse("shape", {}, 400, bad("Expected a valid issue claim"));
    await refuse("id", { ...ok, id: "bad" }, 400, bad("Invalid issue id"));
    await refuse(
      "prefix",
      { ...ok, id: "other-1" },
      400,
      bad("Unknown issue id prefix"),
    );
    await refuse(
      "missing",
      { ...ok, id: "forge-9" },
      404,
      never("NOT_FOUND", "Issue forge-9 was not found"),
    );
    await fixtureIssue(f, { ...initial, status: "closed" });
    await refuse(
      "closed",
      ok,
      409,
      never("INPUT_CONFLICT", "Closed issues cannot be claimed"),
    );
    await fixtureIssue(f, initial, 2);
    await rawClaim(f);
    const l = lease(f);
    await refuse(
      "held",
      ok,
      409,
      leased(
        "LEASE_HELD",
        `${heldBy(l)}; read its state to reconcile instead of retrying`,
        l,
      ),
    );
    await fixtureIssue(f, {
      ...initial,
      id: "work-3",
      dependsOn: ["work-1", "work-9"],
    });
    const owner = { actor, session: { ...session, device: "laptop" } };
    await refuse("blocked", { ...ok, id: "forge-3" }, 409, {
      code: "CLAIM_BLOCKED",
      message:
        'forge-1 (open) {"actor":{"id":"fixture","kind":"agent"},"session":{"device":"laptop","id":"fixture"}}, forge-9 (missing) ',
      retry: "never",
      observed: {
        blockers: [
          { id: "forge-1", holder: owner, holderUnverified: true },
          { id: "forge-9" },
        ],
      },
    });
    await fixtureIssue(f, { ...initial, id: "work-4" });
    await refuse(
      "cap",
      { id: "forge-4", ttlSeconds: 86_401 },
      400,
      bad("ttlMs is over 24 hours"),
    );
    await refuse(
      "expiry",
      { id: "forge-4", ttlSeconds: 7_201 },
      400,
      bad("ttlMs would exceed the token expiry"),
    );
    await replayed(f, seen);
  },
  timeout,
);

test.each(modes)(
  "v3 typed claim replay after the lease lapsed returns the exact rewritten LEASE_STALE (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await fixtureIssue(f);
    await oneRow(f, () => send(f, typedClaim));
    const l = lease(f);
    setSystemTime(time + 60_000);
    const effects = f.observeEffects();
    const reply = await send(f, typedClaim);
    expect(reply.status).toBe(409);
    exited(reply, "LEASE_STALE");
    expect(wire(reply)).toEqual(
      leased(
        "LEASE_STALE",
        `Request no longer matches the current lease on ${subject}`,
        l,
      ),
    );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test.each([
  [
    "structure",
    {},
    400,
    never("INPUT_INVALID", "Expected a valid issue claim"),
  ],
  [
    "id shape",
    { id: "bad", ttlSeconds: 60 },
    400,
    never("INPUT_INVALID", "Invalid issue id"),
  ],
  [
    "unknown prefix",
    { id: "other-1", ttlSeconds: 60 },
    400,
    never("INPUT_INVALID", "Unknown issue id prefix"),
  ],
  [
    "resolved id",
    typedClaim.input,
    409,
    never("LEASE_STALE", "The claim receipt expired"),
  ],
] as const)(
  "v3 typed claim with an expired receipt and a live owner: %s",
  async (_name, input, status, error) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await fixtureIssue(f);
    await oneRow(f, () => send(f, typedClaim));
    const before = {
      count: frames(f).length,
      issue: record(f),
      lease: lease(f),
    };
    setSystemTime(expiry + 1);
    const effects = f.observeEffects();
    const reply = await f.send(
      `${probe}/command`,
      { ...typedClaim, input },
      headers("laptop", expiry + 1 + 2 * ttlMs),
    );
    expect(reply.status).toBe(status);
    expect(wire(reply)).toEqual(error);
    exited(reply, error.code);
    expect(record(f)).toEqual(before.issue);
    expect(lease(f)).toEqual(before.lease);
    if (status === 409) {
      expect(effects()).toEqual(noWrites);
      expect(frames(f)).toHaveLength(before.count);
      return;
    }
    expect(effects()).toMatchObject({ sqlWriteAttempts: 1, alarmWrites: 0 });
    expect(frames(f)).toHaveLength(before.count + 1);
    const frame = frames(f).at(-1)!;
    expect(frame).toMatchObject({
      events: [],
      outcome: { status: "INPUT_INVALID" },
    });
    for (const member of ["changes", "lease", "witness"])
      expect(frame[member]).toBeUndefined();
  },
  timeout,
);

test.each([
  [
    "a successful create",
    { title: "Before" },
    200,
    "Request replay window ended; use a fresh request ID",
  ],
  [
    "a refused create",
    {},
    400,
    "Request ID remains refused; use a fresh request ID",
  ],
] as const)(
  "v3 typed replay after the 24-hour window of %s is refused without a write",
  async (_name, input, status, message) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const body = { ...create, input };
    const owner = headers("laptop", time + 2 * 86_400_000);
    const first = await f.send(`${probe}/command`, body, owner);
    expect(first.status).toBe(status);
    setSystemTime(time + 86_400_000 + 1);
    const effects = f.observeEffects();
    const reply = await f.send(`${probe}/command`, body, owner);
    expect(reply.status).toBe(409);
    expect(wire(reply)).toEqual(never("INPUT_CONFLICT", message));
    exited(reply, "INPUT_CONFLICT");
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

function snap(f: Fixture) {
  const db = writableStore(f.storage);
  const image = recovered(db, f.seal());
  const keys = (collection: "record" | "lease") =>
    [...image.entries[collection].keys()].sort();
  return {
    records: keys("record").map((key) => [
      key,
      readV3Value(db, image, "record", key),
      image.entries.record.get(key)?.revision,
    ]),
    leases: keys("lease").map((key) => [
      key,
      readV3Value(db, image, "lease", key),
    ]),
  };
}

const cap = contextSchema.$defs.Session.properties;
const longDevice = "d".repeat(cap.device.maxLength + 1);
const fullDevice = "d".repeat(cap.device.maxLength);
const fullSession = "s".repeat(cap.id.maxLength);
const astral = (count: number) => "\u{1F600}".repeat(count);
const guard = never(
  "AUTH_FORBIDDEN",
  "This token's device label is too long to hold a lease; issue a new token",
);
const answer = (mode: Mode, e: { code: string }) =>
  mode === "owner"
    ? { ok: false, error: e }
    : failed(e as unknown as ForgeError);
const sessioned = <T extends { context: object }>(body: T, id: string): T => ({
  ...body,
  context: { ...body.context, session: { id } },
});

type Stored = { id: string; hash: string; session: string } & {
  agent: string | null;
  harness: string | null;
  expires_at: number;
  revoked_at: number | null;
};
async function enrollAs(f: Fixture, device: string, session = "fixture") {
  if (!tokens.has(f)) return;
  const fits = [...device].length <= cap.device.maxLength;
  const reply = await f.send("devices", {
    device: fits ? device : "forged",
    session,
    ttlMs: 2 * ttlMs,
  });
  expect(reply.status).toBe(200);
  const issued = (reply.body as { value: Issued }).value;
  if (!fits) {
    f.db.run("UPDATE cloud_v3_tokens SET device=? WHERE id=?", [
      device,
      issued.id,
    ]);
    const row = f.db
      .query<Stored, [string]>("SELECT * FROM cloud_v3_tokens WHERE id=?")
      .get(issued.id)!;
    const mac = signToken(f.seal(), {
      id: row.id,
      hash: row.hash,
      device,
      session: row.session,
      agent: row.agent,
      harness: row.harness,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
    });
    f.db.run("UPDATE cloud_v3_tokens SET mac=? WHERE id=?", [mac, issued.id]);
  }
  tokens.get(f)!.set(`${device}/${session}`, issued);
}
async function enrollLong(f: Fixture, mode: Mode, ...devices: string[]) {
  await enroll(f, mode);
  for (const device of devices) await enrollAs(f, device);
}

async function guarded(
  f: Fixture,
  mode: Mode,
  body: { input: object },
  owner: string,
  session?: string,
) {
  const state = snap(f);
  const rows = tokenRows(f);
  const before = frames(f).length;
  const effects = f.observeEffects();
  const reply = await send(f, body, owner, session);
  const seen = effects();
  expect(reply).toEqual({ status: 403, body: answer(mode, guard) });
  exited(reply, "AUTH_FORBIDDEN");
  expect(seen).toEqual(noWrites);
  expect(snap(f)).toEqual(state);
  expect(tokenRows(f)).toBe(rows);
  expect(frames(f)).toHaveLength(before);
  const retry = f.observeEffects();
  expect(await send(f, body, owner, session)).toEqual(reply);
  const changed = { ...body, input: { ...body.input, changed: true } };
  expect(await send(f, changed, owner, session)).toEqual(reply);
  expect(retry()).toEqual(noWrites);
}

const grant = { id: "forge-1", ttlSeconds: 60 };
const okBody = (op: string, result: unknown) => ({
  ok: true,
  op,
  status: "OK",
  result,
  warnings: [],
});
const claimed = (id: string) => ({
  id,
  generation: 1,
  expiresAt: new Date(time + 60_000).toISOString(),
});
const recorded = (f: Fixture) => (frames(f).at(-1)!.outcome as Json).result;
const storedLease = (f: Fixture) => {
  const db = writableStore(f.storage);
  return readV3Value(db, recovered(db, f.seal()), "lease", subject);
};
async function replays(
  f: Fixture,
  body: object,
  owner: string,
  sid: string,
  first: Reply,
) {
  const state = snap(f);
  const rows = tokenRows(f);
  const count = frames(f).length;
  const effects = f.observeEffects();
  const again = await send(f, body, owner, sid);
  const seen = effects();
  expect(again).toEqual(first);
  expect(seen).toEqual(noWrites);
  expect(snap(f)).toEqual(state);
  expect(tokenRows(f)).toBe(rows);
  expect(frames(f)).toHaveLength(count);
}

test.each(modes)(
  "v3 typed claim of an open issue is refused before recording for a device label over the limit (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const devices = [longDevice, "d".repeat(8192)];
    await enrollLong(f, mode, ...devices);
    await fixtureIssue(f);
    for (const device of devices)
      await guarded(f, mode, clm(`open-${device.length}`, grant), device);
  },
  timeout,
);

test.each(modes)(
  "v3 typed claim is refused before recording for a 257-character device label (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enrollLong(f, mode, longDevice);
    for (const [name, input] of [
      ["prefix", { ...grant, id: "other-1" }],
      ["missing", { ...grant, id: "forge-9" }],
      ["invalid", { ...grant, ttlSeconds: 0 }],
    ] as const)
      await guarded(f, mode, clm(`long-${name}`, input), longDevice);
    await fixtureIssue(f, { ...initial, status: "closed" });
    await guarded(f, mode, clm("long-closed", grant), longDevice);
  },
  timeout,
);

test.each(modes)(
  "v3 typed claim admits a device and a session at the schema limits (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await enrollAs(f, fullDevice, fullSession);
    await fixtureIssue(f);
    const body = sessioned(clm("full-claim", grant), fullSession);
    const reply = await oneRow(f, () => send(f, body, fullDevice, fullSession));
    expect(reply).toEqual({
      status: 200,
      body: okBody("issue.claim", claimed("forge-1")),
    });
    expect(recorded(f)).toEqual(claimed("forge-1"));
    expect(lease(f).holder).toEqual({
      actor,
      session: { id: fullSession, device: fullDevice },
    });
    await replays(f, body, fullDevice, fullSession, reply);
  },
  timeout,
);

test.each(modes)(
  "v3 typed update is refused before recording for a 257-character device label (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enrollLong(f, mode, longDevice);
    await fixtureIssue(f);
    await rawClaim(f);
    for (const [name, id] of [
      ["held", "forge-1"],
      ["prefix", "other-1"],
      ["missing", "forge-9"],
    ] as const)
      await guarded(
        f,
        mode,
        upd(`long-${name}`, { ...update.input, id }),
        longDevice,
      );
  },
  timeout,
);

test.each(modes)(
  "v3 typed update admits the holder and a device at the schema limit (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, mode);
    await fixtureIssue(f);
    await rawClaim(f);
    const held = upd("held-update", update.input);
    const first = await oneRow(f, () => send(f, held));
    expect(first).toEqual({
      status: 200,
      body: okBody("issue.update", recorded(f)),
    });
    expect(recorded(f)).toMatchObject({
      id: "forge-1",
      title: "After",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: initial.createdAt,
      updatedAt: new Date(time).toISOString(),
      revision: 2,
      lease: { generation: 1 },
    });
    await replays(f, held, "laptop", "fixture", first);
    await fixtureIssue(f, { ...initial, id: "work-2" });
    await enrollAs(f, fullDevice, fullSession);
    const claim = sessioned(
      clm("full-claim", { ...grant, id: "forge-2" }),
      fullSession,
    );
    const granted = await oneRow(f, () =>
      send(f, claim, fullDevice, fullSession),
    );
    expect(granted).toEqual({
      status: 200,
      body: okBody("issue.claim", claimed("forge-2")),
    });
    expect(recorded(f)).toEqual(claimed("forge-2"));
    await replays(f, claim, fullDevice, fullSession, granted);
    const body = sessioned(
      upd("full-update", { id: "forge-2", expectRevision: 1, title: "After" }),
      fullSession,
    );
    const reply = await oneRow(f, () => send(f, body, fullDevice, fullSession));
    expect(reply).toEqual({
      status: 200,
      body: okBody("issue.update", recorded(f)),
    });
    expect(recorded(f)).toMatchObject({
      id: "forge-2",
      revision: 2,
      title: "After",
    });
    await replays(f, body, fullDevice, fullSession, reply);
  },
  timeout,
);

test(
  "v3 typed claim counts device characters, not bytes, at the guard",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enroll(f, "token");
    await fixtureIssue(f);
    await fixtureIssue(f, { ...initial, id: "work-2" });
    const [full, over] = [astral(cap.device.maxLength), astral(257)];
    await enrollAs(f, full);
    await enrollAs(f, over);
    const body = clm("astral-full", grant);
    const first = await oneRow(f, () => send(f, body, full));
    expect(first).toEqual({
      status: 200,
      body: okBody("issue.claim", claimed("forge-1")),
    });
    expect(lease(f).holder).toEqual({
      actor,
      session: { ...session, device: full },
    });
    await replays(f, body, full, "fixture", first);
    await guarded(
      f,
      "token",
      clm("astral-over", { ...grant, id: "forge-2" }),
      over,
    );
  },
  timeout,
);

test(
  "v3 raw owner probe refuses a bound device over the limit and admits one at the limit",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const steps = [
      ["claim", { ttlMs }],
      ["renew", { generation: 1, ttlMs }],
      ["release", { generation: 1 }],
    ] as const;
    const call = (route: string, extra: object, owner: string) =>
      f.send(
        `${probe}/${route}`,
        { requestId: `${owner.length}-${route}`, subject, holder, ...extra },
        headers(owner),
      );
    const state = snap(f);
    for (const [route, extra] of steps) {
      const effects = f.observeEffects();
      const reply = await call(route, extra, longDevice);
      expect(reply).toEqual({
        status: 400,
        body: {
          ok: false,
          error: never("INPUT_INVALID", "Lease holder has an invalid device"),
        },
      });
      exited(reply, "INPUT_INVALID");
      expect(effects()).toEqual(noWrites);
      expect(snap(f)).toEqual(state);
    }
    for (const [route, extra] of steps) {
      const reply = await call(route, extra, fullDevice);
      expect(reply).toEqual({
        status: 200,
        body: { ok: true, value: storedLease(f) },
      });
      expect(exitCode(reply.body as Parameters<typeof exitCode>[0])).toBe(0);
      expect(storedLease(f)).toMatchObject({
        subject,
        holder: { actor, session: { ...session, device: fullDevice } },
        generation: 1,
      });
    }
  },
  timeout,
);

const otherOps = [
  create,
  {
    op: "issue.show",
    requestId: "show",
    input: { id: "forge-1" },
    context: { actor },
  },
  {
    ...update,
    op: "issue.close",
    requestId: "close",
    input: { id: "forge-1" },
  },
];
async function runOtherOps(mode: Mode, device: string) {
  const f = guardFixture(env);
  using _db = f.db;
  await provision(f);
  await enrollLong(f, mode, device);
  const seen = [];
  for (const body of otherOps) {
    const before = frames(f).length;
    const effects = f.observeEffects();
    const reply = await send(f, body, device);
    seen.push({ reply, ...effects(), added: frames(f).length - before });
  }
  return seen;
}

test.each(modes)(
  "v3 leased close is refused for an over-long device label and other operations are unchanged (%s)",
  async (mode) => {
    const [long, short] = [
      await runOtherOps(mode, longDevice),
      await runOtherOps(mode, "laptop"),
    ];
    expect(long[0]).toEqual(short[0]);
    expect(long[0]).toMatchObject({ reply: { status: 200 }, added: 1 });
    const unknown = {
      reply: {
        status: 404,
        body: answer(mode, never("UNKNOWN_COMMAND", "No such v3 command")),
      },
      ...noWrites,
      added: 0,
    };
    exited(unknown.reply, "UNKNOWN_COMMAND");
    expect(long[1]).toEqual(unknown);
    expect(short[1]).toEqual(unknown);
    expect(short[2]).toEqual(unknown);
    expect(long[2]).toEqual({
      reply: { status: 403, body: answer(mode, guard) },
      ...noWrites,
      added: 0,
    });
  },
  timeout,
);

test.each(modes)(
  "v3 typed claim naming its own device is refused by the context check, or admitted at the limit (%s)",
  async (mode) => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await enrollLong(f, mode, longDevice);
    await enrollAs(f, fullDevice, fullSession);
    await fixtureIssue(f);
    const naming = (
      id: string,
      issue: string,
      device: string,
      sid: string,
    ) => ({
      ...clm(id, { ...grant, id: issue }),
      context: { actor, session: { id: sid, device } },
    });
    const full = naming("full-named", "forge-1", fullDevice, fullSession);
    const named = await oneRow(f, () => send(f, full, fullDevice, fullSession));
    expect(named).toEqual({
      status: 200,
      body: okBody("issue.claim", claimed("forge-1")),
    });
    const state = snap(f);
    const effects = f.observeEffects();
    const long = naming("long-named", "forge-2", longDevice, "fixture");
    const reply = await send(f, long, longDevice);
    const message =
      "body must be { requestId, op, input, context, dryRun? } with a valid context";
    expect(reply).toEqual({
      status: 400,
      body: answer(mode, never("INPUT_INVALID", message)),
    });
    exited(reply, "INPUT_INVALID");
    expect(effects()).toEqual(noWrites);
    expect(snap(f)).toEqual(state);
  },
  timeout,
);

test(
  "v3 typed claim is refused before recording for an empty owner label",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await fixtureIssue(f);
    await guarded(f, "owner", clm("empty-owner", grant), "");
    await oneRow(f, () => send(f, clm("named-owner", grant)));
  },
  timeout,
);
