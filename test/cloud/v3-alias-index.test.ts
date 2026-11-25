import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { prepareReceipt } from "../../cloud/src/command-write.ts";
import { failed } from "../../cloud/src/issue-commands.ts";
import { receiptScope } from "../../cloud/src/issue-request-id.ts";
import { Project } from "../../cloud/src/project.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  checkpointV3,
  digestProjection,
  inventory,
} from "../../cloud/src/v3-checkpoint.ts";
import { commandV3 } from "../../cloud/src/v3-commands.ts";
import {
  claimDecision,
  type UpdateBasis,
  updateDecision,
} from "../../cloud/src/v3-refusals.ts";
import {
  append,
  claimEffect,
  type Frame,
  foldTranscript,
  publishV3,
  type V3Image,
  viewV3,
} from "../../cloud/src/v3-store.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import type { ForgeError, LeaseHolder } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import {
  copyTables,
  expectTypedReply,
  fixture,
  guardFixture,
  newKey,
  noWrites,
  type Portable,
  portableOf,
  portableUpload,
  probe,
  recovered,
  sqlMutation,
  trustedSeal,
} from "./v3-project.fixture.ts";
import {
  assertUsage,
  jsonBytes,
  pages,
  remember,
  rootedRecount,
  tail,
} from "./v3-usage.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const now = Date.parse("2026-11-20T12:00:00.000Z");
const expiry = now + 7_200_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const device = "laptop";
const principal = ["owner", device, device] as const;
const holder: LeaseHolder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture", device },
};
const context = { actor: holder.actor, session: { id: holder.session.id } };
const headers = {
  "X-Forge-Owner": device,
  "X-Forge-Owner-Expires": String(expiry),
};
const unknownPrefix = "Unknown issue id prefix";
const prefixError: ForgeError = {
  code: "INPUT_INVALID",
  message: unknownPrefix,
  retry: "never",
};
const noLease = (number: number): ForgeError => ({
  code: "LEASE_NOT_HELD",
  message: "issue:work-" + number + " has no lease",
  retry: "reconcile_first",
  lease: { subject: "issue:work-" + number },
});
const missing: ForgeError = {
  code: "NOT_FOUND",
  message: "Issue was not found",
  retry: "never",
};
const historyFull: ForgeError = {
  code: "STORAGE_LIMIT_EXCEEDED",
  message:
    "This project's history is full. Ordinary writes are refused to keep room to release leases, stop lanes and restore.",
  retry: "never",
};
const readSql =
  "SELECT substr(CAST(body AS BLOB), ?, ?) AS value FROM cloud_v3_pages";

type Fixture = ReturnType<typeof guardFixture>;
type RecordEvent = { key: string; revision: number; value: unknown };

beforeEach(() => setSystemTime(now));
afterEach(() => setSystemTime());

function observedFixture() {
  let reads = 0;
  let measuring = false;
  let sqlWriteAttempts = 0;
  const f = fixture((sql) => {
    if (measuring && sql.startsWith(readSql)) reads++;
    if (sqlMutation.test(sql)) sqlWriteAttempts++;
  }, env);
  return {
    ...f,
    startReads() {
      measuring = true;
      reads = 0;
    },
    stopReads() {
      measuring = false;
      return reads;
    },
    observeEffects() {
      const before = f.snapshot();
      const priorAlarms = f.alarms.length;
      sqlWriteAttempts = 0;
      return () => ({
        sqlWriteAttempts,
        alarmWrites: f.alarms.length - priorAlarms,
        sqlAndKvIntact:
          Buffer.from(before.sql).equals(f.snapshot().sql) &&
          JSON.stringify(before.kv) === JSON.stringify([...f.values]),
      });
    },
  };
}

const dbOf = (f: Fixture) => writableStore(f.storage);
const cold = (f: Fixture) => recovered(dbOf(f), f.seal());
const aliasesOf = (image: V3Image): unknown => Reflect.get(image, "aliases");
const aliasByKeyOf = (image: V3Image): unknown =>
  Reflect.get(image, "aliasByKey");
const basis = (id: string): UpdateBasis => ({
  stage: "state",
  id,
  prefix: "forge",
  holder,
  generation: 1,
  expectRevision: 1,
});
const decide = (image: V3Image, id: string) =>
  updateDecision(image, basis(id), now);
const claim = (image: V3Image, id: string) =>
  claimDecision(
    image,
    { stage: "state", id, prefix: "forge", holder, ttlMs: 60_000 },
    now,
    expiry,
    false,
    claimEffect,
  );
const refused = (refusal: ForgeError) => ({ refusal, recorded: true });

function oracle(image: V3Image, alias: string) {
  return [...image.entries.record.keys()].some((key) => {
    const value = image.load("record", key);
    return (
      isObject(value) &&
      value.id === "work-" + key.slice(1) &&
      (value.prefix ?? "work") === alias
    );
  });
}

function probeAliases(image: V3Image) {
  const aliases = new Set(["forge", "work", "zz", "constructor", "old", "1"]);
  for (const key of image.entries.record.keys()) {
    const value = image.load("record", key);
    if (isObject(value) && typeof value.prefix === "string")
      aliases.add(value.prefix);
  }
  return aliases;
}

const allows = (image: V3Image, alias: string) =>
  alias.toLowerCase() === "forge" || oracle(image, alias.toLowerCase());

function checkDecisions(image: V3Image, expected = image) {
  for (const alias of probeAliases(expected)) {
    const accepted = allows(expected, alias);
    expect(decide(image, alias + "-999"), alias).toEqual(
      refused(accepted ? missing : prefixError),
    );
    expect(claim(image, alias + "-999"), alias).toEqual(
      refused(
        accepted
          ? { ...missing, message: "Issue forge-999 was not found" }
          : prefixError,
      ),
    );
  }
}

function independentIndexes(image: V3Image) {
  const counts = new Map<string, number>();
  const byKey = new Map<string, string>();
  for (const key of image.entries.record.keys()) {
    const value = image.load("record", key);
    if (!isObject(value) || value.id !== "work-" + key.slice(1)) continue;
    const alias = value.prefix ?? "work";
    if (typeof alias !== "string") continue;
    counts.set(alias, (counts.get(alias) ?? 0) + 1);
    byKey.set(key, alias);
  }
  return { counts, byKey };
}

const ordered = <K, V>(map: ReadonlyMap<K, V>) =>
  [...map.entries()].sort(([left], [right]) =>
    String(left).localeCompare(String(right)),
  );

function indexMaps(image: V3Image) {
  const counts = aliasesOf(image);
  const byKey = aliasByKeyOf(image);
  expect(counts).toBeInstanceOf(Map);
  expect(byKey).toBeInstanceOf(Map);
  if (!(counts instanceof Map) || !(byKey instanceof Map))
    throw new Error("Missing v3 alias indexes");
  return { counts, byKey };
}

function expectIndexes(image: V3Image, expected = image) {
  expect(decide(image, "zz-999")).toEqual(refused(prefixError));
  checkDecisions(image, expected);
  const independent = independentIndexes(expected);
  const { counts, byKey } = indexMaps(image);
  expect(ordered(counts)).toEqual(ordered(independent.counts));
  expect(ordered(byKey)).toEqual(ordered(independent.byKey));
  expect([...counts.keys()].every((key) => typeof key === "string")).toBe(true);
  expect(
    [...counts.values()].every(
      (count) => Number.isInteger(count) && count >= 1,
    ),
  ).toBe(true);
}

function caught(call: () => unknown) {
  try {
    call();
  } catch (error) {
    if (error instanceof ForgeFailure) return error.error;
    throw error;
  }
  return undefined;
}

const issue = (number: number, fields: object = {}) => ({
  id: "work-" + number,
  title: "Issue " + number,
  status: "open",
  labels: [],
  dependsOn: [],
  createdAt: new Date(now).toISOString(),
  ...fields,
});
const record = (
  number: number,
  revision: number,
  value: unknown,
): RecordEvent => ({ key: "r" + number, revision, value });
const item = (number: number, revision: number, prefix: unknown) =>
  record(number, revision, issue(number, { prefix }));
const put = (...events: RecordEvent[]): Frame => ({
  operation: "fixture.put",
  time: now,
  events,
  changes: events.map(({ key, revision, value }) => ({
    key,
    value: { revision, value },
  })),
});
const tombstone = (number: number, revision: number): Frame => {
  const key = "r" + number;
  return {
    operation: "fixture.delete",
    time: now,
    events: [{ key, revision }],
    changes: [{ key, value: { revision, deleted: true } }],
  };
};
const matrix = [
  record(1, 1, issue(1, { id: "work-2", prefix: "mismatch" })),
  item(2, 1, "old"),
  item(3, 1, "old"),
  item(4, 1, "old"),
  item(5, 1, null),
  item(6, 1, 1),
  item(7, 1, true),
  item(8, 1, {}),
  item(9, 1, []),
  item(10, 1, "Old"),
  record(11, 1, issue(11)),
  record(12, 1, "x"),
  record(13, 1, []),
  record(14, 1, 7),
];
const initial = put(
  item(1, 1, "old"),
  item(2, 1, "old"),
  item(3, 1, "old"),
  item(4, 1, "new"),
);
const mutations = [
  put(item(5, 1, "old")),
  put(item(5, 2, "old")),
  put(item(1, 2, "new")),
  put(record(5, 3, issue(5, { id: "work-2", prefix: "old" }))),
  put(item(5, 4, "old")),
  put(record(5, 5, false)),
  tombstone(2, 2),
  tombstone(3, 2),
  put(
    item(1, 3, "old"),
    item(4, 2, "old"),
    item(5, 6, "new"),
    item(6, 1, "new"),
  ),
];

async function provision(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
}

async function wireWrite(f: Fixture, ...frames: Frame[]) {
  expect((await f.send(probe + "/commits", { frames })).status).toBe(200);
}

function write(f: Fixture, image: V3Image, ...frames: Frame[]) {
  const head = image.head + frames.length;
  expect(append(dbOf(f), f.seal(), image, frames)).toEqual({ head });
  publishV3(image);
  expect(image.head).toBe(head);
  expect(tail(f, head - frames.length, head)).toHaveLength(frames.length);
}

function checkUsage(f: Fixture, image: V3Image, label: string) {
  const observed: Parameters<typeof assertUsage>[0][number][] = [];
  remember(observed, label, image, rootedRecount(f, image));
  assertUsage(observed);
}

function eligible(image: V3Image) {
  expect(image.entries.lease.size).toBe(0);
  expect(image.usage.transcript).toBeLessThanOrEqual(262_144 - 13_313);
  expect(image.usage.snapshot).toBeLessThanOrEqual(262_144 - 10_928);
  expect(image.usage.directory).toBeLessThanOrEqual(262_144 - 1711);
  expect(image.head - image.root.coveredHead).toBeLessThanOrEqual(1024 - 4);
  expect(image.tailBytes).toBeLessThanOrEqual(1_048_576 - 13_312);
}

const checkpointRoute = probe + "/checkpoint";
type Cut = {
  coveredHead: number;
  more: boolean;
  rosterDigest: string;
  projectionDigest: string;
};
async function checkpoint(f: Fixture) {
  const reply = await f.send(checkpointRoute, {});
  expect(reply.status).toBe(200);
  const cut = (reply.body as { value: Cut }).value;
  const image = cold(f);
  expect<unknown>(cut).toEqual({
    coveredHead: image.root.coveredHead,
    more: image.head > image.root.coveredHead,
    rosterDigest: digestValue(image.root.pages),
    projectionDigest: image.root.publicDigest,
  });
  const folded = foldTranscript(
    dbOf(f),
    transcript(f),
    "archived",
    Project.admitLeaseRequest,
  );
  expect(cut.projectionDigest).toBe(
    digestProjection(inventory(folded, new Map())),
  );
  return cut;
}

async function drain(f: Fixture) {
  for (;;) {
    if (!(await checkpoint(f)).more) break;
  }
  expect(tail(f)).toEqual([]);
}

const transcript = (f: Fixture) =>
  JSON.parse(pages(f).get("transcript:0")!) as unknown[];

function updateCall(id: string, requestId: string) {
  return {
    op: "issue.update",
    requestId,
    input: { id, expectRevision: 1, title: "After" },
    context: { ...context, leaseGeneration: 1 },
  };
}
function claimCall(id: string, requestId: string) {
  return {
    op: "issue.claim",
    requestId,
    input: { id, ttlSeconds: 60 },
    context,
  };
}
const typed = (f: Fixture, call: object) =>
  f.sendText(probe + "/command", call, headers);
const absent = { status: 400, exit: 6, error: prefixError };
const unheld = (number: number) => ({
  status: 409,
  exit: 4,
  error: noLease(number),
});

async function checkpointed(f: Fixture, lastAlias = false) {
  await provision(f);
  for (let start = 1; start <= 48; start += 12)
    await wireWrite(
      f,
      put(
        ...Array.from({ length: 12 }, (_, i) => {
          const number = start + i;
          return item(number, 1, lastAlias && number === 9 ? "old" : "forge");
        }),
      ),
    );
  await drain(f);
  const image = cold(f);
  expect(image.entries.record.size).toBe(48);
  expect(
    [...image.entries.record.values()].every((slot) => "page" in slot),
  ).toBe(true);
  expect([...image.entries.record.keys()].at(-1)).toBe("r9");
  eligible(image);
}

async function flood(
  f: Fixture,
  id: string,
  expected: Parameters<typeof expectTypedReply>[1],
) {
  const request = updateCall(id, "flood-0");
  const first = await typed(f, request);
  expectTypedReply(first, expected);
  for (let i = 1; i < 48; i++) {
    const reply = await typed(f, updateCall(id, "flood-" + i));
    expect(reply).toEqual(first);
  }
  return { request, first };
}

async function coldReads(f: ReturnType<typeof observedFixture>) {
  const effects = f.observeEffects();
  f.startReads();
  f.restart();
  const reply = await f.send(probe);
  const reads = f.stopReads();
  expect(reply.status).toBe(200);
  expect(effects()).toEqual(noWrites);
  return reads;
}

async function checkFlood(
  f: Fixture,
  { request, first }: Awaited<ReturnType<typeof flood>>,
  rows = 48,
) {
  const effects = f.observeEffects();
  expect(await typed(f, request)).toEqual(first);
  expect(effects()).toEqual(noWrites);
  const image = cold(f);
  expect(image.head - image.root.coveredHead).toBe(rows);
  eligible(image);
  checkUsage(f, image, "flood");
}

test(
  "L1 bounds cold reads for an absent historical alias",
  async () => {
    const f = observedFixture();
    using _db = f.db;
    await checkpointed(f);
    const evidence = await flood(f, "zz-1", absent);
    const reads = await coldReads(f);
    expect(reads).toBeLessThanOrEqual(240);
    await checkFlood(f, evidence);
  },
  timeout,
);

test(
  "L2 bounds warm reads across typed decisions and publication",
  async () => {
    const f = observedFixture();
    using _db = f.db;
    await checkpointed(f);
    f.startReads();
    const evidence = await flood(f, "zz-1", absent);
    const reads = f.stopReads();
    expect(reads).toBeLessThanOrEqual(624);
    await checkFlood(f, evidence);
  },
  timeout,
);

test(
  "L3 bounds cold and warm reads for the last directory record's alias",
  async () => {
    const f = observedFixture();
    using _db = f.db;
    await checkpointed(f, true);
    f.startReads();
    const evidence = await flood(f, "old-9", unheld(9));
    const warmReads = f.stopReads();
    const reads = await coldReads(f);
    expect(reads).toBeLessThanOrEqual(240);
    expect(warmReads).toBeLessThanOrEqual(624);
    await checkFlood(f, evidence);
  },
  timeout,
);

test(
  "L4 bounds cold reads through repeated record changes and refusals",
  async () => {
    const f = observedFixture();
    using _db = f.db;
    await checkpointed(f);
    const request = updateCall("zz-1", "first");
    const first = await typed(f, request);
    expectTypedReply(first, absent);
    checkDecisions(cold(f));
    for (let batch = 0; batch < 8; batch++) {
      await wireWrite(
        f,
        put(
          ...Array.from({ length: 4 }, (_, i) =>
            item(i + 1, batch + 2, (batch + i) % 2 ? "old" : "new"),
          ),
        ),
      );
      const after = cold(f);
      eligible(after);
      checkDecisions(after);
      expect(decide(after, "zz-1")).toEqual(refused(prefixError));
      for (let i = 0; i < 10; i++)
        expect(
          await typed(f, updateCall("zz-1", "after-" + batch + "-" + i)),
        ).toEqual(first);
    }
    const prepared = cold(f);
    expect(
      [...prepared.entries.record.values()].filter((slot) => "page" in slot),
    ).toHaveLength(44);
    eligible(prepared);
    const reads = await coldReads(f);
    expect(reads).toBeLessThanOrEqual(436);
    await checkFlood(f, { request, first }, 89);
  },
  timeout,
);

test(
  "Q1 matches the scan on an empty image and mixed stored values",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const image = cold(f);
    checkDecisions(image);
    write(f, image, put(...matrix));
    checkDecisions(image);
    checkDecisions(cold(f), image);
  },
  timeout,
);

test(
  "Q2 matches the scan across warm and cold record transitions",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const image = cold(f);
    write(f, image, initial);
    for (const [i, frame] of [undefined, ...mutations].entries()) {
      if (frame) write(f, image, frame);
      checkDecisions(image);
      const reloaded = cold(f);
      checkDecisions(reloaded, image);
      checkUsage(f, image, "warm " + i);
      checkUsage(f, reloaded, "cold " + i);
    }
  },
  timeout,
);

test(
  "Q3 records and replays typed refusals after the last alias holder goes",
  async () => {
    for (const [label, frame] of [
      ["prefix", put(item(1, 2, "new"))],
      ["delete", tombstone(1, 2)],
      ["id", put(record(1, 2, issue(1, { id: "work-2", prefix: "old" })))],
    ] as const) {
      const f = guardFixture(env);
      using _db = f.db;
      await provision(f);
      await wireWrite(f, put(item(1, 1, "old"), item(2, 1, "still")));
      expect(oracle(cold(f), "old")).toBe(true);
      expectTypedReply(
        await typed(f, updateCall("old-1", "before-removal")),
        unheld(1),
      );
      await wireWrite(f, frame);
      const replies = [];
      for (const phase of ["warm", "cold"]) {
        if (phase === "cold") f.restart();
        const start = tail(f).length;
        for (const call of [
          updateCall("old-1", label + "-" + phase + "-update"),
          claimCall("old-1", label + "-" + phase + "-claim"),
        ]) {
          const reply = await typed(f, call);
          expectTypedReply(reply, absent);
          replies.push({ call, reply });
        }
        expect(tail(f)).toHaveLength(start + 2);
        const image = cold(f);
        expect(oracle(image, "old")).toBe(false);
        expect(oracle(image, "still")).toBe(true);
        expect(decide(image, "still-999")).toEqual(refused(missing));
      }
      const effects = f.observeEffects();
      for (const { call, reply } of replies)
        expect(await typed(f, call)).toEqual(reply);
      expect(effects()).toEqual(noWrites);
      expect(replies[2]!.reply).toEqual(replies[0]!.reply);
      expect(replies[3]!.reply).toEqual(replies[1]!.reply);
    }
  },
  timeout,
);

test(
  "Q4 defaults nullish prefixes and keeps numeric and prototype keys distinct",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const image = cold(f);
    write(
      f,
      image,
      put(
        record(1, 1, issue(1)),
        item(2, 1, null),
        item(3, 1, 1),
        item(4, 1, "Old"),
      ),
    );
    const aliases = ["work", "1", "old", "constructor"];
    const probeDefaults = () =>
      aliases.map((alias) => {
        const minted = oracle(image, alias);
        const result = decide(image, alias + "-1");
        expect(result).toEqual(refused(minted ? noLease(1) : prefixError));
        return minted;
      });
    checkDecisions(image);
    expect(probeDefaults()).toEqual([true, false, false, false]);
    write(f, image, put(item(5, 1, "1")));
    checkDecisions(image);
    expect(probeDefaults()).toEqual([true, true, false, false]);
  },
  timeout,
);

async function wireDecisions(f: Fixture, phase: string) {
  const image = cold(f);
  for (const [i, alias] of [...probeAliases(image)].entries()) {
    const reply = await typed(f, updateCall(alias + "-999", phase + "-" + i));
    expectTypedReply(
      reply,
      allows(image, alias) ? { status: 404, exit: 3, error: missing } : absent,
    );
  }
}

test(
  "Q5 matches the scan across partial checkpoint cuts and served image replacement",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await wireWrite(f, initial);
    await wireDecisions(f, "before");
    for (const [i, frame] of mutations.entries()) {
      await wireWrite(f, frame);
      await wireDecisions(f, "step-" + i);
      if (i === 3 || i === 7) {
        const before = await f.send(probe);
        expect((await checkpoint(f)).more).toBe(true);
        const after = await f.send(probe);
        expect(after.status).toBe(200);
        expect(
          (after.body as { value: { image: unknown } }).value.image,
        ).toEqual((before.body as { value: { image: unknown } }).value.image);
        await wireDecisions(f, "after-cut-" + i);
      }
    }
    const beforeRestart = await f.send(probe);
    f.restart();
    expect(await f.send(probe)).toEqual(beforeRestart);
    await wireDecisions(f, "restart");
  },
  timeout,
);

async function matrixBackup(source: Fixture) {
  await provision(source);
  await wireWrite(source, put(...matrix));
  await drain(source);
  return portableOf(source);
}

async function upload(target: Fixture, backup: Portable) {
  const send = portableUpload(target, backup);
  for (const [page] of backup.pages.entries())
    expect(await send(page)).toEqual({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  expect(backup.pages).toHaveLength(3);
}
const portableFold = (source: Fixture, backup: Portable) =>
  foldTranscript(
    dbOf(source),
    JSON.parse(
      backup.pages.find(({ id }) => id === "transcript:0")!.body,
    ) as unknown[],
    "portable",
    Project.admitLeaseRequest,
  );

test(
  "Q6 matches the source scan in the portable fold and restored image",
  async () => {
    const source = guardFixture(env);
    const target = guardFixture(env);
    using _sourceDb = source.db;
    using _targetDb = target.db;
    const backup = await matrixBackup(source);
    const expected = cold(source);
    checkDecisions(portableFold(source, backup), expected);
    await upload(target, backup);
    const restored = cold(target);
    checkDecisions(restored, expected);
    expect(restored.root.publicDigest).toBe(backup.publicDigest);
    expect(pages(target)).toEqual(
      new Map(backup.pages.map(({ id, body }) => [id, body])),
    );
    const view = await target.send(probe);
    expect(view).toEqual({
      status: 200,
      body: { ok: true, value: viewV3(restored) },
    });
    target.restart();
    expect(await target.send(probe)).toEqual(view);
    checkDecisions(cold(target), expected);
  },
  timeout,
);

test(
  "Q7 maintains equal count and key maps across fold modes",
  async () => {
    const f = guardFixture(env);
    const target = guardFixture(env);
    using _db = f.db;
    using _targetDb = target.db;
    await provision(f);
    const warm = cold(f);
    expect(decide(warm, "zz-999")).toEqual(refused(prefixError));
    write(f, warm, initial, ...mutations);
    const cut = await checkpointV3(
      dbOf(f),
      f.seal(),
      f.storage,
      warm,
      () => undefined,
      Project.admitLeaseRequest,
    );
    expect(cut.more).toBe(false);
    const expected = cold(f);
    const fold = (mode: "archived" | "portable") =>
      foldTranscript(dbOf(f), transcript(f), mode, Project.admitLeaseRequest);
    await upload(target, portableOf(f));
    const activated = cold(target);
    expect(activated.root.activationDigest).toBeDefined();
    for (const image of [
      warm,
      expected,
      fold("archived"),
      fold("portable"),
      activated,
    ])
      expectIndexes(image, expected);

    const refusedFixture = guardFixture(env);
    using _refusedDb = refusedFixture.db;
    await provision(refusedFixture);
    const before = cold(refusedFixture);
    write(refusedFixture, before, put(item(1, 1, "old")));
    write(refusedFixture, before, basisFrame("q7"));
    write(refusedFixture, before, put(item(1, 2, "new")));
    expectIndexes(before);
    expectIndexes(cold(refusedFixture), before);
  },
  timeout,
);

test(
  "Q8 deletes a shared alias count to zero with its last holder",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    const image = cold(f);
    write(f, image, put(item(1, 1, "old"), item(2, 1, "old")));
    expectIndexes(image);
    const expectHolders = (
      count: number | undefined,
      deleted: readonly string[],
    ) => {
      const { counts, byKey } = indexMaps(image);
      expect(counts.has("old")).toBe(count !== undefined);
      if (count !== undefined) expect(counts.get("old")).toBe(count);
      for (const key of ["r1", "r2"])
        expect(byKey.has(key)).toBe(!deleted.includes(key));
      const independent = independentIndexes(image);
      expect(counts.size).toBe(independent.counts.size);
      expect(byKey.size).toBe(independent.byKey.size);
    };
    expectHolders(2, []);
    write(f, image, tombstone(1, 2));
    expectHolders(1, ["r1"]);
    write(f, image, tombstone(2, 2));
    expectHolders(undefined, ["r1", "r2"]);
  },
  timeout,
);

function basisFrame(requestId: string): Frame {
  const { op, input, context } = updateCall("new-1", requestId);
  const receipt = prepareReceipt("command", principal, requestId, {
    op,
    input,
    context,
    device,
  });
  return {
    operation: op,
    time: now,
    events: [],
    basis: basis("new-1"),
    outcome: {
      id: receipt.requestId,
      fingerprint: receipt.fingerprint,
      scope: { family: "command", ...receiptScope(principal) },
      status: "INPUT_INVALID",
      result: prefixError,
      retryUntil: expiry,
    },
  };
}

function fillTranscript(f: Fixture, image: V3Image) {
  const limit = 262_144 - 13_313;
  const filler = {
    operation: "fixture.note",
    time: now,
    events: [{ pad: "" }],
  };
  const bytes = jsonBytes({
    ...filler,
    format: "forge-cloud-commit/3",
    sequence: image.head + 1,
  });
  filler.events[0]!.pad = "x".repeat(
    limit - image.usage.transcript - bytes - 1,
  );
  write(f, image, filler);
  expect(image.usage.transcript).toBe(limit);
  eligible(image);
}

function stateOf(f: Fixture, image: V3Image) {
  return {
    commits: tail(f),
    pages: pages(f),
    root: image.root,
    stale: image.stale,
    staged: [...image.staged],
    head: image.head,
    tailBytes: image.tailBytes,
    recordFloor: image.recordFloor,
    eventWatermark: image.eventWatermark,
    sizes: Object.values(image.entries).map((entries) => entries.size),
    projection: viewV3(image),
    usage: { ...image.usage },
    recount: rootedRecount(f, image),
  };
}

test(
  "Q9 verifies a basis refusal before the record change and preserves state on admission failure",
  async () => {
    const accepted = guardFixture(env);
    const full = guardFixture(env);
    using _acceptedDb = accepted.db;
    using _fullDb = full.db;
    const rePrefix = put(item(1, 2, "new"));
    for (const f of [accepted, full]) {
      await provision(f);
      await wireWrite(f, put(item(1, 1, "old")));
    }
    const open = cold(accepted);
    checkDecisions(open);
    expect(decide(open, "new-1")).toEqual(refused(prefixError));
    write(accepted, open, basisFrame("accepted"), rePrefix);
    const reloadedOpen = cold(accepted);
    expect(viewV3(reloadedOpen)).toEqual(viewV3(open));
    expect(oracle(reloadedOpen, "new")).toBe(true);
    expect(decide(reloadedOpen, "new-999")).toEqual(refused(missing));
    checkDecisions(open, reloadedOpen);

    const image = cold(full);
    fillTranscript(full, image);
    checkDecisions(image);
    expect(decide(image, "new-1")).toEqual(refused(prefixError));
    const state = stateOf(full, image);
    const effects = full.observeEffects();
    const error = caught(() =>
      append(dbOf(full), full.seal(), image, [
        basisFrame("over-limit"),
        rePrefix,
      ]),
    );
    expect(error).toEqual(historyFull);
    expect(exitCode(failed(error!))).toBe(1);
    expect(effects()).toEqual(noWrites);
    expect(stateOf(full, image)).toEqual(state);
    expect(state.recount).toEqual(state.usage);
    checkDecisions(image);
    expect(decide(image, "new-1")).toEqual(refused(prefixError));
    const reloaded = cold(full);
    expect(stateOf(full, reloaded)).toEqual(state);
    checkDecisions(reloaded, image);
  },
  timeout,
);

function installPromotion(f: Fixture, activated: V3Image) {
  const { activationDigest, ...root } = activated.root;
  expect(activationDigest).toBeDefined();
  const operation = "restore.promote";
  const sequence = activated.head + 1;
  const time = now + 2;
  const approval = {
    id: "00000000-0000-4000-8000-000000000001",
    operationDigest: digestValue([operation, activationDigest]),
    approver: digestValue(principal),
    approvedAt: now + 1,
    expiresAt: now + 60_000,
  };
  const receipt = prepareReceipt("command", principal, "promotion", approval);
  const outcome = {
    id: receipt.requestId,
    fingerprint: receipt.fingerprint,
    scope: { family: "command", ...receiptScope(principal) },
    status: "ok",
    result: { state: "promoted", stopped: true, sequence },
    retryUntil: expiry,
  };
  const body = canonicalJson({
    operation,
    time,
    sequence,
    format: "forge-cloud-commit/3",
    activationDigest,
    approval,
    events: [
      { type: operation, actor: "owner", at: new Date(time).toISOString() },
    ],
    outcome,
  });
  const manifest = canonicalJson({
    ...root,
    generation: 2,
    parentDigest: digestValue(activated.root),
  });
  expect(
    f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
      manifest,
      trustedSeal(f.db, manifest),
    ]).changes,
  ).toBe(1);
  expect(
    f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
      sequence,
      body,
      f.sign(sequence, body),
    ]).changes,
  ).toBe(1);
  return outcome.id;
}

test(
  "Q10 keeps alias decisions across activation and generation two promotion",
  async () => {
    const source = guardFixture(env);
    const target = guardFixture(env);
    using _sourceDb = source.db;
    using _targetDb = target.db;
    const backup = await matrixBackup(source);
    const beforeActivation = portableFold(source, backup);
    checkDecisions(beforeActivation, cold(source));
    await upload(target, backup);
    const activated = cold(target);
    expect(activated.root.activationDigest).toBeDefined();
    expect(activated.head).toBe(beforeActivation.head + 1);
    checkDecisions(activated, beforeActivation);
    const recordProjection: unknown = Reflect.get(
      viewV3(activated).image,
      "record",
    );
    const id = installPromotion(target, activated);
    target.restart();
    const promoted = cold(target);
    expect(promoted.head).toBe(activated.head + 1);
    expect(promoted.root.generation).toBe(2);
    expect(promoted.entries.outcome.has(id)).toBe(true);
    expect(Reflect.get(viewV3(promoted).image, "record")).toEqual(
      recordProjection,
    );
    expect(promoted.root.publicDigest).toBe(backup.publicDigest);
    checkDecisions(promoted, beforeActivation);
    expect(await target.send(probe)).toEqual({
      status: 200,
      body: { ok: true, value: viewV3(promoted) },
    });
  },
  timeout,
);

test(
  "T1 fails closed and leaves both indexes unbuilt when a later snapshot read fails",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await provision(f);
    await wireWrite(
      f,
      put(
        item(1, 1, "old"),
        item(2, 1, "forge"),
        record(3, 1, issue(3, { prefix: "forge", title: "Third intact" })),
      ),
    );
    await drain(f);
    const image = cold(f);
    expect([...image.entries.record.keys()]).toEqual(["r1", "r2", "r3"]);
    expect(oracle(image, "old")).toBe(true);
    const snapshot = pages(f).get("snapshot:0")!;
    const edited = snapshot.replace('"Third intact"', '"Third edited"');
    expect(edited).not.toBe(snapshot);
    expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(snapshot));
    expect(
      f.db.run("UPDATE cloud_v3_pages SET body=? WHERE id='snapshot:0'", [
        edited,
      ]).changes,
    ).toBe(1);
    const effects = f.observeEffects();
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(caught(() => decide(image, "old-1"))?.code).toBe("UNAVAILABLE");
      expect(aliasesOf(image)).toBeUndefined();
      expect(aliasByKeyOf(image)).toBeUndefined();
    }
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

async function componentReply(f: Fixture, image: V3Image, call: object) {
  const reply = commandV3(dbOf(f), f.seal(), image, canonicalJson(call), {
    device,
    principal,
    project: "a",
    prefix: "forge",
    expiresAt: expiry,
    now,
  });
  expect(reply.status).toBe(200);
  return reply.text();
}

test(
  "C1 keeps projected views, checkpoint bytes and typed replies identical",
  async () => {
    const setup = { id: "a".repeat(64), key: newKey() };
    const indexed = guardFixture(env, setup);
    const untouched = guardFixture(env, setup);
    using _indexedDb = indexed.db;
    using _untouchedDb = untouched.db;
    await provision(indexed);
    await provision(untouched);
    copyTables(indexed, untouched);
    const image = cold(indexed);
    const reference = cold(untouched);
    for (const frame of [initial, ...mutations]) {
      write(indexed, image, frame);
      checkDecisions(image);
      write(untouched, reference, frame);
    }
    for (const call of [
      {
        op: "issue.create",
        requestId: "create",
        input: { title: "Typed" },
        context: { actor: holder.actor },
      },
      claimCall("forge-1", "claim"),
      {
        ...updateCall("forge-1", "update"),
        input: { id: "forge-1", expectRevision: 3, title: "After" },
      },
    ]) {
      const expected = await componentReply(untouched, reference, call);
      expect(await componentReply(indexed, image, call)).toBe(expected);
    }
    expect(viewV3(image)).toEqual(viewV3(reference));
    expect(Object.keys(viewV3(image).image).sort()).toEqual([
      "control",
      "eventWatermark",
      "head",
      "lease",
      "outcome",
      "record",
      "witness",
    ]);
    const checkpointWith = (f: Fixture, warm: V3Image) =>
      checkpointV3(
        dbOf(f),
        f.seal(),
        f.storage,
        warm,
        () => undefined,
        Project.admitLeaseRequest,
      );
    for (let turn = 0; turn < 2; turn++) {
      const expected = await checkpointWith(untouched, reference);
      expect(await checkpointWith(indexed, image)).toEqual(expected);
      expect(pages(indexed)).toEqual(pages(untouched));
      expect(cold(indexed).root).toEqual(cold(untouched).root);
      expect(expected.more).toBe(turn === 0);
    }
  },
  timeout,
);
