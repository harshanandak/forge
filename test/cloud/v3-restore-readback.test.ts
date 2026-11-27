import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { scopeRequestId } from "../../cloud/src/issue-request-id.ts";
import { Project } from "../../cloud/src/project.ts";
import { authorityFault } from "../../cloud/src/v3-authority.ts";
import { verifyRecordFrame } from "../../cloud/src/v3-record-transitions.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { digestProjection, inventory } from "../../cloud/src/v3-checkpoint.ts";
import { verifyRow } from "../../cloud/src/v3-seal.ts";
import {
  type Frame,
  entryDigest,
  readV3Value,
  recoverV3,
  viewV3,
} from "../../cloud/src/v3-store.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
} from "../../src/core/config/pointer.ts";
import {
  guardFixture,
  noWrites,
  observeRestoreReset,
  probe,
  recovered as recoverOrdinary,
  trustedManifest,
  verifiedPortable,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.now();
const activatedAt = new Date(time + 1).toISOString();
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const open = () => guardFixture(env);
type Fixture = ReturnType<typeof open>;
type Pages = ReturnType<typeof pages>;

beforeEach(() => setSystemTime(time));
afterEach(() => setSystemTime());

const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const owner = "laptop";
const headers = {
  "X-Forge-Owner": owner,
  "X-Forge-Owner-Expires": String(time + 7_200_000),
};
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before", expectedFiles: ["./src//planned-*.ts"] },
  context: { actor: holder.actor },
};
const refusedCreate = {
  ...create,
  requestId: "refused-create",
  input: { ...create.input, dependsOn: ["forge-1"] },
};
const claim = {
  op: "issue.claim",
  requestId: "claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: holder,
};
const update = {
  op: "issue.update",
  requestId: "update",
  input: {
    id: "forge-1",
    expectRevision: 1,
    title: "After",
    expectedFiles: ["src/./planned-*.ts"],
    actualFiles: ["src//delivered.ts"],
    filesAt: "0123456789abcdef0123456789abcdef01234567",
  },
  context: { ...holder, leaseGeneration: 1 },
};
const error = (status: number, code: string) => ({
  status,
  body: { ok: false, error: { code } },
});
const typed = (f: Fixture, call: object) =>
  f.send(`${probe}/command`, call, headers);
const commits = (f: Fixture) =>
  f.db
    .query<{ sequence: number; body: string; mac: string }, []>(
      "SELECT sequence, body, mac FROM cloud_v3_commits ORDER BY sequence",
    )
    .all();
function pages(f: Fixture) {
  return f.db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all();
}

async function provision(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
}

function recovered(f: Fixture) {
  const db = writableStore(f.storage);
  return { db, image: recoverOrdinary(db, f.seal()) };
}

async function checkpoint(f: Fixture, head: number) {
  expect(commits(f)).toHaveLength(head);
  let response = await f.send(`${probe}/checkpoint`, {});
  while ((response.body as { value?: { more?: boolean } }).value?.more)
    response = await f.send(`${probe}/checkpoint`, {});
  expect(response).toMatchObject({
    status: 200,
    body: { value: { coveredHead: head, more: false } },
  });
  expect(commits(f)).toEqual([]);
  f.restart();
  const { image } = recovered(f);
  const exported = pages(f);
  expect(exported.map(({ id }) => id)).toEqual([
    "directory:0",
    "snapshot:0",
    "transcript:0",
  ]);
  const publicDigest = digestProjection(
    inventory(
      image,
      new Map(exported.map(({ id, body }) => [id, Buffer.from(body)])),
    ),
  );
  expect(response.body).toMatchObject({
    value: { projectionDigest: publicDigest },
  });
  expect(image.root.publicDigest).toBe(publicDigest);
  return {
    pages: exported,
    head: image.head,
    eventWatermark: image.eventWatermark,
    recordFloor: image.recordFloor,
    publicDigest,
    source: String(f.context.id),
  };
}

type Backup = Awaited<ReturnType<typeof checkpoint>>;
const restoreResult = (page: number, verified = false) => ({
  status: 200,
  body: { ok: true, value: { page, verified } },
});

async function stage(target: Fixture, { pages, ...projection }: Backup) {
  const manifest = trustedManifest(target.seal(), {
    ...projection,
    format: "forge-cloud-portable/4",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  });
  const upload = (page: number) =>
    target.send(
      "restore",
      {
        page,
        ...pages[page],
        ...(page === 0 && { manifest }),
      },
      page === 0 ? { "X-Forge-Manifest-Digest": digestValue(manifest) } : {},
    );
  expect(await upload(0)).toEqual(restoreResult(0));
  expect(await upload(1)).toEqual(restoreResult(1));
  return () => upload(2);
}

function transcript(pages: Pages) {
  return pages.find(({ id }) => id === "transcript:0")!.body;
}

const portable = (f: Fixture, portableTranscript: string) =>
  recoverV3(writableStore(f.storage), f.seal(), {
    admit: Project.admitLeaseRequest,
    manifest: verifiedPortable(f.seal(), portableTranscript),
    portableTranscript,
  });
const receipt = (requestId: string) =>
  scopeRequestId("command", ["owner", owner, owner], requestId);

type Json = Record<string, unknown>;
type Prior = { revision: number; deleted?: true; value?: object };
const secondCreate = {
  ...create,
  requestId: "second-create",
  input: { title: "Second" },
};
const refusedClaim = {
  ...claim,
  requestId: "refused-claim",
  input: { ...claim.input, id: "forge-9" },
};
const refusedUpdate = {
  ...update,
  requestId: "refused-update",
  input: { ...update.input, id: "forge-9" },
};
const history = [
  create,
  secondCreate,
  claim,
  update,
  refusedClaim,
  refusedUpdate,
  refusedCreate,
];
const refusal = {
  status: 400,
  body: { ok: false, error: { code: "RESTORE_INVALID_ROW" } },
};
const stopped = {
  status: 200,
  body: { ok: true, value: { initialized: true, stopped: true } },
};
const stoppedRefusal = {
  status: 409,
  body: {
    ok: false,
    error: {
      code: "INPUT_CONFLICT",
      message: "The restored project is stopped",
    },
  },
};
const statusOf = ({ requestId }: { requestId: string }) =>
  requestId === refusedCreate.requestId
    ? 400
    : requestId.startsWith("refused-")
      ? 404
      : 200;

async function backupOf(calls: { requestId: string }[]) {
  const source = open();
  await provision(source);
  const replies = new Map<string, Awaited<ReturnType<typeof typed>>>();
  for (const call of calls) {
    const reply = await typed(source, call);
    expect(reply.status).toBe(statusOf(call));
    replies.set(call.requestId, reply);
  }
  return { source, replies, data: await checkpoint(source, calls.length) };
}

async function restoreInto(target: Fixture, data: Backup) {
  const finish = await stage(target, data);
  setSystemTime(time + 1);
  expect(await finish()).toEqual(restoreResult(2, true));
  target.restart();
  expect(await target.send("status")).toEqual(stopped);
  return finish;
}

const controlSlot = (
  db: Parameters<typeof readV3Value>[0],
  image: ReturnType<typeof recoverV3>,
): unknown => readV3Value(db, image, "control", "global");

function readback(source: Fixture, target: Fixture, data: Backup) {
  expect(pages(target)).toEqual(data.pages);
  const from = recovered(source);
  const to = recovered(target);
  const { image: expected } = from;
  const { image: actual } = to;
  expect(actual.root).toMatchObject({
    coveredHead: expected.head,
    eventWatermark: expected.eventWatermark,
    publicDigest: data.publicDigest,
  });
  expect(actual.root.incarnation).not.toBe(expected.root.incarnation);
  expect(actual.root.restoreEpoch).not.toBe(expected.root.restoreEpoch);
  expect(actual.recordFloor).toBe(expected.recordFloor);
  const { lease: _lease, ...expectedView } = viewV3(expected).image as Json;
  const { lease: _restoredLease, ...actualView } = viewV3(actual).image as Json;
  const global = {
    version: 1,
    incarnation: actual.root.incarnation,
    epoch: 1,
    resumeAllEpoch: 0,
    stopAll: activatedAt,
  };
  expect(actualView).toEqual({
    ...expectedView,
    control: { global: entryDigest(digestValue(global)) },
    head: expected.head + 1,
    eventWatermark: expected.eventWatermark + 1,
  });
  expect(controlSlot(to.db, actual)).toEqual(global);
  for (const collection of ["lease", "outcome", "record", "witness"] as const) {
    expect([...actual.entries[collection].keys()].sort()).toEqual(
      [...expected.entries[collection].keys()].sort(),
    );
    for (const [key, slot] of expected.entries[collection]) {
      const value = readV3Value(from.db, expected, collection, key);
      expect(actual.entries[collection].get(key)?.revision).toBe(slot.revision);
      expect(readV3Value(to.db, actual, collection, key)).toEqual(
        collection === "lease"
          ? {
              ...(value as Json),
              releasedAt: (value as Json).releasedAt ?? activatedAt,
            }
          : value,
      );
    }
  }
  const rows = commits(target);
  expect(rows.map(({ sequence }) => sequence)).toEqual([expected.head + 1]);
  const { sequence, body, mac } = rows[0]!;
  expect(
    verifyRow(target.seal(), actual.root.incarnation, sequence, body, mac),
  ).toBe(true);
  return to;
}

test(
  "v3 restores mixed typed history and reads it back with activation normalization",
  async () => {
    const { source, replies, data } = await backupOf(history);
    const target = open();
    using _source = source.db;
    using _target = target.db;
    const before = source.observeEffects();
    const finish = await restoreInto(target, data);
    const { db, image } = readback(source, target, data);
    expect(image.recordFloor).toBe(2);
    expect(readV3Value(db, image, "lease", "issue:work-1")).toMatchObject({
      generation: 1,
      releasedAt: activatedAt,
      holder: { actor: holder.actor },
    });
    const rows = commits(target).length;
    const effects = target.observeEffects();
    for (const call of [create, refusedClaim, refusedUpdate, refusedCreate])
      expect(await typed(target, call)).toEqual(replies.get(call.requestId)!);
    for (const call of [claim, update])
      expect(await typed(target, call)).toMatchObject(
        error(409, "LEASE_STALE"),
      );
    for (const call of [create, refusedCreate])
      expect(
        await typed(target, { ...call, input: { title: "Changed" } }),
      ).toMatchObject(error(409, "INPUT_CONFLICT"));
    expect(effects()).toEqual(noWrites);
    for (const call of [
      { ...create, requestId: "fresh-create" },
      {
        ...claim,
        requestId: "fresh-claim",
        input: { id: "forge-2", ttlSeconds: 60 },
      },
      {
        ...update,
        requestId: "fresh-update",
        input: { ...update.input, expectRevision: 2 },
      },
    ])
      expect(await typed(target, call)).toMatchObject(stoppedRefusal);
    expect(effects()).toEqual(noWrites);
    expect(commits(target)).toHaveLength(rows);
    const replay = target.observeEffects();
    expect(await finish()).toEqual(restoreResult(2, true));
    expect(replay()).toEqual(noWrites);
    expect(before()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 restores a refusal-only create backup and replays the exact refusal",
  async () => {
    const { source, replies, data } = await backupOf([refusedCreate]);
    const target = open();
    using _source = source.db;
    using _target = target.db;
    expect(data.recordFloor).toBe(0);
    await restoreInto(target, data);
    expect(recovered(target).image.recordFloor).toBe(0);
    const before = target.observeEffects();
    expect(await typed(target, refusedCreate)).toEqual(
      replies.get(refusedCreate.requestId)!,
    );
    expect(before()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 portable recovery rebuilds one successful archived create",
  async () => {
    const { source, replies, data } = await backupOf([create]);
    using _source = source.db;
    const { db, image: stored } = recovered(source);
    const before = source.observeEffects();
    const image = portable(source, transcript(data.pages));
    const id = receipt(create.requestId);
    const saved = readV3Value(db, image, "outcome", id)!;
    expect(saved).toEqual(readV3Value(db, stored, "outcome", id)!);
    expect(saved.outcome).not.toHaveProperty("resultDigest");
    expect(saved.outcome.result).toEqual(
      (replies.get(create.requestId)!.body as Json).result,
    );
    expect(readV3Value(db, image, "record", "r1")).toEqual(
      readV3Value(db, stored, "record", "r1"),
    );
    expect(image.entries.record.get("r1")?.revision).toBe(1);
    expect(image.recordFloor).toBe(1);
    expect(before()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 restores a successful typed update with no create and keeps its full result",
  async () => {
    const source = open();
    const target = open();
    using _source = source.db;
    using _target = target.db;
    await provision(source);
    const value = {
      id: "work-1",
      prefix: "forge",
      title: "Before",
      status: "open",
      labels: [],
      dependsOn: [],
      createdAt: new Date(time).toISOString(),
    };
    expect(
      await source.send(`${probe}/commits`, {
        frames: [
          {
            operation: "fixture.put",
            time,
            events: [{ key: "r1", revision: 1, value }],
            changes: [{ key: "r1", value: { revision: 1, value } }],
          },
        ],
      }),
    ).toMatchObject({ status: 200 });
    for (const call of [claim, update])
      expect((await typed(source, call)).status).toBe(200);
    const data = await checkpoint(source, 3);
    await restoreInto(target, data);
    const { db, image } = readback(source, target, data);
    const saved = readV3Value(db, image, "outcome", receipt("update"))!;
    expect(saved.outcome).toMatchObject({
      status: "ok",
      result: { id: "forge-1", title: "After", revision: 2 },
    });
    expect(saved.outcome).not.toHaveProperty("resultDigest");
    const effects = target.observeEffects();
    for (const call of [claim, update])
      expect(await typed(target, call)).toMatchObject(
        error(409, "LEASE_STALE"),
      );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

const frames = (data: Backup) => JSON.parse(transcript(data.pages)) as Json[];
const entry = (f: Json) => (f.events as Json[])[0]!;
const change = (f: Json) => (f.changes as Json[])[0]!;
const outcomeOf = (f: Json) => f.outcome as Json;
const shown = (f: Json) => {
  const { id: _id, prefix, ...item } = entry(f).value as Json;
  return {
    ...item,
    id: `${String(prefix)}-${String(entry(f).key).slice(1)}`,
    revision: 1,
    updatedAt: new Date(f.time as number).toJSON(),
  };
};
const settle = (f: Json) => {
  outcomeOf(f).resultDigest = digestValue(shown(f));
};
const rewrite = (f: Json, key: string, edit: (value: Json) => void) => {
  const event = entry(f);
  event.key = key;
  edit(event.value as Json);
  Object.assign(change(f), { key, value: { revision: 1, value: event.value } });
  settle(f);
};
const verifyAt = (frame: Json, floor = 0, prior?: Prior) =>
  verifyRecordFrame(
    frame as unknown as Frame,
    floor,
    () => prior,
    () => new Error("refused"),
    () => undefined,
  );
const broken: [string, (f: Json) => void][] = [
  [
    "a number above the floor plus one",
    (f) =>
      rewrite(f, "r2", (value) => {
        value.id = "work-2";
      }),
  ],
  [
    "revision 2",
    (f) => {
      entry(f).revision = 2;
      change(f).value = { revision: 2, value: entry(f).value };
    },
  ],
  [
    "a change that differs from the event value",
    (f) => {
      (change(f).value as Json).value = {
        ...(entry(f).value as Json),
        title: "Other",
      };
    },
  ],
  [
    "a result digest that does not match",
    (f) => {
      outcomeOf(f).resultDigest = digestBytes("other");
    },
  ],
  [
    "a result naming a different issue",
    (f) => {
      outcomeOf(f).resultDigest = digestValue({ ...shown(f), id: "forge-9" });
    },
  ],
  [
    "an item that fails the tracker schema",
    (f) =>
      rewrite(f, "r1", (value) => {
        value.title = 7;
      }),
  ],
];

test(
  "v3 portable create admits its control and refuses each broken record rule",
  async () => {
    const { source, data } = await backupOf([create]);
    using _source = source.db;
    const [control] = frames(data) as [Json];
    expect(verifyAt(control)).toMatchObject({
      floor: 1,
      result: shown(control),
    });
    const wrongNumber = structuredClone(control);
    broken[0]![1](wrongNumber);
    expect(() => verifyAt(wrongNumber)).toThrow("refused");
    expect(verifyAt(wrongNumber, 1)).toMatchObject({ floor: 2 });
    for (const [, edit] of broken.slice(1)) {
      const edited = structuredClone(control);
      edit(edited);
      expect(() => verifyAt(edited)).toThrow("refused");
    }
    for (const prior of [
      { revision: 1, value: {} },
      { revision: 2, deleted: true as const },
    ])
      expect(() => verifyAt(control, 0, prior)).toThrow("refused");
    const valid = structuredClone(control);
    rewrite(valid, "r1", (value) => {
      value.title = "Changed";
    });
    expect(verifyAt(valid)).toMatchObject({ floor: 1 });
    const live = (f: Json) => {
      const { resultDigest: _digest, ...receipt } = outcomeOf(f);
      return { ...f, outcome: { ...receipt, result: shown(f) } };
    };
    const invalid = structuredClone(control);
    broken.at(-1)![1](invalid);
    expect(authorityFault(live(valid))).toBeUndefined();
    expect(authorityFault(live(invalid))).toBe("command result");
  },
  timeout,
);

test(
  "v3 portable create refuses each malformed receipt and each effect on a refused create",
  async () => {
    const { source, data } = await backupOf([create, claim, refusedCreate]);
    using _source = source.db;
    const [made, granted, refused] = frames(data) as [Json, Json, Json];
    expect(authorityFault(made, true)).toBeUndefined();
    expect(authorityFault(refused, true)).toBeUndefined();
    const receipts: ((o: Json) => void)[] = [
      (o) => void (o.id = "c2:abc"),
      (o) => void ((o.scope as Json).family = "lease"),
      (o) => void ((o.scope as Json).version = 1),
      (o) =>
        void (o.fingerprint = JSON.stringify(
          JSON.parse(String(o.fingerprint)),
          null,
          1,
        )),
      (o) =>
        void (o.fingerprint = canonicalJson({
          ...(JSON.parse(String(o.fingerprint)) as Json),
          input: "not a digest",
        })),
      (o) => void (o.status = "NOT_FOUND"),
    ];
    for (const edit of receipts) {
      const edited = structuredClone(made);
      edit(outcomeOf(edited));
      expect(authorityFault(edited, true)).toBeDefined();
    }
    expect(verifyAt(refused)).toMatchObject({ floor: 0 });
    for (const edit of [
      (f: Json) => void (f.events = made.events),
      (f: Json) => void (f.changes = []),
    ]) {
      const edited = structuredClone(refused);
      edit(edited);
      expect(() => verifyAt(edited)).toThrow("refused");
    }
    for (const key of ["lease", "witness"]) {
      const edited = { ...structuredClone(refused), [key]: granted[key] };
      expect(authorityFault(edited, true)).toBeDefined();
    }
  },
  timeout,
);

test(
  "v3 portable recovery refuses a still-live receipt id reused by a second create",
  async () => {
    const { source, data } = await backupOf([create, secondCreate]);
    using _source = source.db;
    const list = frames(data);
    expect(portable(source, canonicalJson(list)).recordFloor).toBe(2);
    outcomeOf(list[1]!).id = String(outcomeOf(list[0]!).id);
    expect(() => portable(source, canonicalJson(list))).toThrow();
  },
  timeout,
);

async function refused(data: Backup) {
  const target = open();
  using _target = target.db;
  const finish = await stage(target, data);
  const reset = observeRestoreReset(target);
  expect(await finish()).toMatchObject(refusal);
  reset();
  expect(await target.send("status")).toMatchObject({
    body: { value: { initialized: false } },
  });
}

const withTranscript = (data: Backup, edit: (list: Json[]) => void): Backup => {
  const list = frames(data);
  edit(list);
  return {
    ...data,
    pages: data.pages.map((page) =>
      page.id === "transcript:0"
        ? { ...page, body: canonicalJson(list) }
        : page,
    ),
  };
};

function altered(data: Backup, title: string): Backup {
  const [directory, snapshot] = data.pages as [Pages[0], Pages[0]];
  const entries = JSON.parse(directory.body) as Json[];
  const original = Buffer.from(snapshot.body);
  const bytes = Buffer.from(original);
  const span = ({ offset, length }: Json) =>
    [offset as number, (offset as number) + (length as number)] as const;
  const [start, end] = span(
    entries.find((e) => e.collection === "record" && e.key === "r1")!,
  );
  const record = bytes
    .subarray(start, end)
    .toString()
    .replace('"Before"', title);
  expect(Buffer.byteLength(record)).toBe(end - start);
  Buffer.from(record).copy(bytes, start);
  expect(bytes.equals(original)).toBe(title === '"Before"');
  const items = entries.map((entry) => {
    const [from, to] = span(entry);
    const text = bytes.subarray(from, to).toString();
    if (entry.collection === "outcome")
      expect(text).toBe(original.subarray(from, to).toString());
    return [
      entry.collection as string,
      entry.key as string,
      text,
      entry.revision as number,
    ] as const;
  });
  const fixed = entries.map((entry, i) => ({
    ...entry,
    digest: digestBytes(items[i]![2]),
  }));
  return {
    ...data,
    publicDigest: digestProjection(items),
    pages: [
      { ...directory, body: canonicalJson(fixed) },
      { ...snapshot, body: bytes.toString() },
      data.pages[2]!,
    ],
  };
}

function repack(
  data: Backup,
  collection: string,
  key: string,
  edit: (body: string) => string,
): Backup {
  const [directory, snapshot] = data.pages as [Pages[0], Pages[0]];
  const bytes = Buffer.from(snapshot.body);
  const items: (readonly [string, string, string, number])[] = [];
  let offset = 0;
  const entries = (JSON.parse(directory.body) as Json[]).map((entry) => {
    const start = entry.offset as number;
    const old = bytes.subarray(start, start + (entry.length as number));
    const [c, k, revision] = [entry.collection, entry.key, entry.revision];
    const hit = c === collection && k === key;
    const text = hit ? edit(old.toString()) : old.toString();
    items.push([c as string, k as string, text, revision as number]);
    const length = Buffer.byteLength(text);
    offset += length;
    return {
      ...entry,
      offset: offset - length,
      length,
      digest: digestBytes(text),
    };
  });
  return {
    ...data,
    publicDigest: digestProjection(items),
    pages: [
      { ...directory, body: canonicalJson(entries) },
      { ...snapshot, body: items.map(([, , text]) => text).join("") },
      data.pages[2]!,
    ],
  };
}

test(
  "v3 restore refuses create backups whose pages disagree with themselves (end to end)",
  async () => {
    const { source, data } = await backupOf([create, secondCreate]);
    using _source = source.db;
    expect(altered(data, '"Before"')).toEqual(data);
    await refused(altered(data, '"Bofore"'));
    for (const floor of [data.recordFloor + 1, data.recordFloor - 1])
      await refused({ ...data, recordFloor: floor });
    const { source: single, data: one } = await backupOf([create]);
    using _single = single.db;
    for (const [, edit] of broken)
      await refused(withTranscript(one, ([first]) => edit(first!)));
  },
  timeout,
);

test(
  "v3 restore answers 400 when a portable create event carries a prefix that cannot become text",
  async () => {
    const { source, data } = await backupOf([create]);
    using _source = source.db;
    for (const prefix of [{ toString: null }, { toString: 1 }]) {
      const hostile = withTranscript(data, ([first]) => {
        entry(first!).value = { ...(entry(first!).value as Json), prefix };
        (change(first!).value as Json).value = entry(first!).value;
      });
      expect(() => verifyAt(frames(hostile)[0]!)).toThrow("refused");
      await refused(hostile);
    }
  },
  timeout,
);

test(
  "v3 restore answers 400 when a saved refusal status cannot become text",
  async () => {
    const { source, data } = await backupOf([refusedCreate]);
    using _source = source.db;
    const id = receipt(refusedCreate.requestId);
    expect(repack(data, "outcome", id, (body) => body)).toEqual(data);
    for (const text of ["null", "1"]) {
      const hostile = repack(data, "outcome", id, (body) => {
        const next = body.replace(
          '"status":"INPUT_INVALID"',
          `"status":{"toString":${text}}`,
        );
        expect(next).not.toBe(body);
        return next;
      });
      await refused(hostile);
    }
  },
  timeout,
);

test(
  "v3 restore keeps a recognized storage failure raised as a TypeError or RangeError at 503",
  async () => {
    const { source, data } = await backupOf([create]);
    using _source = source.db;
    for (const Native of [TypeError, RangeError]) {
      for (const [failure, code] of [
        [
          Object.assign(new Native("storage"), { retryable: true }),
          "UNAVAILABLE",
        ],
        [
          new Native(
            "Exceeded allowed rows read in Durable Objects free tier.",
          ),
          "QUOTA_EXHAUSTED",
        ],
      ] as const) {
        const target = open();
        using _target = target.db;
        const finish = await stage(target, data);
        const staged = target.snapshot();
        const executeSql = target.storage.sql.exec.bind(target.storage.sql);
        let armed = true;
        target.storage.sql.exec = (statement, ...bindings) => {
          if (armed && /^SELECT id, CASE WHEN length/.test(statement)) {
            armed = false;
            throw failure;
          }
          return executeSql(statement, ...bindings);
        };
        expect(await finish()).toMatchObject(error(503, code));
        expect(armed).toBe(false);
        expect(target.snapshot()).toEqual(staged);
        expect(await target.send("status")).toMatchObject({
          body: { value: { initialized: false } },
        });
      }
    }
  },
  timeout,
);
