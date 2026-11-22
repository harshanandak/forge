import { timingSafeEqual } from "node:crypto";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { scopeRequestId } from "../../cloud/src/issue-request-id.ts";
import { Project } from "../../cloud/src/project.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { digestProjection, inventory } from "../../cloud/src/v3-checkpoint.ts";
import { verifyRow } from "../../cloud/src/v3-seal.ts";
import {
  COLLECTIONS,
  readV3Value,
  recoverV3,
  viewV3,
} from "../../cloud/src/v3-store.ts";
import { digestBytes, digestValue } from "../../src/core/config/pointer.ts";
import { guardFixture, noWrites, probe } from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const time = Date.parse("2026-11-20T12:00:00.000Z");
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
  input: { title: "Before" },
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
  input: { id: "forge-1", expectRevision: 1, title: "After" },
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
  return { db, image: recoverV3(db, f.seal()) };
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
  };
}

type Backup = Awaited<ReturnType<typeof checkpoint>>;
const restoreResult = (page: number, verified = false) => ({
  status: 200,
  body: { ok: true, value: { page, verified } },
});

async function stage(target: Fixture, { pages, ...projection }: Backup) {
  const manifest = {
    ...projection,
    format: "forge-cloud-portable/3",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  };
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
    portableTranscript,
  });
const receipt = (requestId: string) =>
  scopeRequestId("command", ["owner", owner, owner], requestId);

test(
  "v3 restores mixed typed history and reads it back with activation normalization",
  async () => {
    const source = open();
    const target = open();
    using _source = source.db;
    using _target = target.db;
    await provision(source);
    for (const call of [
      create,
      { ...create, requestId: "second-create", input: { title: "Second" } },
      claim,
      update,
    ])
      expect((await typed(source, call)).status).toBe(200);
    for (const call of [claim, update])
      expect(
        await typed(source, {
          ...call,
          requestId: `refused-${call.requestId}`,
          input: { ...call.input, id: "forge-9" },
        }),
      ).toMatchObject(error(404, "NOT_FOUND"));
    expect(await typed(source, refusedCreate)).toMatchObject(
      error(400, "INPUT_INVALID"),
    );
    const data = await checkpoint(source, 7);
    const before = source.observeEffects();
    const finish = await stage(target, data);
    setSystemTime(time + 1);
    expect(await finish()).toEqual(restoreResult(2, true));
    target.restart();
    expect(await target.send("status")).toEqual({
      status: 200,
      body: { ok: true, value: { initialized: true, stopped: true } },
    });
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
    expect(actual.recordFloor).toBe(2);
    expect(actual.recordFloor).toBe(expected.recordFloor);
    const { lease: _lease, ...expectedView } = viewV3(expected).image as Record<
      string,
      unknown
    >;
    const { lease: _restoredLease, ...actualView } = viewV3(actual)
      .image as Record<string, unknown>;
    expect(actualView).toEqual({
      ...expectedView,
      head: expected.head + 1,
      eventWatermark: expected.eventWatermark + 1,
    });
    for (const collection of COLLECTIONS) {
      expect([...actual.entries[collection].keys()].sort()).toEqual(
        [...expected.entries[collection].keys()].sort(),
      );
      for (const [key, slot] of expected.entries[collection]) {
        const value = readV3Value(from.db, expected, collection, key);
        const saved =
          collection === "lease"
            ? readV3Value(from.db, expected, "lease", key)!
            : undefined;
        expect(actual.entries[collection].get(key)?.revision).toBe(
          slot.revision,
        );
        expect(readV3Value(to.db, actual, collection, key)).toEqual(
          saved
            ? { ...saved, releasedAt: saved.releasedAt ?? activatedAt }
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
    const source = open();
    const target = open();
    using _source = source.db;
    using _target = target.db;
    await provision(source);
    const original = await typed(source, refusedCreate);
    expect(original).toMatchObject(error(400, "INPUT_INVALID"));
    const data = await checkpoint(source, 1);
    expect(data.recordFloor).toBe(0);
    const finish = await stage(target, data);
    expect(await finish()).toEqual(restoreResult(2, true));
    target.restart();
    expect(recovered(target).image.recordFloor).toBe(0);
    const before = target.observeEffects();
    expect(await typed(target, refusedCreate)).toEqual(original);
    expect(before()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 portable recovery rebuilds one successful archived create",
  async () => {
    const source = open();
    using _source = source.db;
    await provision(source);
    const original = await typed(source, create);
    expect(original).toMatchObject({
      status: 200,
      body: { result: { id: "forge-1", revision: 1 } },
    });
    const data = await checkpoint(source, 1);
    const { db, image: stored } = recovered(source);
    const before = source.observeEffects();
    const image = portable(source, transcript(data.pages));
    const id = receipt(create.requestId);
    expect(readV3Value(db, image, "outcome", id)).toEqual(
      readV3Value(db, stored, "outcome", id),
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
