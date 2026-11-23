import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { CREATE_SCHEMA } from "../../cloud/src/issue-create.ts";
import { scopeRequestId } from "../../cloud/src/issue-request-id.ts";
import { Project, STATUS } from "../../cloud/src/project.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  archivedCheck,
  checkpointV3,
  digestProjection,
  inventory,
  roster,
} from "../../cloud/src/v3-checkpoint.ts";
import { commandV3 } from "../../cloud/src/v3-commands.ts";
import {
  activateV3,
  appendV3Frames,
  foldTranscript,
  leaseV3,
  PAGE_BYTES,
  publishV3,
  readV3Value,
  recoverV3,
  TAIL_ROWS,
  unavailable,
  viewV3,
  type V3Image,
} from "../../cloud/src/v3-store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import type { LeaseHolder } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  expectTypedReply,
  guardFixture,
  noWrites,
  portableOf,
  portableUpload,
  probe,
  recovered,
  typedReplyCases,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const now = Date.parse("2026-11-20T12:00:00.000Z");
const hour = 3_600_000;
const expiry = now + 2 * hour;
const owner = "owner-a";
const principal = ["owner", owner, owner] as const;
const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture", device: owner },
} as const;
const calls = typedReplyCases(now, owner);
const invalidCreate = { ...calls.create.call, requestId: "invalid", input: {} };
const invalidReply = {
  status: 400,
  exit: 6,
  error: { code: "INPUT_INVALID", message: CREATE_SCHEMA, retry: "never" },
} as const;

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Usage = { transcript: number; snapshot: number; directory: number };
type Observation = { label: string; actual: unknown; expected: Usage };

const usageOf = (image: V3Image): unknown => {
  const usage: unknown = Reflect.get(image, "usage");
  return isObject(usage) ? { ...usage } : usage;
};
const jsonBytes = (value: unknown) => Buffer.byteLength(canonicalJson(value));
const dbOf = (f: Fixture) => writableStore(f.storage);
const coldImage = (f: Fixture) => recovered(dbOf(f), f.seal());
const tail = (f: Fixture, covered = 0, head = Number.MAX_SAFE_INTEGER) =>
  f.db
    .query<{ sequence: number; body: string }, [number, number]>(
      "SELECT sequence, body FROM cloud_v3_commits WHERE sequence>? AND sequence<=? ORDER BY sequence",
    )
    .all(covered, head);
const pages = (f: Fixture) =>
  new Map(
    f.db
      .query<{ id: string; body: string }, []>(
        "SELECT id, body FROM cloud_v3_pages ORDER BY id",
      )
      .all()
      .map(({ id, body }) => [id, body]),
  );
const buffers = (stored: ReadonlyMap<string, string>) =>
  new Map([...stored].map(([id, body]) => [id, Buffer.from(body)]));

function archived(body: string): Record<string, unknown> {
  const frame = JSON.parse(body) as Record<string, unknown>;
  if (isObject(frame.outcome) && "result" in frame.outcome) {
    const { result, ...receipt } = frame.outcome;
    return {
      ...frame,
      outcome: { ...receipt, resultDigest: digestValue(result) },
    };
  }
  return frame;
}

function recount(
  image: V3Image,
  members: readonly unknown[],
  stored = new Map<string, string>(),
): Usage {
  let snapshot = 0;
  let directory = 2;
  for (const [collection, key, body, revision] of inventory(
    image,
    buffers(stored),
  )) {
    const identity = {
      collection,
      key,
      ...(revision === undefined ? {} : { revision }),
    };
    if (body !== null) snapshot += Buffer.byteLength(body);
    const entry =
      body === null
        ? { ...identity, deleted: true }
        : {
            ...identity,
            page: "snapshot:0",
            offset: 999999,
            length: 999999,
            digest: "sha256:" + "0".repeat(64),
          };
    directory += jsonBytes(entry) + 1;
  }
  return { transcript: jsonBytes(members), snapshot, directory };
}

function rootedRecount(f: Fixture, image: V3Image) {
  const stored = pages(f);
  const covered = JSON.parse(stored.get("transcript:0")!) as unknown[];
  const rows = tail(f, image.root.coveredHead, image.head);
  expect(rows.map(({ sequence }) => sequence)).toEqual(
    Array.from(
      { length: image.head - image.root.coveredHead },
      (_, i) => image.root.coveredHead + i + 1,
    ),
  );
  expect(image.tailBytes).toBe(
    rows.reduce((bytes, { body }) => bytes + Buffer.byteLength(body), 0),
  );
  return recount(
    image,
    [...covered, ...rows.map(({ body }) => archived(body))],
    stored,
  );
}

const remember = (
  seen: Observation[],
  label: string,
  image: V3Image,
  expected: Usage,
) => seen.push({ label, actual: usageOf(image), expected });

function assertUsage(seen: readonly Observation[]) {
  for (const { label, actual, expected } of seen)
    expect(actual, label).toEqual(expected);
}

async function provision(f: Fixture) {
  const reply = await f.send(probe, {});
  expect(reply).toEqual({
    status: 200,
    body: { ok: true, value: viewV3(coldImage(f)) },
  });
  return coldImage(f);
}

const note = () => ({ operation: "fixture.note", time: now, events: [] });
const put = (
  ...events: { key: string; revision: number; value: unknown }[]
) => ({
  ...note(),
  operation: "fixture.put",
  events,
  changes: events.map(({ key, revision, value }) => ({
    key,
    value: { revision, value },
  })),
});
const remove = (key: string, revision: number) => ({
  ...note(),
  operation: "fixture.delete",
  events: [{ key, revision }],
  changes: [{ key, value: { revision, deleted: true } }],
});

function write(f: Fixture, image: V3Image, ...frames: object[]) {
  const head = image.head + frames.length;
  expect(appendV3Frames(dbOf(f), f.seal(), frames, () => image)).toEqual({
    head,
  });
  publishV3(image);
  expect(image.head).toBe(head);
}

function refusal(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error;
    throw error;
  }
  throw new Error("Expected a recorded refusal");
}

type LeaseRoute = "claim" | "renew" | "release";
const leaseInput = (
  route: LeaseRoute,
  subject: string,
  requestId: string,
  leaseHolder: LeaseHolder = holder,
) => ({
  subject,
  requestId,
  holder: leaseHolder,
  ...(route !== "claim" && { generation: 1 }),
  ...(route !== "release" && { ttlMs: hour }),
});

function lease(
  f: Fixture,
  image: V3Image,
  route: LeaseRoute,
  input: ReturnType<typeof leaseInput>,
) {
  const time = Date.now();
  const command = Project.admitLeaseRequest(
    route,
    JSON.stringify(input),
    owner,
    null,
    undefined,
    expiry,
    time,
  );
  return leaseV3(dbOf(f), f.seal(), image, command, expiry, time);
}

function typed(f: Fixture, image: V3Image, call: object, expiresAt = expiry) {
  return commandV3(dbOf(f), f.seal(), image, JSON.stringify(call), {
    project: "a",
    device: owner,
    prefix: "forge",
    principal,
    expiresAt,
    now: Date.now(),
  });
}

async function acceptTyped(
  f: Fixture,
  image: V3Image,
  call: object,
  expected: Parameters<typeof expectTypedReply>[1],
  expiresAt = expiry,
) {
  const response = typed(f, image, call, expiresAt);
  expectTypedReply(
    { status: response.status, text: await response.text() },
    expected,
  );
}

function rejectCreate(
  f: Fixture,
  image: V3Image,
  call = invalidCreate,
  expiresAt = expiry,
) {
  const error = refusal(() => typed(f, image, call, expiresAt));
  expectTypedReply(
    { status: STATUS[error.code]!, text: JSON.stringify({ ok: false, error }) },
    invalidReply,
  );
}

async function drain(f: Fixture, image: V3Image) {
  let warm: V3Image | undefined = image;
  let prior = image.root.coveredHead;
  let more: boolean;
  do {
    const next = await checkpointV3(
      dbOf(f),
      f.seal(),
      f.storage,
      warm,
      (replacement) => {
        warm = replacement;
      },
      Project.admitLeaseRequest,
    );
    expect(next.coveredHead).toBeGreaterThanOrEqual(
      prior + Number(prior < image.head),
    );
    expect(next.coveredHead).toBeLessThanOrEqual(image.head);
    expect(next.more).toBe(next.coveredHead < image.head);
    const served = readV3Checkpoint(f);
    expect(next).toMatchObject({
      coveredHead: served.coveredHead,
      rosterDigest: digestValue(served.pages),
      projectionDigest: served.publicDigest,
    });
    prior = next.coveredHead;
    more = next.more;
  } while (more);
  expect(warm?.head).toBe(image.head);
  expect(warm?.root.coveredHead).toBe(image.head);
  expect(warm?.tailBytes).toBe(0);
  expect(tail(f)).toEqual([]);
  return warm;
}

function readV3Checkpoint(f: Fixture) {
  const { body } = f.db
    .query<{ body: string }, []>("SELECT body FROM cloud_v3_root WHERE id=1")
    .get()!;
  return JSON.parse(body) as {
    coveredHead: number;
    pages: unknown;
    publicDigest: string;
  };
}

function projection(f: Fixture, image: V3Image) {
  const stored = pages(f);
  const expected = rootedRecount(f, image);
  expect(Buffer.byteLength(stored.get("transcript:0")!)).toBe(
    expected.transcript,
  );
  expect(Buffer.byteLength(stored.get("snapshot:0")!)).toBe(expected.snapshot);
  expect(Buffer.byteLength(stored.get("directory:0")!)).toBeLessThanOrEqual(
    expected.directory,
  );
  return expected;
}

test(
  "U1 seeds an empty provisioned image",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    expect([
      image.head,
      image.root.coveredHead,
      image.tailBytes,
      image.entries.lease.size,
    ]).toEqual([0, 0, 0, 0]);
    expect(tail(f)).toEqual([]);
    const expected = { transcript: 2, snapshot: 0, directory: 2 };
    expect(rootedRecount(f, image)).toEqual(expected);
    expect(usageOf(image)).toEqual(expected);
  },
  timeout,
);

const early = now + 1_000;
const later = now + 2_000;
const typedId = "forge-4";
const update = {
  ...calls.update.call,
  input: { ...calls.update.call.input, id: typedId },
};
const typedUpdate = (title: string, revision: number, time: number) => ({
  ...calls.update.expected,
  result: {
    ...calls.update.expected.result,
    id: typedId,
    title,
    revision,
    updatedAt: new Date(time).toISOString(),
    lease: { ...calls.update.expected.result.lease, subject: "issue:work-4" },
  },
});
const receiptKey = (id: string) => scopeRequestId("command", principal, id);
const pointer = (
  image: V3Image,
  collection: keyof V3Image["entries"],
  key: string,
) =>
  expect(image.entries[collection].get(key)).toMatchObject({
    page: "snapshot:0",
  });

async function ordinaryScene(
  f: Fixture,
  observe: (label: string, current: V3Image) => void,
  atCheckpoint?: (label: string, current: V3Image) => Promise<V3Image>,
) {
  let image = await provision(f);
  const step = (label: string, count = 1) => {
    expect(image.head).toBe((head += count));
    observe(label, image);
  };
  let head = 0;
  write(f, image, note());
  step("first note");
  if (atCheckpoint) image = await atCheckpoint("after note", image);

  expect(image.entries.record.get("r1")).toBeUndefined();
  write(
    f,
    image,
    put({ key: "r1", revision: 1, value: "x".repeat(40_000) }),
    put({ key: "r1", revision: 2, value: "x" }),
  );
  expect(image.entries.record.get("r1")).toEqual({ revision: 2, value: "x" });
  step("put and shrink batch", 2);
  if (atCheckpoint) image = await atCheckpoint("after batch", image);
  write(
    f,
    image,
    put(
      { key: "r2", revision: 1, value: '雪"\u0001' },
      { key: "r3", revision: 1, value: "kept for pointer deletion" },
    ),
  );
  expect(image.entries.record.get("r2")).toEqual({
    revision: 1,
    value: '雪"\u0001',
  });
  expect(image.entries.record.get("r3")).toEqual({
    revision: 1,
    value: "kept for pointer deletion",
  });
  step("two keys in one frame");
  write(f, image, remove("r1", 3));
  expect(image.entries.record.get("r1")).toEqual({
    revision: 3,
    deleted: true,
  });
  step("value becomes tombstone");

  const subject = "warm-lease";
  const claimed = lease(
    f,
    image,
    "claim",
    leaseInput("claim", subject, "warm-claim"),
  );
  expect(claimed).toEqual({
    subject,
    holder,
    generation: 1,
    expiresAt: new Date(now + hour).toISOString(),
  });
  expect(image.entries.witness.size).toBe(1);
  step("claim and witness");
  const extended = {
    ...holder,
    session: {
      ...holder.session,
      agent: "a".repeat(200),
      harness: '"'.repeat(100) + "\u0001\u0002",
    },
  };
  const renewed = lease(
    f,
    image,
    "renew",
    leaseInput("renew", subject, "warm-renew", extended),
  );
  expect(renewed).toEqual({ ...claimed, holder: extended });
  step("renew with escaped holder fields");
  const wrong = {
    ...extended,
    session: { ...extended.session, id: "different" },
  };
  const error = refusal(() =>
    lease(
      f,
      image,
      "release",
      leaseInput("release", subject, "wrong-release", wrong),
    ),
  );
  expect([
    STATUS[error.code],
    error.code,
    exitCode({ ok: false, status: "FAIL", error, warnings: [] }),
  ]).toEqual([409, "LEASE_NOT_HELD", 4]);
  expect(readV3Value(dbOf(f), image, "lease", subject)).toEqual(renewed);
  step("wrong-session refusal while held");
  expect(
    lease(
      f,
      image,
      "release",
      leaseInput("release", subject, "warm-release", extended),
    ),
  ).toEqual({
    ...renewed,
    releasedAt: new Date(now).toISOString(),
  });
  step("release");
  if (atCheckpoint) image = await atCheckpoint("after leases", image);

  await acceptTyped(f, image, calls.create.call, {
    ...calls.create.expected,
    result: { ...calls.create.expected.result, id: typedId },
  });
  step("typed create");
  rejectCreate(f, image, invalidCreate, early);
  step("typed create refusal");
  const claim = {
    ...calls.claim.call,
    input: { ...calls.claim.call.input, id: typedId },
  };
  await acceptTyped(f, image, claim, {
    ...calls.claim.expected,
    result: { ...calls.claim.expected.result, id: typedId },
  });
  expect(image.entries.witness.size).toBe(2);
  step("typed claim and witness");
  await acceptTyped(f, image, update, typedUpdate("After", 2, now));
  step("typed update");

  const key = receiptKey(invalidCreate.requestId);
  expect(readV3Value(dbOf(f), image, "outcome", key)?.outcome).toMatchObject({
    status: "INPUT_INVALID",
    retryUntil: early,
  });
  setSystemTime(later);
  rejectCreate(f, image, {
    ...invalidCreate,
    input: { ignored: "warm replacement" },
  });
  expect(readV3Value(dbOf(f), image, "outcome", key)?.outcome).toMatchObject({
    id: key,
    status: "INPUT_INVALID",
    retryUntil: expiry,
  });
  step("expired request replaces value receipt");
  if (atCheckpoint) image = await atCheckpoint("after typed commands", image);
  return image;
}

test(
  "U2/U3 recount warm frames, checkpoint replacement and subsequent pointer mutations",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    const seen: Observation[] = [];
    const observe = (label: string, image: V3Image) => {
      const cold = coldImage(f);
      expect(viewV3(cold)).toEqual(viewV3(image));
      const expected = rootedRecount(f, image);
      expect(rootedRecount(f, cold)).toEqual(expected);
      remember(seen, label + " warm", image, expected);
      remember(seen, label + " cold", cold, expected);
    };
    const warm = await ordinaryScene(f, observe);
    const before = rootedRecount(f, warm);
    const replacement = await drain(f, warm);
    expect(rootedRecount(f, replacement)).toEqual(before);
    remember(seen, "checkpoint replacement", replacement, before);
    let image = coldImage(f);
    observe("cold after checkpoint", image);

    let head = image.head;
    const checkPointerWrite = (label: string) => {
      expect(image.head).toBe(++head);
      observe(label, image);
    };
    const input = leaseInput("claim", "pointer-lease", "pointer-claim");
    expect(lease(f, image, "claim", input).generation).toBe(1);
    checkPointerWrite("prepare pointer lease");
    image = await drain(f, image);
    image = coldImage(f);

    pointer(image, "lease", input.subject);
    const longer = {
      ...holder,
      session: { ...holder.session, agent: "pointer renewal" },
    };
    const renew = leaseInput("renew", input.subject, "pointer-renew", longer);
    expect(lease(f, image, "renew", renew)).toMatchObject({
      holder: longer,
      generation: 1,
    });
    checkPointerWrite("renew a pointer lease");
    image = await drain(f, image);
    image = coldImage(f);
    pointer(image, "lease", input.subject);
    expect(
      lease(
        f,
        image,
        "release",
        leaseInput("release", input.subject, "pointer-release"),
      ).releasedAt,
    ).toBe(new Date(later).toISOString());
    checkPointerWrite("release a pointer lease");

    pointer(image, "record", "r4");
    await acceptTyped(
      f,
      image,
      {
        ...update,
        requestId: "pointer-update",
        input: { id: typedId, expectRevision: 2, title: "Pointer update" },
      },
      typedUpdate("Pointer update", 3, later),
    );
    checkPointerWrite("update a pointer record");
    pointer(image, "record", "r3");
    write(f, image, remove("r3", 2));
    expect(image.entries.record.get("r3")).toEqual({
      revision: 2,
      deleted: true,
    });
    checkPointerWrite("delete a pointer record");

    const key = receiptKey(invalidCreate.requestId);
    pointer(image, "outcome", key);
    setSystemTime(expiry + 1);
    const newExpiry = expiry + hour;
    rejectCreate(
      f,
      image,
      { ...invalidCreate, input: { ignored: "cold replacement".repeat(12) } },
      newExpiry,
    );
    expect(readV3Value(dbOf(f), image, "outcome", key)?.outcome).toMatchObject({
      id: key,
      status: "INPUT_INVALID",
      retryUntil: newExpiry,
    });
    checkPointerWrite("replace an expired pointer receipt");

    const final = rootedRecount(f, image);
    const drained = await drain(f, image);
    expect(projection(f, drained)).toEqual(final);
    observe("final checkpoint and cold recovery", drained);
    assertUsage(seen);
  },
  timeout,
);

test(
  "U4 projects the same counters into each checkpoint's pages",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    const seen: Observation[] = [];
    await ordinaryScene(
      f,
      () => undefined,
      async (label, image) => {
        const before = rootedRecount(f, image);
        f.restart();
        const result = await f.send(`${probe}/checkpoint`, {});
        expect(result).toMatchObject({
          status: 200,
          body: { ok: true, value: { coveredHead: image.head, more: false } },
        });
        expect(tail(f)).toEqual([]);
        const cold = coldImage(f);
        const expected = projection(f, cold);
        expect(expected).toEqual(before);
        remember(seen, label + " before", image, expected);
        remember(seen, label + " after", cold, expected);
        return cold;
      },
    );
    assertUsage(seen);
  },
  timeout,
);

async function restore(source: Fixture, target: Fixture, sourceImage: V3Image) {
  await drain(source, sourceImage);
  const portable = portableOf(source);
  const upload = portableUpload(target, portable);
  setSystemTime(now + 1);
  for (let page = 0; page < portable.pages.length; page++) {
    const result = await upload(page);
    expect(result).toEqual({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  }
  expect([...pages(target)]).toEqual(
    portable.pages.map(({ id, body }) => [id, body]),
  );
  return portable;
}

function activationUsage(f: Fixture, image: V3Image) {
  const stored = pages(f);
  const rows = tail(f);
  expect(rows).toHaveLength(1);
  const [{ sequence, body }] = rows as [{ sequence: number; body: string }];
  const frame = archived(body);
  expect(sequence).toBe(image.root.coveredHead + 1);
  expect(image.head).toBe(sequence);
  expect(frame).toMatchObject({
    operation: "restore.activate",
    sequence,
    time: now + 1,
  });
  expect(image.entries.control.size).toBe(1);
  expect(frame.control).toEqual(
    readV3Value(dbOf(f), image, "control", "global"),
  );
  const expected = rootedRecount(f, image);
  const covered = stored.get("transcript:0")!;
  expect(expected.transcript).toBe(
    Buffer.byteLength(covered) +
      Buffer.byteLength(body) +
      Number(covered !== "[]"),
  );
  return expected;
}

test.each([
  ["nonempty", true],
  ["empty", false],
] as const)(
  "U5 recounts an activated restore target with an %s transcript",
  async (_label, populated) => {
    const source = guardFixture(typedEnv);
    const target = guardFixture(typedEnv);
    using _source = source.db;
    using _target = target.db;
    const image = await provision(source);
    if (populated) {
      await acceptTyped(
        source,
        image,
        calls.create.call,
        calls.create.expected,
      );
      for (let i = 1; i <= 4; i++) {
        const subject = `restore-${i}`;
        expect(
          lease(
            source,
            image,
            "claim",
            leaseInput("claim", subject, `claim-${i}`),
          ).generation,
        ).toBe(1);
      }
      expect(
        lease(
          source,
          image,
          "release",
          leaseInput("release", "restore-4", "release-4"),
        ).releasedAt,
      ).toBe(new Date(now).toISOString());
    }
    const data = await restore(source, target, image);
    const first = coldImage(target);
    target.restart();
    const second = coldImage(target);
    expect(viewV3(second)).toEqual(viewV3(first));
    expect([first.head, first.eventWatermark, first.recordFloor]).toEqual([
      data.head + 1,
      data.eventWatermark + 1,
      data.recordFloor,
    ]);
    expect(first.entries.lease.size).toBe(populated ? 4 : 0);
    expect(first.entries.record.size).toBe(populated ? 1 : 0);
    const expected = activationUsage(target, first);
    expect(activationUsage(target, second)).toEqual(expected);

    const imported = coldImage(source);
    const stored = pages(target);
    const importedValues = inventory(imported, buffers(stored));
    const activatedValues = inventory(first, buffers(stored));
    const stable = (items: typeof importedValues) =>
      items.filter(
        ([collection]) => collection !== "lease" && collection !== "control",
      );
    expect(stable(activatedValues)).toEqual(stable(importedValues));
    let releaseGrowth = 0;
    for (const subject of imported.entries.lease.keys()) {
      const old = readV3Value(dbOf(source), imported, "lease", subject)!;
      const next = readV3Value(dbOf(target), first, "lease", subject);
      expect(next).toEqual({
        ...old,
        releasedAt: old.releasedAt ?? new Date(now + 1).toISOString(),
      });
      releaseGrowth += jsonBytes(next) - jsonBytes(old);
    }
    const global = readV3Value(dbOf(target), first, "control", "global");
    expect(expected.snapshot).toBe(
      Buffer.byteLength(stored.get("snapshot:0")!) +
        releaseGrowth +
        jsonBytes(global),
    );
    expect(releaseGrowth).toBe(
      populated
        ? 3 * (jsonBytes({ releasedAt: new Date(now + 1).toISOString() }) - 1)
        : 0,
    );
    expect(usageOf(first)).toEqual(expected);
    expect(usageOf(second)).toEqual(expected);
  },
  timeout,
);

test(
  "U5 subtracts all imported control pointers before installing the activated global",
  async () => {
    const target = guardFixture();
    using _target = target.db;
    const source = guardFixture();
    using _source = source.db;
    const image = await provision(source);
    const controls = [
      [
        "global",
        {
          version: 1,
          incarnation: "former",
          epoch: 1,
          resumeAllEpoch: 0,
          stopAll: new Date(now).toISOString(),
        },
      ],
      [
        "issue:work-1",
        {
          version: 1,
          id: "work-1",
          incarnation: "former",
          epoch: 1,
          stoppedAt: new Date(now).toISOString(),
        },
      ],
    ] as const;
    const items = controls.map(
      ([key, value]) =>
        ["control", key, canonicalJson(value), undefined] as const,
    );
    let offset = 0;
    const directory = items.map(([collection, key, body]) => {
      const length = Buffer.byteLength(body);
      const entry = {
        collection,
        key,
        page: "snapshot:0",
        offset,
        length,
        digest: digestBytes(body),
      };
      offset += length;
      return entry;
    });
    const stored = new Map([
      ["directory:0", canonicalJson(directory)],
      ["snapshot:0", items.map((item) => item[2]).join("")],
      ["transcript:0", "[]"],
    ]);
    setSystemTime(now + 1);
    const db = dbOf(target);
    const seal = target.seal();
    activateV3(
      db,
      seal,
      image,
      roster(stored, items, image.head),
      stored,
      digestProjection(items),
    );
    const activated = recoverV3(db, seal, {
      admit: Project.admitLeaseRequest,
      sealed: (imported) => {
        for (const [key, value] of controls) {
          pointer(imported, "control", key);
          expect(readV3Value(db, imported, "control", key)).toEqual(value);
        }
      },
    });
    const expected = activationUsage(target, activated);
    expect([...activated.entries.control.keys()]).toEqual(["global"]);
    expect(expected.snapshot).toBe(
      jsonBytes(readV3Value(db, activated, "control", "global")),
    );
    expect(usageOf(activated)).toEqual(expected);
  },
  timeout,
);

test(
  "U6 counts an archived transcript and its reconstructed projection",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    const image = await ordinaryScene(f, () => undefined);
    const drained = await drain(f, image);
    const stored = pages(f);
    const frames = JSON.parse(stored.get("transcript:0")!) as unknown[];
    const folded = foldTranscript(
      dbOf(f),
      frames,
      "archived",
      Project.admitLeaseRequest,
    );
    expect(viewV3(folded).image).toEqual(viewV3(drained).image);
    const expected = projection(f, drained);
    expect(recount(folded, frames)).toEqual(expected);
    expect(usageOf(folded)).toEqual(expected);
  },
  timeout,
);

test(
  "U6 counts portable stubs and archived outcomes by their source bytes",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    const db = dbOf(f);
    const stub = { sequence: 1 };
    const only = foldTranscript(
      db,
      [stub],
      "portable",
      Project.admitLeaseRequest,
    );
    expect(only.head).toBe(1);
    expect(inventory(only, new Map())).toEqual([]);
    const onlyExpected = recount(only, [stub]);
    expect(onlyExpected).toEqual({
      transcript: jsonBytes([stub]),
      snapshot: 0,
      directory: 2,
    });

    const warm = await provision(f);
    write(f, warm, note());
    await acceptTyped(f, warm, calls.create.call, calls.create.expected);
    expect(warm.head).toBe(2);
    const full = await drain(f, warm);
    const [, outcome] = JSON.parse(pages(f).get("transcript:0")!) as unknown[];
    expect(outcome).toMatchObject({
      sequence: 2,
      outcome: { resultDigest: digestValue(calls.create.expected.result) },
    });
    const members = [stub, outcome];
    const mixed = foldTranscript(
      db,
      members,
      "portable",
      Project.admitLeaseRequest,
    );
    expect(viewV3(mixed).image).toEqual(viewV3(full).image);
    expect(
      readV3Value(db, mixed, "outcome", receiptKey(calls.create.call.requestId))
        ?.outcome.result,
    ).toEqual(calls.create.expected.result);
    const mixedExpected = recount(mixed, members);
    expect(mixedExpected).toEqual({
      ...projection(f, full),
      transcript: jsonBytes(members),
    });
    expect(usageOf(only)).toEqual(onlyExpected);
    expect(usageOf(mixed)).toEqual(mixedExpected);
  },
  timeout,
);

test(
  "U7 admits the oversized interior of a shrinking batch",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const largeHolder = {
      ...holder,
      session: {
        ...holder.session,
        id: "fixture" + "x".repeat(181),
        agent: "\u0001".repeat(200),
        harness: "\u0001".repeat(200),
      },
    };
    expect(jsonBytes(largeHolder)).toBe(2692);
    for (let i = 1; i <= 12; i++) {
      const subject = `work-${i}`;
      expect(
        lease(
          f,
          image,
          "claim",
          leaseInput("claim", subject, `claim-${i}`, largeHolder),
        ),
      ).toEqual({
        subject,
        generation: 1,
        holder: largeHolder,
        expiresAt: new Date(now + hour).toISOString(),
      });
      expect(
        lease(
          f,
          image,
          "release",
          leaseInput("release", subject, `release-${i}`, largeHolder),
        ),
      ).toMatchObject({
        subject,
        generation: 1,
        holder: largeHolder,
        releasedAt: new Date(now).toISOString(),
      });
    }
    write(f, image, ...Array.from({ length: 11 }, note));
    expect(image.head).toBe(35);
    write(
      f,
      image,
      put({ key: "r1", revision: 1, value: "x".repeat(40_000) }),
      put({ key: "r1", revision: 2, value: "x" }),
    );
    expect(image.head).toBe(37);
    const db = dbOf(f);
    const verification = archivedCheck(db, {
      admit: Project.admitLeaseRequest,
      failure: unavailable,
    });
    const prefix = recoverV3(db, f.seal(), verification, { through: 36 });
    const end = recoverV3(db, f.seal(), verification, { through: 37 });
    expect([prefix.head, end.head, tail(f).length]).toEqual([36, 37, 37]);
    expect(viewV3(image)).toEqual(viewV3(end));
    const before = rootedRecount(f, prefix);
    const after = rootedRecount(f, end);
    expect(before.snapshot).toBeGreaterThan(PAGE_BYTES);
    expect(after.snapshot).toBeLessThanOrEqual(PAGE_BYTES);
    expect(usageOf(prefix)).toEqual(before);
    expect(usageOf(end)).toEqual(after);
  },
  timeout,
);

const headers = {
  "X-Forge-Owner": owner,
  "X-Forge-Owner-Expires": String(expiry),
};
test(
  "U7 admits and counts a seventeenth lease subject",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    await provision(f);
    for (let i = 1; i <= 17; i++) {
      const subject = `work-${i}`;
      const reply = await f.send(
        `${probe}/claim`,
        leaseInput("claim", subject, `claim-${i}`),
        headers,
      );
      expect(reply).toEqual({
        status: 200,
        body: {
          ok: true,
          value: {
            subject,
            holder,
            generation: 1,
            expiresAt: new Date(now + hour).toISOString(),
          },
        },
      });
    }
    const image = coldImage(f);
    expect([image.head, image.entries.lease.size, tail(f).length]).toEqual([
      17, 17, 17,
    ]);
    const expected = rootedRecount(f, image);
    expect(usageOf(image)).toEqual(expected);
  },
  timeout,
);

test(
  "U7 admits minimal recorded refusals past the transcript page size",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await provision(f);
    let transcript = 2;
    let head = 0;
    while (transcript <= PAGE_BYTES && head < TAIL_ROWS) {
      head++;
      const reply = await f.sendText(
        `${probe}/command`,
        { ...invalidCreate, requestId: `refusal-${head}` },
        headers,
      );
      expectTypedReply(reply, invalidReply);
      const rows = tail(f, head - 1, head);
      expect(rows).toHaveLength(1);
      const frame = archived(rows[0]!.body);
      expect(frame).toMatchObject({
        sequence: head,
        outcome: { id: receiptKey(`refusal-${head}`), status: "INPUT_INVALID" },
      });
      transcript += jsonBytes(frame) + Number(head > 1);
    }
    expect(transcript).toBeGreaterThan(PAGE_BYTES);
    const image = coldImage(f);
    expect([image.head, image.entries.outcome.size, tail(f).length]).toEqual([
      head,
      head,
      head,
    ]);
    const expected = rootedRecount(f, image);
    expect(expected.transcript).toBe(transcript);
    expect(usageOf(image)).toEqual(expected);
  },
  timeout,
);

test(
  "U8 keeps probe reads, view and command replay unchanged and read-only",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    const warm = await provision(f);
    write(f, warm, note());
    const first = typed(f, warm, calls.create.call);
    const reply = { status: first.status, text: await first.text() };
    expectTypedReply(reply, calls.create.expected);
    const expected = viewV3(warm);
    expect(Object.keys(expected).sort()).toEqual(
      [...Object.keys(warm.root), "image"].sort(),
    );
    expect(Object.keys(expected.image).sort()).toEqual([
      "control",
      "eventWatermark",
      "head",
      "lease",
      "outcome",
      "record",
      "witness",
    ]);
    expect(viewV3(coldImage(f))).toEqual(expected);
    f.restart();
    const unchanged = f.observeEffects();
    expect(await f.send(probe)).toEqual({
      status: 200,
      body: { ok: true, value: expected },
    });
    expect(await f.send(probe)).toEqual({
      status: 200,
      body: { ok: true, value: expected },
    });
    const replay = await f.sendText(
      `${probe}/command`,
      calls.create.call,
      headers,
    );
    expect(replay).toEqual(reply);
    expect(unchanged()).toEqual(noWrites);
  },
  timeout,
);
