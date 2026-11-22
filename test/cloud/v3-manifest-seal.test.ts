import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { writableStore } from "../../cloud/src/store.ts";
import { recoverV3 } from "../../cloud/src/v3-store.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { guardFixture, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const E1 = T0 + 2 * HOUR;
const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
  leaseGeneration: 1,
};
const missingUpdate = {
  op: "issue.update",
  requestId: "restored-update",
  input: { id: "forge-9", expectRevision: 1, title: "After" },
  context: holder,
};
const invalidUpdate = {
  ...missingUpdate,
  requestId: "invalid-update",
  input: { ...missingUpdate.input, dependsOn: ["forge-1"] },
};

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
interface DirectoryItem {
  collection: string;
  key: string;
  revision?: number;
  offset?: number;
  length?: number;
  digest?: string;
}
interface Portable {
  pages: { id: string; body: string }[];
  head: number;
  eventWatermark: number;
  recordFloor: number;
  publicDigest: string;
}

const restoreRefusal = {
  status: 400,
  body: { ok: false, error: { code: "RESTORE_INVALID_ROW" } },
};
const tableNames = ({ db }: Fixture) =>
  db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type='table'",
    )
    .all()
    .map(({ name }) => name);
const typed = (f: Fixture, body: Json) =>
  f.send(`${probe}/command`, body, {
    "X-Forge-Owner": "owner-a",
    "X-Forge-Owner-Expires": String(E1),
  });

async function withTyped(
  run: (target: Fixture, data: Portable) => Promise<void>,
) {
  const source = guardFixture(typedEnv);
  const target = guardFixture(typedEnv);
  using _source = source.db;
  using _target = target.db;
  expect(await source.send(probe, {})).toMatchObject({ status: 200 });
  expect((await typed(source, missingUpdate)).status).toBe(404);
  expect((await typed(source, invalidUpdate)).status).toBe(400);
  for (let i = 0; i < 4 && rows(source) > 0; i++)
    expect((await source.send(`${probe}/checkpoint`, {})).status).toBe(200);
  expect(rows(source)).toBe(0);
  const { head, eventWatermark, recordFloor, root } = recoverV3(
    writableStore(source.storage),
    source.seal(),
  );
  await run(target, {
    pages: source.db
      .query<{ id: string; body: string }, []>(
        "SELECT id, body FROM cloud_v3_pages ORDER BY id",
      )
      .all(),
    head,
    eventWatermark,
    recordFloor,
    publicDigest: root.publicDigest as string,
  });
}

function rows({ db }: Fixture) {
  return db
    .query<{ n: number }, []>("SELECT count(*) AS n FROM cloud_v3_commits")
    .get()!.n;
}

function rewriteRefusal(data: Portable) {
  const entries = JSON.parse(data.pages[0]!.body) as DirectoryItem[];
  const bytes = Buffer.from(data.pages[1]!.body);
  const text = ({ offset, length }: DirectoryItem) =>
    bytes.subarray(offset, offset! + length!).toString();
  const item = entries.find((e) => text(e).includes('"code":"NOT_FOUND"'))!;
  const saved = JSON.parse(text(item)) as { outcome: { result: Json } };
  Object.assign(saved.outcome.result, { message: "Edited message" });
  const parts = entries.map((e) =>
    e === item ? canonicalJson(saved) : text(e),
  );
  let offset = 0;
  for (const [i, e] of entries.entries()) {
    const length = Buffer.byteLength(parts[i]!);
    Object.assign(e, { offset, length, digest: digestBytes(parts[i]!) });
    offset += length;
  }
  data.pages[1]!.body = parts.join("");
  data.pages[0]!.body = canonicalJson(entries);
  data.publicDigest = digestBytes(
    canonicalJson(
      entries.map(({ collection, key, revision, digest }) => [
        collection,
        key,
        revision === undefined
          ? (digest ?? null)
          : digestBytes(canonicalJson([revision, digest ?? null])),
      ]),
    ),
  );
  const frames = JSON.parse(data.pages[2]!.body) as Json[];
  const { outcome } = frames.find((f) => (f.outcome as Json).id === item.key)!;
  (outcome as Json).resultDigest = digestBytes(
    canonicalJson(saved.outcome.result),
  );
  data.pages[2]!.body = canonicalJson(frames);
}

function portableUpload(target: Fixture, { pages, ...projection }: Portable) {
  const manifest = {
    ...projection,
    format: "forge-cloud-portable/3",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  };
  const pin = digestBytes(canonicalJson(manifest));
  return (page: number, member = pages[page]!) =>
    target.send(
      "restore",
      { page, ...member, ...(page === 0 && { manifest }) },
      page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
    );
}

test(
  "v3 restore refuses a rewritten backup whose pages and pin were recomputed",
  () =>
    withTyped(async (target, data) => {
      rewriteRefusal(data);
      const reply = await portableUpload(target, data)(0);
      expect(reply.status).toBe(400);
      expect(reply).toMatchObject(restoreRefusal);
      expect(tableNames(target)).not.toContain("cloud_v3_restore");
      expect(tableNames(target)).not.toContain("cloud_v3_root");
    }),
  timeout,
);

test(
  "v3 restore refuses a staged manifest rewritten together with its pin",
  () =>
    withTyped(async (target, data) => {
      const upload = portableUpload(target, data);
      expect((await upload(0)).status).toBe(200);
      const saved = target.db
        .query<{ manifest: string }, []>(
          "SELECT manifest FROM cloud_v3_restore WHERE id='directory:0'",
        )
        .get()!;
      const manifest = JSON.parse(saved.manifest) as {
        pages: { id: string; bytes: number; hash: string }[];
      };
      const body = "tampered";
      manifest.pages[1] = {
        id: "snapshot:0",
        bytes: Buffer.byteLength(body),
        hash: digestBytes(body),
      };
      target.db.run(
        "UPDATE cloud_v3_restore SET manifest=?, pin=? WHERE id='directory:0'",
        [canonicalJson(manifest), digestBytes(canonicalJson(manifest))],
      );
      const reply = await upload(1, { id: "snapshot:0", body });
      expect(reply.status).toBe(400);
      expect(reply).toMatchObject(restoreRefusal);
      expect(
        target.db.query("SELECT id FROM cloud_v3_restore").all(),
      ).toHaveLength(1);
    }),
  timeout,
);
