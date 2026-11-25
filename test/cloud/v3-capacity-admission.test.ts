import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { CREATE_SCHEMA } from "../../cloud/src/issue-create.ts";
import { Project } from "../../cloud/src/project.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  digestProjection,
  inventory,
  roster,
} from "../../cloud/src/v3-checkpoint.ts";
import { authenticateManifest } from "../../cloud/src/v3-seal.ts";
import * as store from "../../cloud/src/v3-store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
} from "../../src/core/config/pointer.ts";
import type {
  ForgeError,
  LeaseHolder,
  LeaseRecord,
  ResultEnvelope,
} from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  expectTypedReply,
  guardFixture,
  noWrites,
  portableOf,
  portableUpload,
  probe,
  recovered,
  trustedManifest,
  typedReplyCases,
  type Portable,
} from "./v3-project.fixture.ts";
import {
  buffers as pageBuffers,
  jsonBytes as bytes,
  pages as pagesOf,
  rootedRecount,
  tail as rowsOf,
} from "./v3-usage.fixture.ts";

const timeout = 30_000;
const now = Date.parse("2026-11-20T12:00:00.000Z");
const hour = 3_600_000;
const expiry = now + 2 * hour;
const owner = "owner-a";
const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const holder: LeaseHolder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture", device: owner },
};
const largeHolder: LeaseHolder = {
  ...holder,
  session: {
    ...holder.session,
    id: "fixture" + "x".repeat(181),
    agent: "\u0001".repeat(200),
    harness: "\u0001".repeat(200),
  },
};
const historyFull: ForgeError = {
  code: "STORAGE_LIMIT_EXCEEDED",
  message:
    "This project's history is full. Ordinary writes are refused to keep room to release leases, stop lanes and restore.",
  retry: "never",
};
const cap = {
  transcript: 262_144,
  snapshot: 262_144,
  directory: 262_144,
  rows: 1024,
  raw: 1_048_576,
  leases: 16,
};
const hard = { ...cap, raw: 16 * 1_048_576, leases: Infinity };
const empty = {
  transcript: 0,
  snapshot: 0,
  directory: 0,
  rows: 0,
  raw: 0,
  leases: 0,
};
const stop = {
  ...empty,
  transcript: 4096,
  snapshot: 4096,
  directory: 512,
  rows: 1,
  raw: 4096,
};
const activation = {
  ...empty,
  transcript: 2049,
  snapshot: 2736,
  directory: 175,
  rows: 1,
  raw: 2048,
};
const remaining = {
  ...empty,
  transcript: 7168,
  snapshot: 4096,
  directory: 1024,
  rows: 2,
  raw: 7168,
};

type Measure = typeof empty;
type Dimension = keyof Measure;
type Usage = Pick<Measure, "transcript" | "snapshot" | "directory">;
type Fixture = ReturnType<typeof guardFixture>;
type Image = store.V3Image;
type Body = store.Frame & { format: "forge-cloud-commit/3"; sequence: number };
type Slot =
  { revision?: number; value: unknown } | { revision?: number; deleted: true };
type Item = readonly [
  collection: string,
  key: string,
  body: string | null,
  revision: number | undefined,
];

const dimensions = Object.keys(cap) as Dimension[];
const add = (left: Measure, right: Measure): Measure =>
  Object.fromEntries(
    dimensions.map((key) => [key, left[key] + right[key]]),
  ) as Measure;
const negate = (value: Measure): Measure =>
  Object.fromEntries(dimensions.map((key) => [key, -value[key]])) as Measure;
const ordinary = add(add(stop, activation), remaining);
const dbOf = (f: Fixture) => writableStore(f.storage);
const cold = (f: Fixture) => recovered(dbOf(f), f.seal());
const exported = (name: string): unknown => Reflect.get(store, name) as unknown;
const membersOf = (f: Fixture) =>
  JSON.parse(pagesOf(f).get("transcript:0")!) as unknown[];

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

const encoded = (frame: store.Frame, sequence: number): Body => ({
  ...frame,
  format: "forge-cloud-commit/3",
  sequence,
});
const note = (time = Date.now()): store.Frame => ({
  operation: "fixture.note",
  time,
  events: [],
});
function paddedNote(
  size: number,
  sequence: number,
  time = Date.now(),
): store.Frame {
  const frame = { ...note(time), events: [{ pad: "" }] };
  const padding = size - bytes(encoded(frame, sequence));
  frame.events[0]!.pad = "x".repeat(padding);
  return frame;
}

const put = (
  ...events: { key: string; revision: number; value: unknown }[]
): store.Frame => ({
  ...note(),
  operation: "fixture.put",
  events,
  changes: events.map(({ key, revision, value }) => ({
    key,
    value: { revision, value },
  })),
});
const record = (value: unknown, key = "r1", revision = 1) =>
  put({ key, revision, value });
const remove = (key: string, revision: number): store.Frame => ({
  ...note(),
  operation: "fixture.delete",
  events: [{ key, revision }],
  changes: [{ key, value: { revision, deleted: true } }],
});

function archived(frame: Body): unknown {
  if (frame.outcome?.result === undefined) return frame;
  const { result, ...outcome } = frame.outcome;
  return {
    ...frame,
    outcome: { ...outcome, resultDigest: digestValue(result) },
  };
}

function directory([collection, key, body, revision]: Item) {
  const identity = {
    collection,
    key,
    ...(revision === undefined ? {} : { revision }),
  };
  return (
    bytes(
      body === null
        ? { ...identity, deleted: true }
        : {
            ...identity,
            page: "snapshot:0",
            offset: 999999,
            length: 999999,
            digest: "sha256:" + "0".repeat(64),
          },
    ) + 1
  );
}

function recount(items: readonly Item[], members: readonly unknown[]): Usage {
  return {
    transcript: bytes(members),
    snapshot: items.reduce(
      (sum, [, , body]) => sum + (body === null ? 0 : Buffer.byteLength(body)),
      0,
    ),
    directory: 2 + items.reduce((sum, item) => sum + directory(item), 0),
  };
}

function assertUsage(f: Fixture, image: Image) {
  expect(image.usage).toEqual(rootedRecount(f, image));
}

const itemKey = (collection: string, key: string) => collection + ":" + key;
function applyFrame(items: Map<string, Item>, frame: store.Frame) {
  const { lease, outcome, witness, time } = frame;
  const save = (
    collection: string,
    key: string,
    value: unknown,
    revision?: number,
  ) => {
    items.set(itemKey(collection, key), [
      collection,
      key,
      canonicalJson(value),
      revision,
    ]);
  };
  if (lease) save("lease", lease.subject, lease);
  if (outcome)
    save("outcome", outcome.id, { ...(lease && { lease }), outcome, time });
  if (witness) save("witness", witness.id, { lease, witness });
  for (const { key, value } of (frame.changes ?? []) as {
    key: string;
    value: Slot;
  }[]) {
    if ("deleted" in value)
      items.set(itemKey("record", key), ["record", key, null, value.revision]);
    else save("record", key, value.value, value.revision);
  }
}

const leaseScope = (device: string) => ({
  version: 2 as const,
  principal: digestValue(["owner", device, device]),
});
const leaseId = (device: string, raw: string) =>
  "l2:" + digestValue([2, "lease", ["owner", device, device], raw]).slice(7);
type LeaseRoute = "claim" | "renew" | "release";

function leaseFrame(
  route: LeaseRoute,
  subject: string,
  leaseHolder: LeaseHolder,
  rawId: string,
  time: number,
  retryUntil: number,
  generation: number,
  ttlMs: number | null,
  prior?: LeaseRecord,
  error?: ForgeError,
): store.Frame {
  const device = leaseHolder.session.device!;
  const scope = leaseScope(device);
  const id = leaseId(device, rawId);
  const fingerprint = canonicalJson({
    scope,
    route,
    subject,
    holder: leaseHolder,
    generation: route === "claim" ? null : generation,
    ttlMs,
  });
  const outcome = {
    id,
    scope: { family: "lease" as const, ...scope },
    fingerprint,
    retryUntil,
    status: error?.code ?? "ok",
  };
  const frame = { operation: "lease." + route, time, events: [] };
  if (error) return { ...frame, outcome: { ...outcome, result: error } };
  const lease =
    route === "release"
      ? {
          ...prior!,
          holder: leaseHolder,
          releasedAt: new Date(time).toISOString(),
        }
      : {
          subject,
          holder: leaseHolder,
          generation,
          expiresAt: new Date(time + ttlMs!).toISOString(),
        };
  return {
    ...frame,
    lease,
    outcome,
    ...(route === "claim" && {
      witness: {
        namespace: "forge/work",
        id,
        subject,
        generation,
        digest: digestBytes(fingerprint),
      },
    }),
  };
}

function releaseCost(
  lease: LeaseRecord,
  frame: store.Frame,
  sequence: number,
): Measure {
  const row = encoded(frame, sequence);
  const outcome = frame.outcome!;
  const item: Item = [
    "outcome",
    outcome.id,
    canonicalJson({ lease: frame.lease, outcome, time: frame.time }),
    undefined,
  ];
  return {
    transcript: bytes(archived(row)) + 1,
    snapshot: bytes(frame.lease) - bytes(lease) + Buffer.byteLength(item[2]!),
    directory: directory(item),
    rows: 1,
    raw: bytes(row),
    leases: 0,
  };
}

function releaseBudget(lease: LeaseRecord): Measure {
  const time = 8.64e15;
  const frame = leaseFrame(
    "release",
    lease.subject,
    lease.holder,
    "wide",
    time,
    time,
    lease.generation,
    null,
    lease,
  );
  return releaseCost(lease, frame, Number.MAX_SAFE_INTEGER);
}

function guarded(items: Iterable<Item>, time: number): LeaseRecord[] {
  return [...items]
    .filter(([collection]) => collection === "lease")
    .map(([, , body]) => JSON.parse(body!) as LeaseRecord)
    .filter(
      ({ expiresAt, releasedAt }) =>
        releasedAt === undefined && Date.parse(expiresAt) > time,
    );
}

const reserve = (items: Iterable<Item>, time: number) =>
  guarded(items, time).reduce(
    (total, lease) => add(total, releaseBudget(lease)),
    ordinary,
  );

function projection(f: Fixture, image: Image) {
  const items = new Map(
    inventory(image, pageBuffers(pagesOf(f))).map((item) => [
      itemKey(item[0], item[1]),
      [...item] as Item,
    ]),
  );
  const members = [
    ...membersOf(f),
    ...rowsOf(f, image.root.coveredHead, image.head).map(({ body }) =>
      archived(JSON.parse(body) as Body),
    ),
  ];
  return {
    items,
    members,
    raw: image.tailBytes,
    rows: image.head - image.root.coveredHead,
    head: image.head,
  };
}

type Projection = ReturnType<typeof projection>;
function advance(state: Projection, frame: store.Frame): Projection {
  const row = encoded(frame, state.head + 1);
  const items = new Map(state.items);
  applyFrame(items, frame);
  return {
    items,
    members: [...state.members, archived(row)],
    head: row.sequence,
    rows: state.rows + 1,
    raw: state.raw + bytes(row),
  };
}

function measure({ items, members, raw, rows }: Projection): Measure {
  return {
    ...recount([...items.values()], members),
    raw,
    rows,
    leases: [...items.values()].filter(([collection]) => collection === "lease")
      .length,
  };
}

function room(state: Projection, time = Date.now()): Measure {
  return add(
    cap,
    negate(add(measure(state), reserve(state.items.values(), time))),
  );
}

function assertBoundary(
  state: Projection,
  binding: Dimension,
  slack: number,
  time = Date.now(),
) {
  const left = room(state, time);
  expect(left[binding], binding).toBe(slack);
  for (const dim of dimensions)
    if (dim !== binding) expect(left[dim], dim).toBeGreaterThanOrEqual(0);
}

function write(
  f: Fixture,
  image: Image,
  frames: readonly store.Frame[],
  synthetic = true,
) {
  const head = image.head + frames.length;
  const result = synthetic
    ? store.appendV3Frames(dbOf(f), f.seal(), frames, () => image)
    : store.append(dbOf(f), f.seal(), image, frames);
  store.publishV3(image);
  expect(result).toEqual({ head });
  expect(rowsOf(f, head - frames.length, head)).toHaveLength(frames.length);
  f.restart();
  return result;
}

function legacyWrite(f: Fixture, head: number, frames: readonly store.Frame[]) {
  const insert = f.db.prepare("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)");
  for (const [index, frame] of frames.entries()) {
    const sequence = head + index + 1;
    const body = canonicalJson(encoded(frame, sequence));
    insert.run(sequence, body, f.sign(sequence, body));
  }
}

async function provision(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
  return cold(f);
}

function stateOf(f: Fixture, image: Image) {
  return {
    rows: rowsOf(f),
    pages: pagesOf(f),
    root: image.root,
    head: image.head,
    tailBytes: image.tailBytes,
    recordFloor: image.recordFloor,
    eventWatermark: image.eventWatermark,
    stale: image.stale,
    staged: [...image.staged],
    usage: { ...image.usage },
    entries: Object.fromEntries(
      Object.entries(image.entries).map(([key, value]) => [key, [...value]]),
    ),
  };
}

function caught(call: () => unknown): ForgeError | undefined {
  try {
    call();
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error;
    throw error;
  }
  return undefined;
}

function refuse(
  f: Fixture,
  image: Image,
  call: (current: Image) => unknown,
  error = historyFull,
) {
  const before = stateOf(f, image);
  const effects = f.observeEffects();
  expect(caught(() => call(image))).toEqual(error);
  expect(effects()).toEqual(noWrites);
  expect(stateOf(f, image)).toEqual(before);
  assertUsage(f, image);
  expect(caught(() => call(image))).toEqual(error);
  expect(effects()).toEqual(noWrites);
  const recoveredImage = cold(f);
  expect(caught(() => call(recoveredImage))).toEqual(error);
  expect(effects()).toEqual(noWrites);
  expect(stateOf(f, recoveredImage)).toEqual(before);
  assertUsage(f, recoveredImage);
}

function refuseFrames(
  f: Fixture,
  image: Image,
  frames: readonly store.Frame[],
  synthetic = true,
  error = historyFull,
) {
  refuse(
    f,
    image,
    (candidate) =>
      synthetic
        ? store.appendV3Frames(dbOf(f), f.seal(), frames, () => candidate)
        : store.append(dbOf(f), f.seal(), candidate, frames),
    error,
  );
}

const headers = (device = owner, expires = expiry) => ({
  "X-Forge-Owner": device,
  "X-Forge-Owner-Expires": String(expires),
});
const wireError = (status: number, error: ForgeError) => ({
  status,
  body: { ok: false, error },
});
function exited(body: unknown) {
  const reply = body as ResultEnvelope;
  return exitCode(
    reply.ok ? reply : { ...reply, status: "FAIL", warnings: [] },
  );
}
const capacityReply = wireError(503, historyFull);
type Reply = Awaited<ReturnType<Fixture["send"]>>;

async function refuseRoute(
  f: Fixture,
  invoke: () => Promise<Reply>,
  error = capacityReply,
  exit = 1,
) {
  expect((await f.send(probe)).status).toBe(200);
  const image = cold(f);
  const before = stateOf(f, image);
  const effects = f.observeEffects();
  const actual = await invoke();
  expect(actual).toEqual(error);
  expect(exited(actual.body)).toBe(exit);
  expect(effects()).toEqual(noWrites);
  const after = cold(f);
  expect(stateOf(f, after)).toEqual(before);
  assertUsage(f, after);
  expect(await invoke()).toEqual(error);
  expect(effects()).toEqual(noWrites);
  f.restart();
  expect(await invoke()).toEqual(error);
  expect(effects()).toEqual(noWrites);
  assertUsage(f, cold(f));
}

function useLease(
  f: Fixture,
  image: Image,
  route: LeaseRoute,
  subject: string,
  id: string,
  leaseHolder = holder,
  ttlMs = hour,
  time = Date.now(),
  expires = expiry,
  generation = 1,
) {
  const input = {
    subject,
    holder: leaseHolder,
    requestId: id,
    ttlMs,
    generation,
  };
  const command = Project.admitLeaseRequest(
    route,
    JSON.stringify(input),
    leaseHolder.session.device,
    null,
    undefined,
    expires,
    time,
  );
  const lease = store.leaseV3(dbOf(f), f.seal(), image, command, expires, time);
  f.restart();
  return lease;
}

function sendLease(
  f: Fixture,
  route: LeaseRoute,
  subject: string,
  requestId: string,
  leaseHolder = holder,
  ttlMs = hour,
  expires = expiry,
  generation = 1,
) {
  return f.send(
    probe + "/" + route,
    { subject, requestId, holder: leaseHolder, ttlMs, generation },
    headers(leaseHolder.session.device, expires),
  );
}

const calls = typedReplyCases(now, owner);
const invalidCall = {
  ...calls.create.call,
  requestId: "invalid",
  input: { title: "" },
};
const invalidError: ForgeError = {
  code: "INPUT_INVALID",
  message: CREATE_SCHEMA,
  retry: "never",
};
const typed = (f: Fixture, call: object) =>
  f.send(probe + "/command", call, headers());

function fillTranscript(
  f: Fixture,
  image: Image,
  left: number,
  time = Date.now(),
) {
  const state = projection(f, image);
  const separator = Number(image.head !== 0);
  const frame = paddedNote(
    room(state, time).transcript - left - separator,
    image.head + 1,
    time,
  );
  assertBoundary(advance(state, frame), "transcript", left, time);
  write(f, image, [frame]);
}

const checkpoint = (f: Fixture) => f.send(probe + "/checkpoint", {});
async function drain(f: Fixture) {
  for (;;) {
    const result = await checkpoint(f);
    expect(result.status).toBe(200);
    if (!(result.body as { value: { more: boolean } }).value.more) break;
  }
  expect(rowsOf(f)).toEqual([]);
  const image = cold(f);
  assertUsage(f, image);
  return image;
}

async function restore(target: Fixture, backup: Portable) {
  const upload = portableUpload(target, backup);
  for (const page of [0, 1, 2])
    expect(await upload(page)).toEqual({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  target.restart();
  expect((await target.send(probe)).status).toBe(200);
  const image = cold(target);
  assertUsage(target, image);
  return image;
}

type Admits = (
  before: Measure,
  after: Measure,
  beforeReserve: Measure,
  afterReserve: Measure,
) => boolean;

test(
  "A1 accepts equality at every ordinary capacity limit",
  () => {
    const candidate = exported("admits");
    expect(typeof candidate).toBe("function");
    const admits = candidate as Admits;
    expect(ordinary).toEqual({
      transcript: 13_313,
      snapshot: 10_928,
      directory: 1711,
      rows: 4,
      raw: 13_312,
      leases: 0,
    });
    expect(
      admits(
        empty,
        { ...empty, transcript: 2, directory: 2 },
        ordinary,
        ordinary,
      ),
    ).toBe(true);
    for (const dimension of dimensions) {
      const afterReserve = {
        ...empty,
        [dimension]: dimension === "leases" ? 0 : 1,
      };
      for (const delta of [-1, 0, 1]) {
        const after = {
          ...empty,
          [dimension]: cap[dimension] - afterReserve[dimension] + delta,
        };
        expect(admits(empty, after, empty, afterReserve), dimension).toBe(
          delta <= 0,
        );
      }
    }
  },
  timeout,
);

test(
  "A2 permits non-increase on legacy capacity up to each hard limit",
  () => {
    const candidate = exported("admits");
    expect(typeof candidate).toBe("function");
    const admits = candidate as Admits;
    for (const dimension of dimensions) {
      const limit = Number.isFinite(hard[dimension]) ? hard[dimension] : 17;
      const before = { ...empty, [dimension]: limit };
      const reserved = { ...empty, [dimension]: 2 };
      for (const delta of [-1, 0, 1]) {
        const after = { ...empty, [dimension]: limit + delta };
        expect(admits(before, after, reserved, reserved), dimension).toBe(
          delta <= 0,
        );
      }
      expect(
        admits(before, { ...before, [dimension]: limit + 1 }, reserved, empty),
        dimension,
      ).toBe(dimension === "leases");
    }
  },
  timeout,
);

test.each([
  [
    "ASCII",
    { ...holder, session: { ...holder.session, agent: "a".repeat(200) } },
  ],
  [
    "quotation marks",
    { ...holder, session: { ...holder.session, agent: '"'.repeat(100) } },
  ],
  [
    "control characters",
    { ...holder, session: { ...holder.session, agent: "\u0001".repeat(100) } },
  ],
  [
    "maximum escaped labels",
    {
      actor: { kind: "agent", id: "\u0001".repeat(200) },
      session: {
        id: "\u0001".repeat(200),
        device: "\u0001".repeat(256),
        agent: "\u0001".repeat(200),
        harness: "\u0001".repeat(200),
      },
    },
  ],
] as const)(
  "A3 release reserve dominates both encodings with %s",
  async (_label, leaseHolder) => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const lease = useLease(f, image, "claim", "work-1", "claim", leaseHolder);
    expect(
      useLease(f, image, "release", lease.subject, "release", leaseHolder)
        .releasedAt,
    ).toBe(new Date(now).toISOString());
    const release = JSON.parse(rowsOf(f).at(-1)!.body) as Body;
    const ordinaryRelease = leaseFrame(
      "release",
      lease.subject,
      leaseHolder,
      "release",
      now,
      expiry,
      1,
      null,
      lease,
    );
    expect(release).toEqual(encoded(ordinaryRelease, 2));
    const revoke = leaseFrame(
      "release",
      lease.subject,
      leaseHolder,
      "revoke/token/work-1",
      now,
      Date.parse(lease.expiresAt),
      1,
      null,
      lease,
    );
    const candidate = exported("releaseBudget");
    expect(typeof candidate).toBe("function");
    const budget = (candidate as (record: LeaseRecord) => Measure)(lease);
    expect(budget).toEqual(releaseBudget(lease));
    for (const frame of [release, revoke])
      for (const dim of dimensions)
        expect(releaseCost(lease, frame, 2)[dim], dim).toBeLessThanOrEqual(
          budget[dim],
        );
    assertUsage(f, image);
  },
  timeout,
);

function cycles(f: Fixture, image: Image, count = 12) {
  const frames = Array.from({ length: count }, (_, i) => {
    const subject = "work-" + (i + 1);
    const claim = leaseFrame(
      "claim",
      subject,
      largeHolder,
      "claim-" + subject,
      now,
      expiry,
      1,
      hour,
    );
    return [
      claim,
      leaseFrame(
        "release",
        subject,
        largeHolder,
        "release-" + subject,
        now,
        expiry,
        1,
        null,
        claim.lease,
      ),
    ];
  }).flat();
  write(f, image, frames, false);
  return frames;
}

function directoryFill(target: number) {
  const events: { key: string; revision: number; value: number }[] = [];
  let left = target - 2;
  for (let index = 1000; left >= 186; index++) {
    const key = "r" + index;
    const contribution = directory(["record", key, "0", 1]);
    left -= contribution;
    events.push({ key, revision: 1, value: 0 });
  }
  for (const event of events) {
    if (!left) break;
    const width = Math.min(15, left);
    event.revision = 10 ** width;
    left -= width;
  }
  expect(left).toBe(0);
  return put(...events);
}

for (const dimension of ["transcript", "snapshot", "directory"] as const) {
  const name = { transcript: "B1", snapshot: "B2", directory: "B3" }[dimension];
  test.each([-1, 0, 1])(
    name + " " + dimension + " capacity at cap plus %i",
    async (boundary) => {
      for (const fromCold of [false, true]) {
        const f = guardFixture();
        using _db = f.db;
        const warm = await provision(f);
        if (dimension === "transcript") fillTranscript(f, warm, 500);
        if (dimension === "snapshot") cycles(f, warm);
        if (dimension === "directory")
          write(f, warm, [
            directoryFill(cap.directory - ordinary.directory - 187),
          ]);
        const image = fromCold ? cold(f) : warm;
        const state = projection(f, image);
        const available = room(state)[dimension];
        const candidate =
          dimension === "transcript"
            ? paddedNote(available + boundary - 1, image.head + 1)
            : dimension === "snapshot"
              ? record("x".repeat(available + boundary - bytes("")))
              : record(0, "r9999", 10 ** (boundary + 1));
        assertBoundary(advance(state, candidate), dimension, 0 - boundary);
        if (boundary > 0) refuseFrames(f, image, [candidate]);
        else {
          write(f, image, [candidate]);
          assertUsage(f, image);
          expect(viewImage(f)).toEqual(store.viewV3(image));
        }
      }
    },
    timeout,
  );
}

const viewImage = (f: Fixture) => store.viewV3(cold(f));

test.each([
  ["false", false],
  ["true", true],
] as const)(
  "B4 row admission and checkpoint recovery with a guarded lease %s",
  async (_name, guardedLease) => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    if (guardedLease) useLease(f, image, "claim", "work-1", "claim");
    const admissibleNotes = guardedLease ? 1018 : 1020;
    write(
      f,
      image,
      Array.from({ length: admissibleNotes - 1 }, () => note()),
    );
    expect(room(projection(f, image)).rows).toBe(1);
    const send = () => f.send(probe + "/commits", { frames: [note()] });
    expect((await send()).status).toBe(200);
    expect(rowsOf(f)).toHaveLength(admissibleNotes + Number(guardedLease));
    const full = cold(f);
    assertBoundary(projection(f, full), "rows", 0);
    await refuseRoute(f, send);
    const result = await checkpoint(f);
    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, value: { more: true } },
    });
    expect((await send()).status).toBe(200);
    expect(cold(f).head).toBe(full.head + 1);
    assertUsage(f, cold(f));
  },
  timeout,
);

test.each(["raw", "typed"] as const)(
  "B5 refuses the seventeenth %s lease and can reuse a released subject",
  async (route) => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await provision(f);
    expect((await typed(f, calls.create.call)).status).toBe(200);
    for (let index = 1; index <= 16; index++)
      expect(
        (await sendLease(f, "claim", "work-" + index, "claim-" + index)).status,
      ).toBe(200);
    assertBoundary(projection(f, cold(f)), "leases", 0);
    await refuseRoute(
      f,
      route === "raw"
        ? () => sendLease(f, "claim", "work-17", "claim-17")
        : () => typed(f, calls.claim.call),
    );
    expect(
      (await sendLease(f, "release", "work-16", "release-16")).status,
    ).toBe(200);
    expect(await sendLease(f, "claim", "work-16", "reclaim-16")).toMatchObject({
      status: 200,
      body: { ok: true, value: { subject: "work-16", generation: 2 } },
    });
    const image = cold(f);
    expect([
      image.entries.lease.size,
      image.entries.witness.size,
      image.entries.outcome.size,
    ]).toEqual([16, 17, 19]);
    assertUsage(f, image);
  },
  timeout,
);

const other: LeaseHolder = {
  ...holder,
  session: { ...holder.session, id: "other" },
};
function heldError(lease: LeaseRecord): ForgeError {
  const { subject, holder: current, expiresAt, generation } = lease;
  const { actor, session } = current;
  const description =
    "device " +
    session.device +
    ", agent " +
    (session.agent ?? actor.id) +
    ", harness " +
    (session.harness ?? "unspecified") +
    ", session " +
    session.id;
  return {
    code: "LEASE_HELD",
    message:
      subject +
      " is leased by " +
      description +
      " until " +
      expiresAt +
      "; read its state to reconcile instead of retrying",
    retry: "reconcile_first",
    lease: { subject, holder: current, generation, expiresAt },
  };
}
const leaseConflict = (lease: LeaseRecord, time: number) =>
  leaseFrame(
    "claim",
    lease.subject,
    other,
    "reused-refusal",
    time,
    time + 1,
    1,
    1,
    undefined,
    heldError(lease),
  );

function rawPlan(f: Fixture, image: Image, lease: LeaseRecord, limit: number) {
  let state = projection(f, image);
  const frames: store.Frame[] = [];
  for (let time = now + 2; ; time += 2) {
    const candidate = leaseConflict(lease, time);
    const next = advance(state, candidate);
    if (next.raw > limit) return { frames, state, candidate, next };
    frames.push(candidate);
    state = next;
  }
}

test(
  "B6 a replaced lease refusal binds raw tail first and fits after checkpoint",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const lease = useLease(f, image, "claim", "work-1", "live", largeHolder);
    const plan = rawPlan(
      f,
      image,
      lease,
      cap.raw - reserve(projection(f, image).items.values(), now).raw,
    );
    for (const frame of plan.frames) {
      setSystemTime(frame.time);
      const reply = await sendLease(
        f,
        "claim",
        lease.subject,
        "reused-refusal",
        other,
        1,
        frame.time + 1,
      );
      expect(reply).toEqual(wireError(409, heldError(lease)));
    }
    const tail = cold(f);
    const used = measure(plan.state);
    expect(tail.usage).toEqual(rootedRecount(f, tail));
    expect(tail.usage).toEqual({
      transcript: used.transcript,
      snapshot: used.snapshot,
      directory: used.directory,
    });
    expect(tail.tailBytes).toBe(used.raw);
    expect(tail.entries.outcome.size).toBe(2);
    const left = room(plan.next, plan.candidate.time);
    expect(left.raw).toBeLessThan(0);
    expect(room(plan.state, plan.candidate.time).raw).toBeGreaterThanOrEqual(0);
    for (const dim of dimensions)
      if (dim !== "raw") expect(left[dim], dim).toBeGreaterThan(0);
    setSystemTime(plan.candidate.time);
    const same = () =>
      sendLease(
        f,
        "claim",
        lease.subject,
        "reused-refusal",
        other,
        1,
        plan.candidate.time + 1,
      );
    await refuseRoute(f, same);
    expect((await checkpoint(f)).status).toBe(200);
    expect(await same()).toEqual(wireError(409, heldError(lease)));
    expect(cold(f).head).toBe(tail.head + 1);
    assertUsage(f, cold(f));
  },
  timeout,
);

test(
  "B6 legacy raw tail admits a stored-holder release and refuses ordinary raw growth",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const lease = useLease(f, image, "claim", "work-1", "live", largeHolder);
    const plan = rawPlan(f, image, lease, cap.raw + 10_000);
    legacyWrite(f, image.head, plan.frames);
    f.restart();
    const time = plan.candidate.time;
    setSystemTime(time);
    const prior = cold(f);
    const state = projection(f, prior);
    expect(prior.tailBytes).toBeGreaterThan(cap.raw);
    expect(prior.tailBytes).toBeLessThan(hard.raw);
    const release = leaseFrame(
      "release",
      lease.subject,
      lease.holder,
      "legacy-release",
      time,
      expiry,
      1,
      null,
      lease,
    );
    expect(room(advance(state, release), time).raw).toBeGreaterThanOrEqual(
      room(state, time).raw,
    );
    const effects = f.observeEffects();
    const releaseReply = await sendLease(
      f,
      "release",
      lease.subject,
      "legacy-release",
      lease.holder,
    );
    expect(releaseReply).toMatchObject({
      status: 200,
      body: { value: release.lease },
    });
    expect(effects()).toEqual({
      sqlWriteAttempts: 1,
      sqlAndKvIntact: false,
      alarmWrites: 0,
    });
    const released = cold(f);
    expect(
      rowsOf(f, prior.head).map(({ body }) => JSON.parse(body) as Body),
    ).toEqual([encoded(release, prior.head + 1)]);
    assertUsage(f, released);
    refuseFrames(f, released, [note()]);
  },
  timeout,
);

test(
  "P1 a stopped restored root refuses before ordinary capacity",
  async () => {
    const source = guardFixture();
    const target = guardFixture();
    using _source = source.db;
    using _target = target.db;
    const image = await provision(source);
    write(source, image, [record("portable")]);
    await drain(source);
    const restored = await restore(target, portableOf(source));
    await refuseRoute(
      target,
      () => target.send(probe + "/commits", { frames: [note()] }),
      wireError(409, {
        code: "INPUT_CONFLICT",
        message: "The restored project is stopped",
        retry: "never",
      }),
      4,
    );
    expect(cold(target).root).toEqual(restored.root);
  },
  timeout,
);

test(
  "P2 a stale head wins before ordinary capacity",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const stale = await provision(f);
    const current = cold(f);
    fillTranscript(f, current, 0);
    const before = f.snapshot();
    const effects = f.observeEffects();
    expect(
      caught(() => store.append(dbOf(f), f.seal(), stale, [note()])),
    ).toEqual({
      code: "UNAVAILABLE",
      message: "Cloud v3 root is unavailable",
      retry: "never",
    });
    expect(stale.stale).toBe(true);
    expect(stale.staged).toEqual([]);
    expect(f.snapshot()).toEqual(before);
    expect(effects()).toEqual(noWrites);
    assertUsage(f, current);
  },
  timeout,
);

test(
  "P3 the per-frame size refusal wins before ordinary capacity",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    fillTranscript(f, image, 0);
    refuseFrames(
      f,
      image,
      [paddedNote(cap.transcript + 1, image.head + 1)],
      true,
      {
        code: "STORAGE_LIMIT_EXCEEDED",
        message: "This write is too large to keep in the project's history",
        retry: "never",
      },
    );
  },
  timeout,
);

test(
  "P4 whole-batch validation wins over an earlier over-capacity prefix",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    write(f, image, [record("present")]);
    fillTranscript(f, image, 0);
    refuseFrames(
      f,
      image,
      [note(), record("cannot replace without advancing revision")],
      true,
      {
        code: "INPUT_INVALID",
        message: "Invalid v3 record transition",
        retry: "never",
      },
    );
  },
  timeout,
);

test(
  "P5 records no command refusal at zero room and replays the original responses byte for byte",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await provision(f);
    const send = (call: object) =>
      f.sendText(probe + "/command", call, headers());
    const ok = await send(calls.create.call);
    const invalid = await send(invalidCall);
    expectTypedReply(ok, calls.create.expected);
    expectTypedReply(invalid, { status: 400, error: invalidError, exit: 6 });
    fillTranscript(f, cold(f), 0);
    f.restart();
    await refuseRoute(f, () =>
      typed(f, { ...invalidCall, requestId: "new-invalid" }),
    );
    const effects = f.observeEffects();
    expect(await send(invalidCall)).toEqual(invalid);
    expect(await send(calls.create.call)).toEqual(ok);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "P6 records no wrong-session release refusal at zero room",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    useLease(f, image, "claim", "work-1", "claim");
    fillTranscript(f, image, 0);
    await refuseRoute(f, () =>
      sendLease(f, "release", "work-1", "wrong", other),
    );
    const result = await sendLease(f, "release", "work-1", "right");
    expect(result.status).toBe(200);
    assertUsage(f, cold(f));
  },
  timeout,
);

test(
  "P7 a 1025-row probe batch uses the capacity failure code",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    refuseFrames(
      f,
      image,
      Array.from({ length: 1025 }, () => note()),
    );
  },
  timeout,
);

function claimFrames(count: number, leaseHolder = holder) {
  return Array.from({ length: count }, (_, index) => {
    const subject = "work-" + (index + 1);
    const sessionHolder = {
      ...leaseHolder,
      session: {
        ...leaseHolder.session,
        id: leaseHolder.session.id + Math.floor(index / 4),
      },
    };
    return leaseFrame(
      "claim",
      subject,
      sessionHolder,
      "claim-" + subject,
      now,
      expiry,
      1,
      hour,
    );
  });
}

async function leaseSource(f: Fixture) {
  const image = await provision(f);
  const claims = claimFrames(16);
  write(f, image, claims, false);
  const state = projection(f, image);
  const available = room(state).transcript;
  const minimal = bytes(encoded(record(""), image.head + 1)) + 1;
  const padding = available - minimal;
  const time = padding % 2 === 0 ? now : Math.floor(now / 10);
  const filler = { ...record("x".repeat(Math.ceil(padding / 2))), time };
  assertBoundary(advance(state, filler), "transcript", 0, time);
  write(f, image, [filler]);
  return { image, leases: claims.map(({ lease }) => lease!) };
}

const extraNote = (image: Image) => paddedNote(4096, image.head + 1);

test(
  "R1 releases sixteen leases across four sessions at zero ordinary room and restores",
  async () => {
    const source = guardFixture();
    const target = guardFixture();
    using _source = source.db;
    using _target = target.db;
    const { image, leases } = await leaseSource(source);
    const fullNote = () =>
      source.send(probe + "/commits", { frames: [extraNote(cold(source))] });
    const observeNote = async () => {
      const effects = source.observeEffects();
      const reply = await fullNote();
      return { reply, writes: effects() };
    };
    const original = await observeNote();
    const released = [];
    const attempts = [];
    for (const lease of leases) {
      const reply = await sendLease(
        source,
        "release",
        lease.subject,
        "release-" + lease.subject,
        lease.holder,
      );
      released.push(reply);
      if (released.length % 4 === 0) attempts.push(await observeNote());
    }
    expect(original.reply).toEqual(capacityReply);
    expect(original.writes).toEqual(noWrites);
    for (const [index, reply] of released.entries())
      expect(reply).toMatchObject({
        status: 200,
        body: {
          value: {
            subject: leases[index]!.subject,
            releasedAt: new Date(now).toISOString(),
          },
        },
      });
    expect(attempts).toEqual(
      Array.from({ length: 4 }, () => ({
        reply: capacityReply,
        writes: noWrites,
      })),
    );
    expect(rowsOf(source)).toHaveLength(image.head + 16);
    assertUsage(source, cold(source));
    await refuseRoute(source, fullNote);
    const covered = await drain(source);
    const restored = await restore(target, portableOf(source));
    expect(restored.entries.lease.size).toBe(16);
    expect(restored.head).toBe(covered.head + 1);
  },
  timeout,
);

const longer: LeaseHolder = {
  ...holder,
  session: {
    ...holder.session,
    agent: "agent".repeat(30),
    harness: "harness".repeat(25),
  },
};
test.each([-1, 0])(
  "R2 renewal transcript room equals its full cost plus %i",
  async (delta) => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const prior = useLease(f, image, "claim", "work-1", "claim");
    const renew = leaseFrame(
      "renew",
      prior.subject,
      longer,
      "renew",
      now,
      expiry,
      1,
      hour,
      prior,
    );
    const afterFiller = advance(projection(f, image), note());
    const cost = add(
      room(afterFiller),
      negate(room(advance(afterFiller, renew))),
    );
    for (const dim of dimensions)
      expect(Number.isSafeInteger(cost[dim]), dim).toBe(true);
    expect(cost.transcript).toBeGreaterThan(
      releaseBudget(renew.lease!).transcript - releaseBudget(prior).transcript,
    );
    fillTranscript(f, image, cost.transcript + delta);
    const state = projection(f, image);
    assertBoundary(advance(state, renew), "transcript", delta);
    if (delta < 0)
      await refuseRoute(f, () =>
        sendLease(f, "renew", prior.subject, "renew", longer),
      );
    else {
      expect(
        await sendLease(f, "renew", prior.subject, "renew", longer),
      ).toMatchObject({
        status: 200,
        body: { ok: true, value: renew.lease },
      });
      const renewed = cold(f);
      expect(
        rowsOf(f, image.head).map(({ body }) => JSON.parse(body) as Body),
      ).toEqual([encoded(renew, image.head + 1)]);
      assertBoundary(projection(f, renewed), "transcript", 0);
      expect(
        (await sendLease(f, "release", prior.subject, "release", longer))
          .status,
      ).toBe(200);
      assertUsage(f, cold(f));
    }
  },
  timeout,
);

test.each(["longer", "shorter", "full cost"] as const)(
  "R3 release with a different holder at %s",
  async (kind) => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const original = kind === "shorter" ? longer : holder;
    const different = kind === "shorter" ? holder : longer;
    const prior = useLease(f, image, "claim", "work-1", "claim", original);
    const release = leaseFrame(
      "release",
      prior.subject,
      different,
      "release",
      now,
      expiry,
      1,
      null,
      prior,
    );
    const cost = releaseCost(prior, release, image.head + 2);
    fillTranscript(f, image, kind === "full cost" ? cost.transcript : 0);
    const state = projection(f, image);
    const kept = add(
      room(advance(state, release)),
      negate(releaseBudget(prior)),
    );
    expect(kept.transcript).toBe(kind === "full cost" ? 0 : -cost.transcript);
    const call = () =>
      sendLease(f, "release", prior.subject, "release", different);
    if (kind === "full cost") {
      for (const dim of dimensions)
        expect(kept[dim], dim).toBeGreaterThanOrEqual(0);
      expect(await call()).toMatchObject({
        status: 200,
        body: { value: release.lease },
      });
      assertUsage(f, cold(f));
    } else await refuseRoute(f, call);
  },
  timeout,
);

test(
  "R4 expiration frees reserve and an expired release still spends room to record",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const prior = useLease(
      f,
      image,
      "claim",
      "work-1",
      "claim",
      largeHolder,
      1000,
    );
    fillTranscript(f, image, 0);
    const before = stateOf(f, image);
    const effects = f.observeEffects();
    const blocked = caught(() =>
      store.append(dbOf(f), f.seal(), image, [note()]),
    );
    const blockedEffects = effects();
    const unchanged = stateOf(f, image);
    if (blocked === undefined) store.publishV3(image);
    setSystemTime(now + 1001);
    write(f, image, [note()]);
    const expired = await sendLease(
      f,
      "release",
      prior.subject,
      "expired",
      largeHolder,
    );
    expect(blocked).toEqual(historyFull);
    expect(blockedEffects).toEqual(noWrites);
    expect(unchanged).toEqual(before);
    expect(expired).toMatchObject({
      status: 409,
      body: {
        ok: false,
        error: { code: "LEASE_EXPIRED", retry: "reconcile_first" },
      },
    });
    const current = cold(f);
    expect(current.head).toBe(image.head + 1);
    assertUsage(f, current);
    fillTranscript(f, current, 0);
    await refuseRoute(f, () =>
      sendLease(f, "release", prior.subject, "expired-new", largeHolder),
    );
  },
  timeout,
);

test(
  "R5 claim refuses when the frame fits and its new release reserve does not",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const candidate = leaseFrame(
      "claim",
      "work-1",
      largeHolder,
      "new",
      now,
      expiry,
      1,
      hour,
    );
    const price = bytes(encoded(candidate, 2)) + 1;
    fillTranscript(f, image, price);
    const state = projection(f, image);
    expect(room(advance(state, candidate)).transcript).toBe(
      -releaseBudget(candidate.lease!).transcript,
    );
    await refuseRoute(f, () =>
      sendLease(f, "claim", "work-1", "new", largeHolder),
    );
    expect(cold(f).entries.lease.size).toBe(0);
    expect(cold(f).entries.witness.size).toBe(0);
    expect(cold(f).entries.outcome.size).toBe(0);
  },
  timeout,
);

test.each([
  ["false", false],
  ["true", true],
] as const)(
  "R6 atomic revoke-shaped batch with a changed final holder %s",
  async (_name, different) => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const initial = claimFrames(3);
    write(f, image, initial, false);
    fillTranscript(f, image, 0);
    const releases = initial
      .slice(0, different ? 3 : 2)
      .map(({ lease }, index) => {
        const actual = lease!;
        const changed =
          different && index === 2
            ? {
                ...actual.holder,
                session: { ...actual.holder.session, harness: "x".repeat(200) },
              }
            : actual.holder;
        return leaseFrame(
          "release",
          actual.subject,
          changed,
          "revoke/token/" + actual.subject,
          now,
          Date.parse(actual.expiresAt),
          actual.generation,
          null,
          actual,
        );
      });
    let prefix = projection(f, image);
    for (const frame of releases.slice(0, 2)) {
      prefix = advance(prefix, frame);
      for (const dim of dimensions)
        expect(room(prefix)[dim], dim).toBeGreaterThanOrEqual(0);
    }
    if (different) {
      const post = room(advance(prefix, releases[2]!));
      expect(
        post.transcript - releaseBudget(initial[2]!.lease!).transcript,
      ).toBeLessThan(0);
      refuseFrames(f, image, releases, false);
    } else {
      write(f, image, releases, false);
      assertUsage(f, image);
      const recoveredImage = cold(f);
      expect(store.viewV3(recoveredImage)).toEqual(store.viewV3(image));
      for (const { lease } of releases)
        expect(
          store.readV3Value(dbOf(f), recoveredImage, "lease", lease!.subject),
        ).toEqual(lease);
    }
  },
  timeout,
);

function legacyTranscript(f: Fixture, image: Image, target: number) {
  const size =
    target - rootedRecount(f, image).transcript - Number(image.head !== 0);
  legacyWrite(f, image.head, [paddedNote(size, image.head + 1)]);
  f.restart();
  const recoveredImage = cold(f);
  expect(rootedRecount(f, recoveredImage).transcript).toBe(target);
  return recoveredImage;
}

test(
  "I1 ineligible history refuses growth and allows a fitting release and read-only replay",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await provision(f);
    const send = () =>
      f.sendText(probe + "/command", calls.create.call, headers());
    const first = await send();
    expectTypedReply(first, calls.create.expected);
    const image = cold(f);
    const lease = useLease(f, image, "claim", "work-1", "lease");
    const ineligible = legacyTranscript(f, image, cap.transcript - 5000);
    expect(room(projection(f, ineligible)).transcript).toBeLessThan(0);
    await refuseRoute(f, () =>
      typed(f, { ...calls.createWithFields.call, requestId: "growth" }),
    );
    expect(
      await sendLease(f, "release", lease.subject, "release"),
    ).toMatchObject({
      status: 200,
      body: { value: { releasedAt: new Date(now).toISOString() } },
    });
    const effects = f.observeEffects();
    expect((await f.send(probe)).status).toBe(200);
    expect(await send()).toEqual(first);
    expect(effects()).toEqual(noWrites);
    assertUsage(f, cold(f));
  },
  timeout,
);

test(
  "I2 a legacy seventeenth lease may release but no eighteenth subject may be added",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    await provision(f);
    const initial = claimFrames(17);
    legacyWrite(f, 0, initial);
    f.restart();
    const prior = initial[0]!.lease!;
    expect(
      (
        await sendLease(
          f,
          "release",
          prior.subject,
          "legacy-release",
          prior.holder,
        )
      ).status,
    ).toBe(200);
    await refuseRoute(f, () => sendLease(f, "claim", "work-18", "new-18"));
    const image = cold(f);
    expect(image.entries.lease.size).toBe(17);
    assertUsage(f, image);
  },
  timeout,
);

test(
  "I3 a same-holder release cannot cross the hard transcript bound",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const lease = useLease(f, image, "claim", "work-1", "lease");
    const release = leaseFrame(
      "release",
      lease.subject,
      lease.holder,
      "hard",
      now,
      expiry,
      1,
      null,
      lease,
    );
    const cost = releaseCost(lease, release, image.head + 2).transcript;
    const legacy = legacyTranscript(f, image, cap.transcript - cost + 1);
    expect(measure(advance(projection(f, legacy), release)).transcript).toBe(
      cap.transcript + 1,
    );
    await refuseRoute(f, () => sendLease(f, "release", lease.subject, "hard"));
  },
  timeout,
);

function portableArtifact(frames: readonly store.Frame[]) {
  const items = new Map<string, Item>();
  const members = frames.map((frame, index) => {
    applyFrame(items, frame);
    return frame.operation === "fixture.note"
      ? { sequence: index + 1 }
      : archived(encoded(frame, index + 1));
  });
  const sorted = [...items.values()].sort(([a, k], [b, l]) =>
    a === b ? (k < l ? -1 : 1) : a < b ? -1 : 1,
  );
  let offset = 0;
  const snapshot: string[] = [];
  const directoryPage = sorted.map(([collection, key, body, revision]) => {
    const identity = {
      collection,
      key,
      ...(revision === undefined ? {} : { revision }),
    };
    if (body === null) return { ...identity, deleted: true };
    const length = Buffer.byteLength(body);
    const entry = {
      ...identity,
      page: "snapshot:0",
      offset,
      length,
      digest: digestBytes(body),
    };
    offset += length;
    snapshot.push(body);
    return entry;
  });
  const head = frames.length;
  const backup: Portable = {
    pages: [
      { id: "directory:0", body: canonicalJson(directoryPage) },
      { id: "snapshot:0", body: snapshot.join("") },
      { id: "transcript:0", body: canonicalJson(members) },
    ],
    head,
    eventWatermark: frames.reduce((sum, frame) => sum + frame.events.length, 0),
    recordFloor: Math.max(
      0,
      ...sorted
        .filter(([collection]) => collection === "record")
        .map(([, key]) => Number(key.slice(1))),
    ),
    publicDigest: digestProjection(sorted),
    source: "capacity-fixture",
  };
  return { backup, items, sorted, members, usage: recount(sorted, members) };
}

type Artifact = ReturnType<typeof portableArtifact>;
function activateComponent(f: Fixture, artifact: Artifact) {
  const { backup, sorted } = artifact;
  const { pages, ...metadata } = backup;
  const stored = new Map(pages.map(({ id, body }) => [id, body]));
  const manifest = trustedManifest(f.seal(), {
    ...metadata,
    format: "forge-cloud-portable/4",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  });
  const verified = authenticateManifest(
    f.seal(),
    manifest,
    digestValue(manifest),
  )!;
  const db = dbOf(f);
  const imported = store.recoverV3(db, f.seal(), {
    admit: Project.admitLeaseRequest,
    manifest: verified,
    portableTranscript: stored.get("transcript:0")!,
  });
  expect(imported.usage).toEqual(artifact.usage);
  store.activateV3(
    db,
    f.seal(),
    imported,
    roster(stored, sorted, backup.head),
    stored,
    backup.publicDigest,
  );
  const image = cold(f);
  const body = rowsOf(f)[0]!.body;
  assertUsage(f, image);
  return { body, image };
}

type ActivationFrame = { control: unknown; time: number };
function activatedUsage(artifact: Artifact, body: string) {
  const { control, time } = JSON.parse(body) as ActivationFrame;
  const items: Item[] = artifact.sorted
    .filter(([collection]) => collection !== "control")
    .map((item) => {
      const [collection, key, value, revision] = item;
      if (collection !== "lease") return item;
      const lease = JSON.parse(value!) as LeaseRecord;
      return lease.releasedAt === undefined
        ? [
            collection,
            key,
            canonicalJson({
              ...lease,
              releasedAt: new Date(time).toISOString(),
            }),
            revision,
          ]
        : item;
    });
  items.push(["control", "global", canonicalJson(control), undefined]);
  return recount(items, [...artifact.members, JSON.parse(body)]);
}

const pageKinds = ["transcript", "snapshot", "directory"] as const;
const activationError: ForgeError = {
  code: "STORAGE_LIMIT_EXCEEDED",
  message: "The restored history is too large to activate",
  retry: "never",
};
const invalidRestore = wireError(400, {
  code: "RESTORE_INVALID_ROW",
  message: "Cloud v3 portable restore could not be verified",
  retry: "never",
});
const tableNames = ({ db }: Fixture) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
    )
    .all()
    .map(({ name }) => name);

for (const kind of pageKinds) {
  test.each([-1, 0, 1])(
    "X1 " + kind + " activation at cap plus %i",
    async (delta) => {
      const seed = guardFixture();
      const component = guardFixture();
      const target = guardFixture();
      using _seed = seed.db;
      using _component = component.db;
      using _target = target.db;
      const ids = [
        "cf314cbb-07ca-46e8-b45b-fbec8a88e083",
        "1be06559-e694-4a85-b13e-8ab79702d19a",
      ] as const;
      let id = 0;
      const random = spyOn(crypto, "randomUUID").mockImplementation(
        () => ids[id++ % ids.length]!,
      );
      try {
        const seedActivation = activateComponent(
          seed,
          portableArtifact([]),
        ).body;
        const wanted = cap[kind] + delta;
        let artifact: Artifact;
        if (kind === "transcript") {
          const base = Buffer.byteLength(seedActivation) + 1;
          const minimal = portableArtifact([record("")]).usage.transcript;
          const misaligned = (wanted - base - minimal) % 2 !== 0;
          const padding =
            wanted -
            base -
            portableArtifact(misaligned ? [record(""), note()] : [record("")])
              .usage.transcript;
          const fill = record("x".repeat(padding / 2));
          artifact = portableArtifact(misaligned ? [fill, note()] : [fill]);
        } else if (kind === "snapshot") {
          const claims = claimFrames(16, largeHolder);
          const base = portableArtifact([...claims, record("")]);
          const padding =
            wanted - activatedUsage(base, seedActivation).snapshot;
          artifact = portableArtifact([...claims, record("x".repeat(padding))]);
        } else {
          const control = directory(["control", "global", "{}", undefined]);
          artifact = portableArtifact([directoryFill(wanted - control)]);
        }
        for (const { body } of artifact.backup.pages)
          expect(Buffer.byteLength(body)).toBeLessThanOrEqual(cap.transcript);
        const candidate = activateComponent(component, artifact);
        const expected = activatedUsage(artifact, candidate.body);
        expect(candidate.image.usage).toEqual(expected);
        expect(expected[kind]).toBe(wanted);
        for (const other of pageKinds)
          if (other !== kind)
            expect(expected[other], other).toBeLessThanOrEqual(cap[other]);

        const tables = tableNames(target);
        const upload = portableUpload(target, artifact.backup);
        for (const page of [0, 1])
          expect(await upload(page)).toEqual({
            status: 200,
            body: { ok: true, value: { page, verified: false } },
          });
        const { kv } = target.snapshot();
        const effects = target.observeEffects();
        const last = await upload(2);
        if (delta > 0) {
          expect(last).toEqual(wireError(503, activationError));
          expect(exited(last.body)).toBe(1);
          expect(tableNames(target)).not.toContain("cloud_v3_restore");
          expect(effects()).toMatchObject({
            alarmWrites: 0,
            sqlAndKvIntact: false,
          });
          expect(effects().sqlWriteAttempts).toBeGreaterThan(0);
          expect(tableNames(target)).toEqual(tables);
          expect(target.snapshot().kv).toEqual(kv);
          expect(store.hasV3Root(dbOf(target))).toBe(false);
          expect(
            target.db
              .query(
                "SELECT name FROM sqlite_schema WHERE name IN ('cloud_v3_pages', 'cloud_v3_commits')",
              )
              .all(),
          ).toEqual([]);
          target.restart();
          const retryEffects = target.observeEffects();
          const retry = await upload(2);
          expect(retry).toEqual(invalidRestore);
          expect(exited(retry.body)).toBe(1);
          expect(retryEffects()).toEqual(noWrites);
          expect(tableNames(target)).not.toContain("cloud_v3_restore");
          expect(target.snapshot().kv).toEqual(kv);
        } else {
          expect(last).toEqual({
            status: 200,
            body: { ok: true, value: { page: 2, verified: true } },
          });
          target.restart();
          expect(rowsOf(target)[0]!.body).toBe(candidate.body);
          const image = cold(target);
          expect(image.root).toEqual(candidate.image.root);
          expect(image.usage).toEqual(expected);
          assertUsage(target, image);
        }
      } finally {
        random.mockRestore();
      }
    },
    timeout,
  );
}

test(
  "X1 more than sixteen imported leases keeps the existing restore refusal",
  async () => {
    const target = guardFixture();
    using _target = target.db;
    const tables = tableNames(target);
    const { kv } = target.snapshot();
    const { backup } = portableArtifact(claimFrames(17));
    const upload = portableUpload(target, backup);
    expect((await upload(0)).status).toBe(200);
    expect((await upload(1)).status).toBe(200);
    const reply = await upload(2);
    expect(reply).toEqual(
      wireError(413, {
        code: "RESTORE_TOO_LARGE",
        message: "Too many imported leases for activation",
        retry: "never",
      }),
    );
    expect(exited(reply.body)).toBe(1);
    expect(tableNames(target)).not.toContain("cloud_v3_restore");
    expect(store.hasV3Root(dbOf(target))).toBe(false);
    expect(tableNames(target)).toEqual(tables);
    expect(target.snapshot().kv).toEqual(kv);
  },
  timeout,
);

function transcriptBoundary(activation: string, delta: number) {
  const wanted = cap.transcript + delta;
  const activationCost = Buffer.byteLength(activation) + 1;
  const minimum = portableArtifact([record("")]).usage.transcript;
  const needsNote = (wanted - activationCost - minimum) % 2 !== 0;
  const tail = needsNote ? [note()] : [];
  const overhead = portableArtifact([record(""), ...tail]).usage.transcript;
  const padding = (wanted - activationCost - overhead) / 2;
  return portableArtifact([record("x".repeat(padding)), ...tail]);
}

test.each(["different", "same"] as const)(
  "v3 restore retries the %s artifact after an over-capacity refusal",
  async (retry) => {
    const seed = guardFixture();
    const target = guardFixture();
    using _seed = seed.db;
    using _target = target.db;
    const ids = [
      "cf314cbb-07ca-46e8-b45b-fbec8a88e083",
      "1be06559-e694-4a85-b13e-8ab79702d19a",
    ] as const;
    let id = 0;
    const random = spyOn(crypto, "randomUUID").mockImplementation(
      () => ids[id++ % ids.length]!,
    );
    try {
      const activation = activateComponent(seed, portableArtifact([])).body;
      const excess = transcriptBoundary(activation, 1);
      expect(activatedUsage(excess, activation).transcript).toBe(
        cap.transcript + 1,
      );
      const upload = portableUpload(target, excess.backup);
      const staged = (page: number) => ({
        status: 200,
        body: { ok: true, value: { page, verified: false } },
      });
      expect(await upload(0)).toEqual(staged(0));
      expect(await upload(1)).toEqual(staged(1));
      id = 0;
      const refusal = await upload(2);
      expect(refusal).toEqual(wireError(503, activationError));
      expect(exited(refusal.body)).toBe(1);

      if (retry === "same") {
        const effects = target.observeEffects();
        const finalOnly = await upload(2);
        expect(finalOnly).toEqual(invalidRestore);
        expect(exited(finalOnly.body)).toBe(1);
        expect(effects()).toEqual(noWrites);
        expect(store.hasV3Root(dbOf(target))).toBe(false);
        expect(await upload(0)).toEqual(staged(0));
        expect(await upload(1)).toEqual(staged(1));
        id = 0;
        expect(await upload(2)).toEqual(refusal);
        expect(tableNames(target)).not.toContain("cloud_v3_restore");
        expect(store.hasV3Root(dbOf(target))).toBe(false);
      } else {
        const component = guardFixture();
        using _component = component.db;
        const exact = transcriptBoundary(activation, 0);
        id = 0;
        const candidate = activateComponent(component, exact).image;
        expect(candidate.usage.transcript).toBe(cap.transcript);
        const replace = portableUpload(target, exact.backup);
        expect(await replace(0)).toEqual(staged(0));
        expect(await replace(1)).toEqual(staged(1));
        id = 0;
        expect(await replace(2)).toEqual({
          status: 200,
          body: { ok: true, value: { page: 2, verified: true } },
        });
        const { load: _load, ...image } = cold(target);
        const { load: _candidateLoad, ...expected } = candidate;
        expect(image).toEqual(expected);
      }
    } finally {
      random.mockRestore();
    }
  },
  timeout,
);

test(
  "X2 a capacity-filled eligible source can restore with room for promotion and resume",
  async () => {
    const source = guardFixture();
    const target = guardFixture();
    using _source = source.db;
    using _target = target.db;
    const { image, leases } = await leaseSource(source);
    assertBoundary(projection(source, image), "transcript", 0);
    refuseFrames(source, image, [note()]);
    const covered = await drain(source);
    expect(
      guarded(projection(source, covered).items.values(), now)
        .map(({ subject }) => subject)
        .sort(),
    ).toEqual(leases.map(({ subject }) => subject).sort());
    const restored = await restore(target, portableOf(source));
    for (const kind of pageKinds)
      expect(restored.usage[kind] + remaining[kind], kind).toBeLessThanOrEqual(
        cap[kind],
      );
    for (const { subject } of leases)
      expect(
        store.readV3Value(dbOf(target), restored, "lease", subject)?.releasedAt,
      ).toBe(new Date(now).toISOString());
    expect(restored.head).toBe(covered.head + 1);
  },
  timeout,
);

for (const pageBacked of [false, true]) {
  const mode = pageBacked ? "page-backed" : "in-memory";
  test.each([0, 1])(
    "Overlay " + mode + " record replacement with second-prefix excess %i",
    async (delta) => {
      const f = guardFixture();
      using _db = f.db;
      let image = await provision(f);
      cycles(f, image);
      write(f, image, [
        record("old"),
        record("deleted", "r2"),
        remove("r2", 2),
      ]);
      if (pageBacked) image = await drain(f);
      expect(image.entries.record.get("r1")).toMatchObject(
        pageBacked
          ? { page: "snapshot:0", revision: 1 }
          : { value: "old", revision: 1 },
      );
      expect(image.entries.record.get("r2")).toEqual({
        revision: 2,
        deleted: true,
      });
      expect(image.entries.record.get("r3")).toBeUndefined();
      const state = projection(f, image);
      const target = cap.snapshot - ordinary.snapshot;
      const first = record("x".repeat(500), "r1", 2);
      const withoutPad = advance(
        advance(state, first),
        put(
          { key: "r1", revision: 3, value: "" },
          { key: "r3", revision: 1, value: true },
        ),
      );
      const second = put(
        {
          key: "r1",
          revision: 3,
          value: "y".repeat(target - measure(withoutPad).snapshot + delta),
        },
        { key: "r3", revision: 1, value: true },
      );
      const prefix = advance(state, first);
      const end = advance(prefix, second);
      expect(room(prefix).snapshot).toBeGreaterThan(0);
      for (const dim of dimensions)
        expect(room(prefix)[dim], dim).toBeGreaterThanOrEqual(0);
      assertBoundary(end, "snapshot", 0 - delta);
      if (delta) refuseFrames(f, image, [first, second]);
      else {
        write(f, image, [first, second]);
        expect(image.usage).toMatchObject({ snapshot: target });
        assertUsage(f, image);
        expect(viewImage(f)).toEqual(store.viewV3(image));
        expect(cold(f).entries.record.get("r2")).toEqual({
          revision: 2,
          deleted: true,
        });
      }
    },
    timeout,
  );
}

test(
  "Overlay a renew and a release use the successive values of the same lease slot",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    let image = await provision(f);
    const lease = useLease(f, image, "claim", "work-1", "claim");
    image = await drain(f);
    const renew = leaseFrame(
      "renew",
      lease.subject,
      longer,
      "renew",
      now,
      expiry,
      1,
      hour,
      lease,
    );
    const release = leaseFrame(
      "release",
      lease.subject,
      longer,
      "release",
      now,
      expiry,
      1,
      null,
      renew.lease,
    );
    const afterFiller = advance(projection(f, image), note());
    const used = add(
      room(afterFiller),
      negate(room(advance(afterFiller, renew))),
    );
    fillTranscript(
      f,
      image,
      used.transcript + releaseBudget(lease).transcript + 20,
    );
    let prefix = projection(f, image);
    for (const frame of [renew, release]) {
      prefix = advance(prefix, frame);
      for (const dim of dimensions)
        expect(room(prefix)[dim], dim).toBeGreaterThanOrEqual(0);
    }
    write(f, image, [renew, release], false);
    assertUsage(f, image);
    expect(viewImage(f)).toEqual(store.viewV3(image));
  },
  timeout,
);

test(
  "Clock reuse of expired reserve can later hit the hard bound after rollback",
  async () => {
    const f = guardFixture();
    using _db = f.db;
    const image = await provision(f);
    const claims = claimFrames(9, largeHolder);
    write(f, image, claims, false);
    const spent = now + hour + 1;
    setSystemTime(spent);
    fillTranscript(f, image, 0, spent);
    const beforeRollback = projection(f, image);
    expect(guarded(beforeRollback.items.values(), spent)).toEqual([]);
    expect(room(beforeRollback, spent).transcript).toBe(0);
    expect(guarded(beforeRollback.items.values(), now)).toHaveLength(9);
    expect(room(beforeRollback, now).transcript).toBeLessThan(0);
    setSystemTime(now);
    let state = beforeRollback;
    let blocked: store.Frame | undefined;
    for (const { lease } of claims) {
      const actual = lease!;
      const release = leaseFrame(
        "release",
        actual.subject,
        actual.holder,
        "rollback-" + actual.subject,
        now,
        expiry,
        1,
        null,
        actual,
      );
      const candidate = advance(state, release);
      if (measure(candidate).transcript > cap.transcript) {
        blocked = release;
        break;
      }
      expect(room(candidate, now).transcript).toBeGreaterThanOrEqual(
        room(state, now).transcript,
      );
      write(f, image, [release], false);
      state = candidate;
    }
    expect(image.head).toBeGreaterThan(beforeRollback.head);
    expect(blocked).toBeDefined();
    expect(
      room(advance(state, blocked!), now).transcript,
    ).toBeGreaterThanOrEqual(room(state, now).transcript);
    refuseFrames(f, image, [blocked!], false);
  },
  timeout,
);

test(
  "C1 probe read, view and byte-for-byte typed replay stay read-only at zero room",
  async () => {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await provision(f);
    const send = () =>
      f.sendText(probe + "/command", calls.create.call, headers());
    const first = await send();
    expectTypedReply(first, calls.create.expected);
    const image = cold(f);
    fillTranscript(f, image, 0);
    const before = store.viewV3(image);
    const effects = f.observeEffects();
    for (const restart of [false, true]) {
      if (restart) f.restart();
      expect(await f.send(probe)).toEqual({
        status: 200,
        body: { ok: true, value: before },
      });
      expect(await send()).toEqual(first);
      expect(effects()).toEqual(noWrites);
    }
  },
  timeout,
);
