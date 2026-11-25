import { requestConflict } from "../../cloud/src/lease-command.ts";
import { prepareReceipt } from "../../cloud/src/command-write.ts";
import { parseCommand } from "../../cloud/src/issue-commands.ts";
import { receiptScope } from "../../cloud/src/issue-request-id.ts";
import { sealedAuthorityValid } from "../../cloud/src/v3-authority.ts";
import { commandV3 } from "../../cloud/src/v3-commands.ts";
import type { V3Image } from "../../cloud/src/v3-store.ts";
import {
  archived,
  jsonBytes,
  recount,
  rootedRecount,
  usageOf,
} from "./v3-usage.fixture.ts";
import { readLaneControl } from "../../src/blocks/work/lane-control.ts";
import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { failed } from "../../cloud/src/issue-commands.ts";
import { domain, Project } from "../../cloud/src/project.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
} from "../../src/core/config/pointer.ts";
import type { ForgeError } from "../../src/generated/types.ts";
import { exitCode } from "../../src/surface/result.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  archivedCheck,
  digestProjection,
  inventory,
} from "../../cloud/src/v3-checkpoint.ts";
import { signRow } from "../../cloud/src/v3-seal.ts";
import {
  claimEffect,
  entryDigest,
  foldTranscript,
  PAGE_BYTES,
  readV3GlobalControl,
  readV3Root,
  readV3Value,
  recoverV3,
  viewV3,
  append as appendFrameBatch,
  appendV3Frames as appendProbeBatch,
} from "../../cloud/src/v3-store.ts";
import {
  changedCommandReply,
  expectTypedReply,
  guardFixture,
  noWrites,
  observeRestoreReset,
  probe,
  readOnlyReply,
  recovered,
  trustedManifest,
  trustedSeal,
  typedReplyCases,
  verifiedPortable,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const MiB = 1024 * 1024;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const E1 = T0 + 2 * HOUR;
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const checkpointRoute = `${probe}/checkpoint`;
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof guardFixture>;
type Json = Record<string, unknown>;
interface DirectoryItem {
  collection: string;
  key: string;
  revision?: number;
  page?: string;
  offset?: number;
  length?: number;
  digest?: string;
  deleted?: true;
}

const controlGlobal = (incarnation: unknown, time: number) => ({
  version: 1,
  incarnation,
  epoch: 1,
  resumeAllEpoch: 0,
  stopAll: new Date(time).toISOString(),
});
const controlDigest = (value: unknown) => ({
  global: entryDigest(digestValue(value)),
});
const controlSlot = (
  db: Parameters<typeof readV3Value>[0],
  image: ReturnType<typeof recoverV3>,
  key = "global",
): unknown => readV3Value(db, image, "control", key);

const checkpoint = (f: Fixture) => f.send(checkpointRoute, {});
const view = async (f: Fixture) => {
  const result = await f.send(probe);
  expect(result.status).toBe(200);
  return (result.body as { value: { image: Json } }).value;
};
const root = ({ db }: Fixture) =>
  db
    .query<{ body: string; seal: string }, []>(
      "SELECT body, seal FROM cloud_v3_root WHERE id=1",
    )
    .get()!;
const commits = ({ db }: Fixture) =>
  db
    .query<{ sequence: number; body: string }, []>(
      "SELECT sequence, body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all();
const pages = ({ db }: Fixture) =>
  db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all();
const active = (f: Fixture) => ({ root: root(f), pages: pages(f) });
const catalog = ({ db }: Fixture) =>
  db
    .query<
      { type: string; name: string; tbl_name: string; sql: string | null },
      []
    >("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .all();
const pageSchema = (f: Fixture) =>
  catalog(f)
    .filter(({ tbl_name }) => tbl_name === "cloud_v3_pages")
    .map(({ sql, ...row }) => ({ ...row, sql: sql?.replaceAll('"', "") }));
const retired = ({ db }: Fixture) =>
  db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_retired_pages ORDER BY id",
    )
    .all();
const tableNames = (f: Fixture) =>
  catalog(f)
    .filter(({ type }) => type === "table")
    .map(({ name }) => name);
const stagingTables = (f: Fixture) =>
  f.db
    .query(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'cloud_v3_checkpoint*'",
    )
    .all();
const frame = () => ({
  operation: "fixture.note",
  time: Date.now(),
  events: [],
});
const putRecords = (
  ...events: { key: string; revision: number; value: unknown }[]
) => ({
  ...frame(),
  operation: "fixture.put",
  events,
  changes: events.map(({ key, revision, value }) => ({
    key,
    value: { revision, value },
  })),
});
const putRecord = (key: string, revision: number, value: unknown) =>
  putRecords({ key, revision, value });
const deleteRecord = (key: string, revision: number) => ({
  ...frame(),
  operation: "fixture.delete",
  events: [{ key, revision }],
  changes: [{ key, value: { revision, deleted: true } }],
});
const append = (f: Fixture, ...frames: Json[]) =>
  f.send(`${probe}/commits`, { frames });

async function prefix(f: Fixture, previous: number, head: number) {
  const { rows, bytes } = f.reads;
  const result = await checkpoint(f);
  expect(result.status).toBe(200);
  const { value } = result.body as { value: Json };
  const coveredHead = value.coveredHead as number;
  const manifest = JSON.parse(root(f).body) as Json;
  expect(coveredHead).toBeGreaterThan(previous);
  expect(coveredHead).toBeLessThanOrEqual(head);
  expect(value.more).toBe(coveredHead < head);
  expect(result.body).toMatchObject({
    ok: true,
    value: {
      coveredHead: manifest.coveredHead,
      rosterDigest: digestBytes(canonicalJson(manifest.pages)),
      projectionDigest: manifest.publicDigest,
    },
  });
  const reads = f.reads.rows - rows;
  console.log("v3 checkpoint prefix reads", {
    coveredHead,
    rows: reads,
    fixedRows: reads - 2 * (coveredHead - previous),
    bytes: f.reads.bytes - bytes,
  });
  expect(reads).toBeLessThanOrEqual(64);
  expect(f.reads.bytes - bytes).toBeLessThanOrEqual(4 * MiB);
  return coveredHead;
}

async function drain(f: Fixture, coveredHead: number, head: number) {
  while (coveredHead < head) coveredHead = await prefix(f, coveredHead, head);
  expect(commits(f)).toEqual([]);
  expect(stagingTables(f)).toEqual([]);
  expect(tableNames(f)).not.toContain("cloud_v3_retired_pages");
}

async function expectWarmAndCold(f: Fixture, image: Json) {
  const warm = await view(f);
  expect(warm.image).toEqual(image);
  f.restart();
  expect(await view(f)).toEqual(warm);
}

async function withFixture(run: (f: Fixture) => void | Promise<void>) {
  const f = guardFixture();
  try {
    expect((await f.send(probe, {})).status).toBe(200);
    await run(f);
  } finally {
    f.db.close();
  }
}

async function populate(f: Fixture) {
  const lease = (route: string, owner: string, input: Json) =>
    f.send(
      `${probe}/${route}`,
      {
        subject: "work-1",
        holder: { ...holder, session: { ...holder.session, device: owner } },
        ...input,
      },
      {
        "X-Forge-Owner": owner,
        "X-Forge-Owner-Expires": String(E1),
      },
    );
  expect(
    (
      await append(
        f,
        putRecords(
          { key: "r1", revision: 1, value: { text: "café" } },
          { key: "r2", revision: 1, value: { text: "café" } },
          { key: "r3", revision: 1, value: 1 },
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    await lease("claim", "owner-a", { requestId: "acq-1", ttlMs: HOUR }),
  ).toMatchObject({ status: 200 });
  expect(
    await lease("claim", "owner-b", { requestId: "acq-2", ttlMs: HOUR }),
  ).toMatchObject({ status: 409, body: { error: { code: "LEASE_HELD" } } });
  expect(
    await lease("release", "owner-a", { requestId: "rel-1", generation: 1 }),
  ).toMatchObject({ status: 200 });
  expect((await append(f, deleteRecord("r3", 2))).status).toBe(200);
}

function afterSync(
  f: Fixture,
  phase: number,
  action: () => void | Promise<void>,
) {
  let calls = 0;
  Object.assign(f.storage, {
    sync: async () => {
      if (++calls === phase) await action();
    },
  });
}

const crash = () => {
  throw new ForgeFailure({
    code: "UNAVAILABLE",
    message: "Injected checkpoint fault",
    retry: "never",
  });
};

const expectCut = async (
  f: Fixture,
  generation: number,
  coveredHead: number,
  image: Json,
) => {
  const actual = await view(f);
  expect(actual).toMatchObject({ generation, coveredHead });
  expect(actual.image).toEqual(image);
};

test(
  "v3 checkpoint activates the verified digests, collects the source and recovers the image",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const before = await view(f);
      const source = active(f);
      const schema = pageSchema(f);
      const tables = tableNames(f);
      expect(tables).toEqual([
        "cloud_v3_commits",
        "cloud_v3_pages",
        "cloud_v3_root",
      ]);
      const dump = await f.send("dump");
      expect(dump.status).toBe(200);
      const log = commits(f);
      const original = log.map(({ body }) => JSON.parse(body) as Json);
      const { result: refusal, ...receipt } = original[2]!.outcome as Json;
      expect(refusal).toMatchObject({ code: "LEASE_HELD" });
      const archived = original.with(2, {
        ...original[2],
        outcome: {
          ...receipt,
          resultDigest: digestBytes(canonicalJson(refusal)),
        },
      });
      const entries = ["lease", "outcome", "record", "witness"].flatMap(
        (collection) =>
          Object.keys(before.image[collection] as Json)
            .sort()
            .map(
              (key) =>
                [
                  collection,
                  key,
                  (before.image[collection] as Json)[key],
                ] as const,
            ),
      );
      const projectionDigest = digestBytes(canonicalJson(entries));
      let rosterDigest: string | undefined;
      afterSync(f, 1, () => {
        const directory = pageBody(f, "directory:0");
        const snapshot = pageBody(f, "snapshot:0");
        const transcript = pageBody(f, "transcript:0");
        expect(JSON.parse(transcript)).toEqual(archived);
        const slots = JSON.parse(directory) as DirectoryItem[];
        expect(slots.find(({ key }) => key === "r3")).toEqual({
          collection: "record",
          key: "r3",
          revision: 2,
          deleted: true,
        });
        const refusalSlot = slots.find(
          (item) => item.collection === "outcome" && item.key === receipt.id,
        )!;
        expect(
          JSON.parse(
            Buffer.from(snapshot)
              .subarray(
                refusalSlot.offset,
                refusalSlot.offset! + refusalSlot.length!,
              )
              .toString(),
          ),
        ).toMatchObject({ outcome: { result: refusal } });
        const roster = [
          [
            "directory",
            directory,
            entries.length,
            entries[0]!.slice(0, 2),
            entries.at(-1)!.slice(0, 2),
          ],
          [
            "snapshot",
            snapshot,
            slots.filter(({ deleted }) => !deleted).length,
            null,
            null,
          ],
          ["transcript", transcript, log.length, 1, log.length],
        ] as const;
        rosterDigest = digestBytes(
          canonicalJson(
            roster.map(([kind, body, count, first, last]) => ({
              id: `${kind}:0`,
              kind,
              ordinal: 0,
              first,
              last,
              count,
              bytes: Buffer.byteLength(body),
              hash: digestBytes(body),
            })),
          ),
        );
      });
      const rows = f.reads.rows;
      const bytes = f.reads.bytes;
      const result = await checkpoint(f);
      expect(result.status).toBe(200);
      expect(rosterDigest).toBeDefined();
      expect(result.body).toMatchObject({
        ok: true,
        value: { rosterDigest, projectionDigest },
      });
      const reads = { rows: f.reads.rows - rows, bytes: f.reads.bytes - bytes };
      console.log("v3 checkpoint fixture reads", reads);
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(4 * MiB);
      expect(f.alarms).toEqual([]);
      expect(commits(f)).toEqual([]);
      expect(root(f).seal).not.toBe(source.root.seal);
      expect(pageSchema(f)).toEqual(schema);
      expect(tableNames(f)).toEqual(tables);
      expect(await f.send("dump")).toEqual(dump);
      expect(await f.send("upgrade")).toMatchObject({ status: 409 });
      expect(await f.send("restore", {})).toMatchObject({ status: 409 });
      expect(pages(f).map(({ id }) => id)).toEqual([
        "directory:0",
        "snapshot:0",
        "transcript:0",
      ]);
      const collected = [...log, ...source.pages];
      console.log("v3 checkpoint fixture collection", {
        rows: collected.length,
        bodyBytes: collected.reduce(
          (total, row) => total + Buffer.byteLength(row.body),
          0,
        ),
      });
      expect(stagingTables(f)).toEqual([]);
      await expectCut(f, 1, 5, before.image);
      f.restart();
      await expectCut(f, 1, 5, before.image);

      expect(
        (await append(f, putRecord("r1", 2, { text: "updated" }))).status,
      ).toBe(200);
      const { image } = await view(f);
      const expected = ["lease", "outcome", "record", "witness"].flatMap(
        (collection) =>
          Object.entries(image[collection] as Json)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([key, digest]) => [collection, key, digest]),
      );
      expect(await checkpoint(f)).toMatchObject({
        status: 200,
        body: {
          value: { projectionDigest: digestBytes(canonicalJson(expected)) },
        },
      });
      const transcript = pages(f).find(({ id }) => id === "transcript:0")!;
      expect(JSON.parse(transcript.body)).toEqual([
        ...archived,
        {
          ...putRecord("r1", 2, { text: "updated" }),
          format: "forge-cloud-commit/3",
          sequence: 6,
        },
      ]);
      expect(commits(f)).toEqual([]);
      f.restart();
      await expectCut(f, 2, 6, image);

      f.db.run(
        "UPDATE cloud_v3_pages SET body='[' || substr(body, 2) WHERE id='snapshot:0'",
      );
      const corrupted = active(f);
      expect(await checkpoint(f)).toMatchObject(refused);
      expect(active(f)).toEqual(corrupted);
      expect(commits(f)).toEqual([]);
    }),
  timeout,
);

test(
  "v3 checkpoint switches its verified prefix when an append lands during prepare sync",
  () =>
    withFixture(async (f) => {
      await populate(f);
      let appended: Json | undefined;
      afterSync(f, 1, async () => {
        expect((await append(f, putRecord("r4", 1, 9))).status).toBe(200);
        appended = (await view(f)).image;
      });
      expect(await checkpoint(f)).toMatchObject({
        status: 200,
        body: { value: { coveredHead: 5, more: true } },
      });
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([6]);
      expect(appended).toBeDefined();
      await expectWarmAndCold(f, appended!);
      await drain(f, 5, 6);
      await expectWarmAndCold(f, appended!);
    }),
  timeout,
);

test(
  "a post-switch append survives collection and eviction",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const before = await view(f);
      let appended: Json | undefined;
      afterSync(f, 2, async () => {
        await expectCut(f, 1, 5, before.image);
        expect((await append(f, putRecord("r4", 1, 9))).status).toBe(200);
        appended = (await view(f)).image;
      });
      expect(await checkpoint(f)).toMatchObject({ status: 200 });
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([6]);
      expect(appended).toBeDefined();
      await expectCut(f, 1, 5, appended!);
      f.restart();
      await expectCut(f, 1, 5, appended!);
    }),
  timeout,
);

test(
  "a competing sealed source refuses the switch and preserves the log",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const log = commits(f);
      let changed: ReturnType<typeof active> | undefined;
      afterSync(f, 1, () => {
        const body = canonicalJson({
          ...(JSON.parse(root(f).body) as Json),
          incarnation: "competing-root",
        });
        f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
          body,
          trustedSeal(f.db, body),
        ]);
        changed = active(f);
      });
      expect(await checkpoint(f)).toMatchObject(refused);
      expect(active(f)).toEqual(changed!);
      expect(commits(f)).toEqual(log);
    }),
  timeout,
);

for (const point of [
  "before switch",
  "between renames",
  "before collection",
  "during collection",
  "after collection",
]) {
  test(
    `v3 checkpoint recovers after a fault ${point}`,
    () =>
      withFixture(async (f) => {
        await populate(f);
        const before = await view(f);
        const source = active(f);
        const log = commits(f);
        const tables = tableNames(f);
        const maintenance = ["cloud_v3_checkpoint", "cloud_v3_retired_pages"];
        const schema = pageSchema(f);
        const collected = point === "after collection";
        const switched =
          collected ||
          point === "before collection" ||
          point === "during collection";
        if (point === "between renames" || point === "during collection") {
          const executeSql = f.storage.sql.exec.bind(f.storage.sql);
          f.storage.sql.exec = (statement, ...bindings) => {
            if (
              point === "between renames" &&
              /^ALTER TABLE cloud_v3_checkpoint_pages RENAME/i.test(statement)
            ) {
              f.storage.sql.exec = executeSql;
              expect(tableNames(f)).not.toContain("cloud_v3_pages");
              expect(retired(f)).toEqual(source.pages);
              expect(root(f)).toEqual(source.root);
              crash();
            }
            if (
              point === "during collection" &&
              /^DROP TABLE IF EXISTS cloud_v3_retired_pages\b/i.test(statement)
            ) {
              f.storage.sql.exec = executeSql;
              expect(commits(f)).toEqual([]);
              crash();
            }
            return executeSql(statement, ...bindings);
          };
        } else {
          afterSync(f, collected ? 3 : switched ? 2 : 1, async () => {
            if (switched) await expectCut(f, 1, 5, before.image);
            crash();
          });
        }
        expect(await checkpoint(f)).toMatchObject({
          ...refused,
          body: {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Injected checkpoint fault",
            },
          },
        });
        expect(commits(f)).toEqual(collected ? [] : log);
        expect(pageSchema(f)).toEqual(schema);
        if (collected) {
          expect(tableNames(f)).toEqual(tables);
        } else if (switched) {
          expect(retired(f)).toEqual(source.pages);
          expect(tableNames(f)).toEqual(tables.concat(maintenance).sort());
        } else {
          expect(active(f)).toEqual(source);
          if (point === "between renames")
            expect(stagingTables(f)).toHaveLength(2);
        }
        await expectCut(f, switched ? 1 : 0, switched ? 5 : 0, before.image);
        await expectWarmAndCold(f, before.image);
        if (point === "before collection") {
          f.restart();
          const { id, body } = pages(f)[0]!;
          f.db.run(
            "UPDATE cloud_v3_pages SET body='!' || substr(body, 2) WHERE id=?",
            [id],
          );
          expect(await f.send(probe)).toMatchObject(refused);
          f.db.run("UPDATE cloud_v3_pages SET body=? WHERE id=?", [body, id]);
        }
        f.restart();
        await expectCut(f, switched ? 1 : 0, switched ? 5 : 0, before.image);
        if (switched && !collected) {
          const dump = await f.send("dump");
          const rows = (
            dump.body as { value: { tables: Record<string, unknown[]> } }
          ).value.tables;
          expect(
            Object.keys(rows).every(
              (name) =>
                name.startsWith("state_") || domain.tables.includes(name),
            ),
          ).toBe(true);
          expect(Object.values(rows).flat()).toEqual([]);
          expect(await f.send("upgrade")).toMatchObject({ status: 409 });
          expect(await f.send("restore", {})).toMatchObject({ status: 409 });
          expect(tableNames(f)).toEqual(tables.concat(maintenance).sort());
          expect(pages(f)).toHaveLength(3);
          const tail = Array.from({ length: 13 }, frame);
          expect((await append(f, ...tail)).status).toBe(200);
          const appended = await view(f);
          const suffix = commits(f).slice(log.length);
          if (point === "before collection") {
            const activePrefix = active(f);
            const pendingTables = tableNames(f);
            const runSql = f.storage.sql.exec.bind(f.storage.sql);
            f.storage.sql.exec = (statement, ...bindings) => {
              if (
                /^DROP TABLE IF EXISTS cloud_v3_retired_pages\b/i.test(
                  statement,
                )
              ) {
                f.storage.sql.exec = runSql;
                expect(commits(f)).toEqual(suffix);
                crash();
              }
              return runSql(statement, ...bindings);
            };
            expect(await checkpoint(f)).toMatchObject({
              status: 503,
              body: { error: { message: "Injected checkpoint fault" } },
            });
            expect(active(f)).toEqual(activePrefix);
            expect(tableNames(f)).toEqual(pendingTables);
            expect(commits(f)).toEqual([...log, ...suffix]);
            await expectWarmAndCold(f, appended.image);
          }
          afterSync(f, 1, () => {
            expect(commits(f)).toEqual(suffix);
            expect(tableNames(f)).not.toContain("cloud_v3_retired_pages");
          });
          await drain(f, 5, 18);
          await expectWarmAndCold(f, appended.image);
        } else if (!switched) {
          expect((await checkpoint(f)).status).toBe(200);
          expect(commits(f)).toEqual([]);
          await expectCut(f, 1, 5, before.image);
        }
        expect(tableNames(f)).toEqual(tables);
        expect(pageSchema(f)).toEqual(schema);
      }),
    timeout,
  );
}

function pageBody(f: Fixture, id: string) {
  return f.db
    .query<{ body: string }, [string]>(
      "SELECT body FROM cloud_v3_checkpoint_pages WHERE id=?",
    )
    .get(id)!.body;
}

function writePage(f: Fixture, id: string, body: string) {
  f.db.run("UPDATE cloud_v3_checkpoint_pages SET body=? WHERE id=?", [
    body,
    id,
  ]);
}

function resealProposal(f: Fixture, entries: readonly DirectoryItem[]) {
  const row = f.db
    .query<{ proposal: string }, []>("SELECT proposal FROM cloud_v3_checkpoint")
    .get()!;
  const proposal = JSON.parse(row.proposal) as {
    pages: {
      id: string;
      kind: string;
      count: number;
      bytes: number;
      hash: string;
      first: unknown;
      last: unknown;
    }[];
    counts: Record<string, number>;
    bytes: Record<string, number>;
  };
  for (const page of proposal.pages) {
    if (page.kind === "transcript") continue;
    const body = pageBody(f, page.id);
    const bytes = Buffer.byteLength(body);
    proposal.bytes[page.kind] = proposal.bytes[page.kind]! + bytes - page.bytes;
    if (page.kind === "directory") {
      const [first, last] = [entries[0], entries.at(-1)];
      page.first = first ? [first.collection, first.key] : null;
      page.last = last ? [last.collection, last.key] : null;
      page.count = entries.length;
    } else {
      page.count = entries.filter((entry) => !entry.deleted).length;
    }
    proposal.counts[page.kind] = page.count;
    page.bytes = bytes;
    page.hash = digestBytes(body);
  }
  f.db.run("UPDATE cloud_v3_checkpoint SET proposal=?", [
    canonicalJson(proposal),
  ]);
}

function changedPages(f: Fixture, change: string, originalClaim: unknown) {
  const directoryId = "directory:0";
  const entries = JSON.parse(pageBody(f, directoryId)) as DirectoryItem[];
  const a = entries.find(
    ({ collection, key }) => collection === "record" && key === "r1",
  )!;
  const b = entries.find(
    ({ collection, key }) => collection === "record" && key === "r2",
  )!;
  if (change === "a pointer to another key with identical value bytes") {
    a.offset = b.offset!;
    writePage(f, directoryId, canonicalJson(entries));
    resealProposal(f, entries);
    return;
  }

  const snapshotId = "snapshot:0";
  const snapshot = Buffer.from(pageBody(f, snapshotId));
  const removable: Record<string, DirectoryItem | undefined> = {
    "a missing record": a,
    "a missing tombstone": entries.find(({ deleted }) => deleted),
    "a missing receipt": entries.find(
      ({ collection }) => collection === "outcome",
    ),
    "a missing witness": entries.find(
      ({ collection }) => collection === "witness",
    ),
  };
  const missing = removable[change];
  if (missing) entries.splice(entries.indexOf(missing), 1);
  const extra = { ...b, key: "r4" };
  if (change === "an extra record")
    entries.splice(entries.findIndex(({ key }) => key === "r3") + 1, 0, extra);
  let body = "";
  for (const item of entries) {
    if (item.deleted) continue;
    let text = snapshot
      .subarray(item.offset, item.offset! + item.length!)
      .toString();
    if (change === "a missing release" && item.collection === "lease")
      text = canonicalJson(originalClaim);
    if (change === "an altered record" && item === a)
      text = canonicalJson({ revision: 2, text: "café" });
    item.offset = Buffer.byteLength(body);
    item.length = Buffer.byteLength(text);
    item.digest = digestBytes(text);
    body += text;
  }
  writePage(f, snapshotId, body);
  writePage(f, directoryId, canonicalJson(entries));
  resealProposal(f, entries);
}

for (const change of [
  "a missing release",
  "a missing record",
  "a missing tombstone",
  "a missing receipt",
  "a missing witness",
  "an altered record",
  "an extra record",
  "a pointer to another key with identical value bytes",
]) {
  test(
    `v3 checkpoint refuses ${change} in staged pages and preserves the source`,
    () =>
      withFixture(async (f) => {
        await populate(f);
        const before = await view(f);
        const source = active(f);
        const log = commits(f);
        const initialLease = (JSON.parse(log[1]!.body) as Json).lease;
        let readStagedPages = false;
        let attemptedSwitch = false;
        const executeSql = f.storage.sql.exec.bind(f.storage.sql);
        afterSync(f, 1, () => {
          changedPages(f, change, initialLease);
          f.storage.sql.exec = (statement, ...bindings) => {
            readStagedPages ||= statement.includes(
              "FROM cloud_v3_checkpoint_pages",
            );
            attemptedSwitch ||= statement.includes("AND seal=? AND body=?");
            return executeSql(statement, ...bindings);
          };
        });
        const result = await checkpoint(f);
        f.storage.sql.exec = executeSql;
        expect(result).toEqual({
          status: 503,
          body: {
            ok: false,
            error: {
              code: "UNAVAILABLE",
              message: "Cloud v3 checkpoint cannot be verified within one turn",
              retry: "never",
            },
          },
        });
        expect({ readStagedPages, attemptedSwitch }).toEqual({
          readStagedPages: true,
          attemptedSwitch: false,
        });
        expect(stagingTables(f)).toEqual([]);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
        expect((await checkpoint(f)).status).toBe(200);
        f.restart();
        expect((await view(f)).image).toEqual(before.image);
      }),
    timeout,
  );
}

async function appendNotes(f: Fixture, count: number) {
  for (let sent = 0; sent < count; sent += 100) {
    const batch = Array.from({ length: Math.min(100, count - sent) }, frame);
    expect((await append(f, ...batch)).status).toBe(200);
  }
}

for (const size of [13, 1024]) {
  test(
    `v3 checkpoint drains ${size} uncovered commands within the read budget`,
    () =>
      withFixture(async (f) => {
        const admitted = Math.min(size, 1020);
        await appendNotes(f, admitted);
        for (let sequence = admitted + 1; sequence <= size; sequence++)
          insertLegacyRow(f, sequence, noteBody(frame(), sequence));
        if (admitted !== size) f.restart();
        const { image } = await view(f);
        const cut = await prefix(f, 0, size);
        expect(cut).toBeLessThan(size);
        await expectWarmAndCold(f, image);
        await drain(f, cut, size);
        expect(f.alarms).toEqual([]);
        await expectWarmAndCold(f, image);
      }),
    timeout,
  );
}

test(
  "v3 checkpoint frees admission capacity after one prefix",
  () =>
    withFixture(async (f) => {
      await appendNotes(f, 1020);
      const effects = f.observeEffects();
      expect(await append(f, frame())).toMatchObject({
        status: 503,
        body: { ok: false, error: historyFull },
      });
      expect(effects()).toEqual(noWrites);
      await prefix(f, 0, 1020);
      expect((await append(f, frame())).status).toBe(200);
      expect(commits(f).at(-1)?.sequence).toBe(1021);
    }),
  timeout,
);

test(
  "v3 checkpoint preserves authority and record transitions across prefixes",
  () =>
    withFixture(async (f) => {
      await appendNotes(f, 10);
      await populate(f);
      const db = writableStore(f.storage);
      const before = recovered(db, f.seal());
      const cut = await prefix(f, 0, before.head);
      expect(cut).toBeGreaterThanOrEqual(11);
      expect(cut).toBeLessThan(before.head);
      await expectWarmAndCold(f, viewV3(before).image);
      await drain(f, cut, before.head);
      const after = recovered(db, f.seal());
      expect(after.root.eventWatermark).toBe(before.eventWatermark);
      expect(after.recordFloor).toBe(before.recordFloor);
      await expectWarmAndCold(f, viewV3(before).image);
    }),
  timeout,
);

test(
  "v3 checkpoint leaves a malformed suffix for full recovery and rejects its prefix",
  () =>
    withFixture(async (f) => {
      await appendNotes(f, 13);
      f.db.run("UPDATE cloud_v3_commits SET body='{}' WHERE sequence=13");
      f.restart();
      expect(await f.send(probe)).toMatchObject(refused);
      await prefix(f, 0, 13);
      expect(await f.send(probe)).toMatchObject(refused);
      const effects = f.observeEffects();
      expect(await checkpoint(f)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 checkpoint covers only the prefix that fits its raw byte budget",
  () =>
    typedFixture(async (f) => {
      await createTurnRows(f, [60_000, 60_000]);
      await typedFixture(async (donor) => {
        await createTurnRows(donor, [1, 1, 65_536]);
        insertLegacyRow(f, 3, commits(donor).at(-1)!.body);
      });
      f.restart();
      const rows = commits(f);
      const lengths = rows.map(({ body }) => Buffer.byteLength(body));
      const [first, second, third] = [181_126, 181_126, 197_734] as const;
      expect(lengths).toEqual([first, second, third]);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(first + second).toBeLessThanOrEqual(512 * 1024);
      expect(first + second + third).toBeGreaterThan(512 * 1024);
      const projected: ReturnType<typeof pages> = [];
      await typedFixture(async (sibling) => {
        await createTurnRows(sibling, [60_000, 60_000]);
        expect(commits(sibling)).toEqual(rows.slice(0, 2));
        expect(await prefix(sibling, 0, 2)).toBe(2);
        projected.push(...pages(sibling));
      });
      expect(projected.map(({ id }) => id)).toEqual([
        "directory:0",
        "snapshot:0",
        "transcript:0",
      ]);
      for (const { body } of projected)
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PAGE_BYTES);

      const { image } = await view(f);
      const reads = observeTurnReads(f);
      expect(await prefix(f, 0, 3)).toBe(2);
      expect(reads).toEqual([
        [
          [1, first, first, []],
          [2, second, second, []],
          [3, null, third, []],
        ],
        [
          [1, first, undefined, []],
          [2, second, undefined, []],
        ],
        [],
      ]);
      expect(pages(f)).toEqual(projected);
      expect(commits(f)).toEqual(rows.slice(2));
      await expectWarmAndCold(f, image);
    }),
  timeout,
);

async function createTurnRows(f: Fixture, lengths: readonly number[]) {
  for (const [i, size] of lengths.entries()) {
    const reply = await typed(f, sizedCreate(`turn-${i}`, "x".repeat(size)));
    ok(reply);
    expect(exited(reply)).toBe(0);
  }
}

function observeTurnReads(f: Fixture) {
  const reads: [unknown, unknown, unknown, string[]][][] = [];
  const sql = f.storage.sql;
  const query = sql.exec.bind(sql);
  sql.exec = (statement, ...bindings) => {
    const result = query(statement, ...bindings);
    if (
      !/^SELECT\b/i.test(statement) ||
      !statement.includes("cloud_v3_commits") ||
      !/\bbody\b/i.test(statement)
    )
      return result;
    const rows = result.toArray();
    reads.push(
      rows.map(({ sequence, body, bytes, mac: _mac, ...other }) => [
        sequence,
        typeof body === "string" ? Buffer.byteLength(body) : body,
        bytes,
        Object.keys(other),
      ]),
    );
    return { toArray: () => rows };
  };
  return reads;
}

test(
  "v3 checkpoint refuses a legacy oversized first row without returning its body",
  () =>
    withFixture(async (f) => {
      ok(await append(f, frame()));
      expect(await prefix(f, 0, 1)).toBe(1);
      const body = noteBody(paddedNote(512 * 1024 + 1, 2), 2);
      f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
        2,
        body,
        f.sign(2, body),
      ]);
      f.restart();
      const before = { active: active(f), commits: commits(f) };
      expect(before.commits.map(({ body }) => Buffer.byteLength(body))).toEqual(
        [524_289],
      );
      const reads = observeTurnReads(f);
      const effects = f.observeEffects();
      const reply = await checkpoint(f);
      expect(reply).toMatchObject(refused);
      expect(reply.body).toMatchObject({
        error: {
          message: "Cloud v3 checkpoint cannot be verified within one turn",
          retry: "never",
        },
      });
      expect(exited(reply)).toBe(1);
      expect(effects()).toEqual(noWrites);
      expect(
        reads.map((rows) => rows.map(([sequence, body]) => [sequence, body])),
      ).toEqual([[[2, null]]]);
      expect({ active: active(f), commits: commits(f) }).toEqual(before);
      expect(stagingTables(f)).toEqual([]);
    }),
  timeout,
);

function insertLegacyRow(f: Fixture, sequence: number, body: string) {
  f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
    sequence,
    body,
    f.sign(sequence, body),
  ]);
}

const historyFull = {
  code: "STORAGE_LIMIT_EXCEEDED",
  message:
    "This project's history is full. Ordinary writes are refused to keep room to release leases, stop lanes and restore.",
  retry: "never",
};

const noteBody = (note: Json, sequence: number) =>
  canonicalJson({ ...note, format: "forge-cloud-commit/3", sequence });

function paddedNote(bytes: number, sequence: number, pad = "x") {
  const note = { ...frame(), events: [{ pad: "" }] };
  const remaining = bytes - Buffer.byteLength(noteBody(note, sequence));
  const unitBytes = Buffer.byteLength(pad);
  note.events[0]!.pad =
    pad.repeat(Math.floor(remaining / unitBytes)) +
    "x".repeat(remaining % unitBytes);
  expect(Buffer.byteLength(noteBody(note, sequence))).toBe(bytes);
  return note;
}

const oversizedWrite = {
  code: "STORAGE_LIMIT_EXCEEDED",
  message: "This write is too large to keep in the project's history",
  retry: "never",
};

const frameWriters: Record<string, typeof appendFrameBatch> = {
  append: appendFrameBatch,
  appendV3Frames: (db, seal, image, batch) =>
    appendProbeBatch(db, seal, batch, () => image),
};

for (const [name, write] of Object.entries(frameWriters)) {
  test(
    `${name} refuses a frame at the raw byte cap and admits one at the history limit`,
    () =>
      withFixture((f) => {
        const db = writableStore(f.storage);
        const seal = f.seal();
        const image = recovered(db, seal);
        const effects = f.observeEffects();
        expect(() =>
          write(db, seal, image, [paddedNote(PAGE_BYTES, 1)]),
        ).toThrow(expect.objectContaining({ error: historyFull }));
        expect(effects()).toEqual(noWrites);
        const room = PAGE_BYTES - 13_313 - 2;
        expect(write(db, seal, image, [paddedNote(room, 1)])).toEqual({
          head: 1,
        });
        expect(commits(f).map(({ body }) => Buffer.byteLength(body))).toEqual([
          room,
        ]);
      }),
    timeout,
  );

  for (const [batch, input, pad] of [
    [false, "a v3 frame", "x"],
    [true, "a batch with a v3 frame", "x"],
    [false, "a multibyte v3 frame", "é"],
  ] as const) {
    test(
      `${name} refuses ${input} one byte over the cap`,
      () =>
        withFixture((f) => {
          const db = writableStore(f.storage);
          const seal = f.seal();
          const image = recovered(db, seal);
          const state = () => ({
            active: active(f),
            commits: commits(f),
            stale: image.stale,
            staged: [...image.staged],
            head: image.head,
            tailBytes: image.tailBytes,
            recordFloor: image.recordFloor,
          });
          const sequence = batch ? 2 : 1;
          const oversized = paddedNote(PAGE_BYTES + 1, sequence, pad);
          if (pad === "é")
            expect(noteBody(oversized, sequence).length).toBeLessThan(
              PAGE_BYTES,
            );
          const before = state();
          const effects = f.observeEffects();
          let failure: unknown;
          try {
            write(db, seal, image, batch ? [frame(), oversized] : [oversized]);
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(ForgeFailure);
          expect(failure).toMatchObject({ error: oversizedWrite });
          expect(effects()).toEqual(noWrites);
          expect(state()).toEqual(before);
          expect(write(db, seal, image, [frame()])).toEqual({
            head: before.head + 1,
          });
          expect(commits(f).map(({ sequence }) => sequence)).toEqual([
            before.head + 1,
          ]);
        }),
      timeout,
    );
  }
}

const sizedCreate = (requestId: string, body: string) => ({
  ...createBody,
  requestId,
  input: { ...createBody.input, body },
});

test(
  "v3 rejects an oversized escaped create and leaves the request unrecorded on retry",
  async () => {
    await typedFixture(async (sibling) => {
      const reply = await typed(sibling, sizedCreate("small-sibling", "x"));
      ok(reply);
      expect(exited(reply)).toBe(0);
    });
    await typedFixture(async (f) => {
      const db = writableStore(f.storage);
      const request = sizedCreate("escaped-create", "\u0001".repeat(65_536));
      const id = `c2:${digestValue([2, "command", ["owner", "owner-a", "owner-a"], request.requestId]).slice(7)}`;
      const before = await view(f);
      const { recordFloor } = recovered(db, f.seal());
      for (let attempt = 0; attempt < 2; attempt++) {
        const effects = f.observeEffects();
        const reply = await typed(f, request);
        expect(reply.status).toBe(503);
        expect(reply.body).toMatchObject({ ok: false, error: oversizedWrite });
        expect(exited(reply)).toBe(1);
        expect(effects()).toEqual(noWrites);
        expect(commits(f)).toEqual([]);
        const image = recovered(db, f.seal());
        expect(image.entries.outcome.has(id)).toBe(false);
        expect(image.recordFloor).toBe(recordFloor);
        expect(await view(f)).toEqual(before);
      }
    });
  },
  timeout,
);

test(
  "v3 checkpoints a create with a maximum-length ASCII body",
  () =>
    typedFixture(async (f) => {
      const reply = await typed(
        f,
        sizedCreate("ascii-ceiling", "x".repeat(65_536)),
      );
      ok(reply);
      expect(exited(reply)).toBe(0);
      const rows = commits(f);
      expect(rows).toHaveLength(1);
      expect(Buffer.byteLength(rows[0]!.body)).toBeLessThanOrEqual(PAGE_BYTES);
      const { image } = await view(f);
      expect(await prefix(f, 0, 1)).toBe(1);
      expect(commits(f)).toEqual([]);
      for (const { body } of pages(f))
        expect(Buffer.byteLength(body)).toBeLessThanOrEqual(PAGE_BYTES);
      await expectWarmAndCold(f, image);
    }),
  timeout,
);

test(
  "the checkpoint route writes nothing on normal project serving",
  () =>
    withFixture(async (f) => {
      const before = f.snapshot();
      f.restart(false);
      expect(await checkpoint(f)).toMatchObject({
        status: 404,
        body: { ok: false, error: { code: "UNKNOWN_COMMAND" } },
      });
      expect(f.snapshot()).toEqual(before);
    }),
  timeout,
);

const leaseRequest = (route: string, owner: string, input: Json) =>
  [
    `${probe}/${route}`,
    {
      subject: "work-1",
      holder: { ...holder, session: { ...holder.session, device: owner } },
      ...input,
    },
    {
      "X-Forge-Owner": owner,
      "X-Forge-Owner-Expires": String(E1 + HOUR),
    },
  ] as const;
const sendLease = (f: Fixture, route: string, owner: string, input: Json) =>
  f.send(...leaseRequest(route, owner, input));

const leaseClaim = (f: Fixture, owner: string) =>
  sendLease(f, "claim", owner, { requestId: owner, ttlMs: HOUR });

function changeCommit(
  f: Fixture,
  sequence: number,
  edit: (body: Json) => Json,
) {
  const { body } = commits(f).find((row) => row.sequence === sequence)!;
  f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=?", [
    canonicalJson(edit(JSON.parse(body) as Json)),
    sequence,
  ]);
}

for (const [fault, corrupt] of [
  [
    "changed after-image",
    () => ({
      ...putRecord("r2", 2, "next"),
      changes: putRecord("r2", 2, "other").changes,
    }),
  ],
  [
    "wrong operation",
    () => ({
      ...deleteRecord("r2", 2),
      changes: putRecord("r2", 2, "next").changes,
    }),
  ],
  ["repeated revision", () => putRecord("r2", 1, "next")],
  [
    "reissued number below the tombstone floor",
    () => putRecord("r1", 1, "next"),
  ],
] as const) {
  test(
    `v3 checkpoint refuses a record frame with ${fault}`,
    () =>
      withFixture(async (f) => {
        expect((await append(f, putRecord("r2", 1, "first"))).status).toBe(200);
        const belowFloor =
          fault === "reissued number below the tombstone floor";
        if (belowFloor) {
          expect((await append(f, deleteRecord("r2", 2))).status).toBe(200);
          expect((await checkpoint(f)).status).toBe(200);
        }
        const next = belowFloor
          ? putRecord("r3", 1, "next")
          : putRecord("r2", 2, "next");
        expect((await append(f, next)).status).toBe(200);
        changeCommit(f, belowFloor ? 3 : 2, (stored) => ({
          ...stored,
          ...corrupt(),
        }));
        f.restart();
        const source = active(f);
        const log = commits(f);
        const effects = f.observeEffects();
        expect(await checkpoint(f)).toMatchObject(refused);
        expect(await f.send(probe)).toMatchObject(refused);
        expect(effects()).toEqual(noWrites);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
      }),
    timeout,
  );
}

function generation(frame: Json, next: number): Json {
  return {
    ...frame,
    lease: { ...(frame.lease as Json), generation: next },
    witness: { ...(frame.witness as Json), generation: next },
  };
}

for (const fault of [
  "skipped generation",
  "repeated generation",
  "release by a different holder",
  "takeover before expiry",
  "wrong refusal body",
] as const) {
  test(
    `v3 checkpoint refuses a ${fault} in the source transcript`,
    () =>
      withFixture(async (f) => {
        expect((await leaseClaim(f, "owner-a")).status).toBe(200);
        if (fault === "skipped generation") {
          changeCommit(f, 1, (frame) => generation(frame, 2));
        } else if (fault === "release by a different holder") {
          expect(
            (
              await sendLease(f, "release", "owner-a", {
                requestId: "release-a",
                generation: 1,
              })
            ).status,
          ).toBe(200);
          changeCommit(f, 2, (frame) => {
            const outcome = frame.outcome as Json;
            const lease = frame.lease as Json;
            const fingerprint = JSON.parse(String(outcome.fingerprint)) as Json;
            const previousHolder = lease.holder as Json;
            const wrongHolder = {
              ...previousHolder,
              session: { ...(previousHolder.session as Json), device: "other" },
            };
            return {
              ...frame,
              lease: { ...lease, holder: wrongHolder },
              outcome: {
                ...outcome,
                fingerprint: canonicalJson({
                  ...fingerprint,
                  holder: wrongHolder,
                }),
              },
            };
          });
        } else if (fault === "wrong refusal body") {
          expect((await leaseClaim(f, "owner-b")).status).toBe(409);
          changeCommit(f, 2, (frame) => {
            const outcome = frame.outcome as Json;
            return {
              ...frame,
              outcome: {
                ...outcome,
                result: {
                  ...(outcome.result as Json),
                  message: "A different refusal",
                },
              },
            };
          });
        } else {
          setSystemTime(T0 + HOUR + 1);
          expect((await leaseClaim(f, "owner-b")).status).toBe(200);
          changeCommit(f, 2, (frame) =>
            fault === "repeated generation"
              ? generation(frame, 1)
              : {
                  ...frame,
                  time: T0 + 1,
                  lease: {
                    ...(frame.lease as Json),
                    expiresAt: new Date(T0 + HOUR + 1).toISOString(),
                  },
                },
          );
        }
        f.restart();
        const source = active(f);
        const log = commits(f);
        expect(await checkpoint(f)).toMatchObject(refused);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
      }),
    timeout,
  );
}

test(
  "v3 record batches retain the updated tombstone and floor after checkpoint recovery",
  () =>
    withFixture(async (f) => {
      const frames = [
        putRecord("r2", 1, "first"),
        putRecord("r2", 2, "next"),
        deleteRecord("r2", 3),
      ];
      const effects = f.observeEffects();
      const empty = f.snapshot();
      expect(await append(f, frames[0]!, frames[0]!)).toMatchObject({
        status: 400,
        body: { ok: false, error: { code: "INPUT_INVALID" } },
      });
      expect(effects()).toEqual(noWrites);
      expect(f.snapshot()).toEqual(empty);
      expect((await append(f, ...frames)).status).toBe(200);
      const { image } = await view(f);
      expect(image.record).toEqual({
        r2: digestBytes(canonicalJson([3, null])),
      });
      expect((await checkpoint(f)).status).toBe(200);
      expect(commits(f)).toEqual([]);
      f.restart();
      await expectCut(f, 1, 3, image);
      const sealed = f.snapshot();
      expect(await append(f, putRecord("r1", 1, "old"))).toMatchObject({
        status: 400,
        body: { ok: false, error: { code: "INPUT_INVALID" } },
      });
      expect(await append(f, putRecord("r2", 4, "reused"))).toMatchObject({
        status: 400,
        body: { ok: false, error: { code: "INPUT_INVALID" } },
      });
      expect(f.snapshot()).toEqual(sealed);
      expect((await append(f, putRecord("r3", 1, "new"))).status).toBe(200);
    }),
  timeout,
);

test(
  "v3 checkpoint refuses a release written with an expired token deadline",
  () =>
    withFixture(async (f) => {
      expect((await leaseClaim(f, "owner-a")).status).toBe(200);
      expect(
        (
          await sendLease(f, "release", "owner-a", {
            requestId: "release-a",
            generation: 1,
          })
        ).status,
      ).toBe(200);
      changeCommit(f, 2, (frame) => ({
        ...frame,
        outcome: { ...(frame.outcome as Json), retryUntil: 0 },
      }));
      f.restart();
      const source = active(f);
      const log = commits(f);
      const effects = f.observeEffects();
      expect(await checkpoint(f)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(active(f)).toEqual(source);
      expect(commits(f)).toEqual(log);
    }),
  timeout,
);

test(
  "v3 checkpoint refuses a rehashed archive with the wrong refusal digest",
  () =>
    withFixture(async (f) => {
      expect((await leaseClaim(f, "owner-a")).status).toBe(200);
      expect((await leaseClaim(f, "owner-b")).status).toBe(409);
      expect((await checkpoint(f)).status).toBe(200);

      const id = "transcript:0";
      const page = pages(f).find((row) => row.id === id)!;
      const history = JSON.parse(page.body) as Json[];
      const refusal = history[1]!.outcome as Json;
      expect(refusal.resultDigest).toEqual(expect.any(String));
      const transcript = canonicalJson(
        history.with(1, {
          ...history[1],
          outcome: { ...refusal, resultDigest: digestBytes("wrong refusal") },
        }),
      );
      const hash = digestBytes(transcript);
      const manifest = JSON.parse(root(f).body) as { pages: Json[] };
      const updated = canonicalJson({
        ...manifest,
        transcriptDigest: hash,
        pages: manifest.pages.map((entry) =>
          entry.id === id ? { ...entry, hash } : entry,
        ),
      });
      f.db.run("UPDATE cloud_v3_pages SET body=? WHERE id=?", [transcript, id]);
      f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
        updated,
        trustedSeal(f.db, updated),
      ]);
      f.restart();
      const source = active(f);
      expect(await checkpoint(f)).toMatchObject(refused);
      expect(active(f)).toEqual(source);
      expect(commits(f)).toEqual([]);
    }),
  timeout,
);

test(
  "v3 checkpoint verifies a renewed lease and an expired takeover from sealed state",
  () =>
    withFixture(async (f) => {
      expect((await leaseClaim(f, "owner-a")).status).toBe(200);
      expect((await checkpoint(f)).status).toBe(200);
      f.restart();

      setSystemTime(T0 + 1);
      expect(
        (
          await sendLease(f, "renew", "owner-a", {
            requestId: "renew-a",
            generation: 1,
            ttlMs: HOUR,
          })
        ).status,
      ).toBe(200);
      expect((await leaseClaim(f, "owner-b")).status).toBe(409);
      setSystemTime(T0 + HOUR + 2);
      expect(
        await sendLease(f, "claim", "owner-b", {
          requestId: "takeover-b",
          ttlMs: HOUR,
        }),
      ).toMatchObject({ status: 200, body: { value: { generation: 2 } } });

      const { image } = await view(f);
      f.restart();
      const { rows, bytes } = f.reads;
      expect((await checkpoint(f)).status).toBe(200);
      const reads = { rows: f.reads.rows - rows, bytes: f.reads.bytes - bytes };
      console.log("v3 checkpoint sealed lease replay reads", reads);
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(4 * MiB);
      expect(commits(f)).toEqual([]);
      f.restart();
      await expectCut(f, 2, 4, image);
    }),
  timeout,
);

for (const fault of [
  "empty subject",
  "oversized subject",
  "missing holder device",
  "holder device outside the receipt scope",
  "extra fingerprint scope field",
] as const) {
  test(
    `v3 checkpoint refuses a pre-admission frame with ${fault}`,
    () =>
      withFixture(async (f) => {
        const requestId = "attempt";
        expect(
          await sendLease(f, "claim", "owner-a", {
            requestId,
            subject: "",
            ttlMs: HOUR,
          }),
        ).toMatchObject({
          status: 400,
          body: { error: { message: "subject must be a non-empty string" } },
        });
        if (fault === "oversized subject")
          expect(
            await sendLease(f, "claim", "owner-a", {
              requestId,
              subject: "a".repeat(9000),
              ttlMs: HOUR,
            }),
          ).toMatchObject({
            status: 400,
            body: { error: { message: "body is over 8192 bytes" } },
          });
        expect(commits(f)).toEqual([]);
        expect(
          await sendLease(f, "claim", "owner-a", {
            requestId,
            subject: "a".repeat(501),
            ttlMs: HOUR,
          }),
        ).toMatchObject({
          status: 400,
          body: { error: { message: "Key must contain 1 to 500 characters" } },
        });
        changeCommit(f, 1, (frame) => {
          const outcome = frame.outcome as Json;
          const fingerprint = JSON.parse(String(outcome.fingerprint)) as Json;
          const changes = {
            "empty subject": { subject: "" },
            "oversized subject": { subject: "a".repeat(9000) },
            "missing holder device": { holder },
            "holder device outside the receipt scope": {
              holder: {
                ...holder,
                session: { ...holder.session, device: "other" },
              },
            },
            "extra fingerprint scope field": {
              scope: { ...(fingerprint.scope as Json), family: "lease" },
            },
          };
          return {
            ...frame,
            outcome: {
              ...outcome,
              fingerprint: canonicalJson({ ...fingerprint, ...changes[fault] }),
            },
          };
        });
        f.restart();
        const source = active(f);
        const log = commits(f);
        const effects = f.observeEffects();
        expect(await checkpoint(f)).toMatchObject(refused);
        expect(effects()).toEqual(noWrites);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
      }),
    timeout,
  );
}

test(
  "v3 lease admission refuses an invalid device assigned by the test probe",
  () =>
    withFixture(async (f) => {
      const effects = f.observeEffects();
      expect(
        await sendLease(f, "claim", "", {
          requestId: "attempt",
          subject: "a".repeat(501),
          holder,
          ttlMs: HOUR,
        }),
      ).toMatchObject({
        status: 400,
        body: { error: { message: "Lease holder has an invalid device" } },
      });
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 checkpoint accepts a refusal from the smallest 8192-byte lease request",
  () =>
    withFixture(async (f) => {
      const minimal = JSON.stringify({
        subject: "",
        holder,
        requestId: "a",
        ttlMs: 1e20,
      }).replace('"ttlMs":100000000000000000000', '"ttlMs":1e20');
      const subject = "!".repeat(8192 - Buffer.byteLength(minimal));
      const body = Buffer.from(minimal.replace('""', JSON.stringify(subject)));
      body[body.indexOf("!")] = 0xff;
      expect(body.byteLength).toBe(8192);
      const project = new Project(f.context, f.env);
      const response = await project.fetch(
        new Request(`https://fixture.example/p/a/${probe}/claim`, {
          method: "POST",
          body: new Blob([new Uint8Array(body)]),
          headers: {
            "X-Forge-Owner": "owner-a",
            "X-Forge-Owner-Expires": String(E1 + HOUR),
          },
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: { message: "ttlMs must be a positive safe integer" },
      });
      expect(commits(f)).toHaveLength(1);
      f.restart();
      expect((await checkpoint(f)).status).toBe(200);
      expect(commits(f)).toEqual([]);
    }),
  timeout,
);

const portableHistory = async (source: Fixture) => {
  await populate(source);
  expect((await append(source, frame())).status).toBe(200);
  expect((await checkpoint(source)).status).toBe(200);
  const transcript = pages(source).find(({ id }) => id === "transcript:0")!;
  const frames = JSON.parse(transcript.body) as Json[];
  frames[5] = { sequence: 6 };
  return frames;
};

function replayPortable(target: Fixture, frames: readonly unknown[]) {
  const portableTranscript = canonicalJson(frames);
  const verification = {
    admit: Project.admitLeaseRequest,
    manifest: verifiedPortable(target.seal(), portableTranscript),
    portableTranscript,
  };
  return recoverV3(writableStore(target.storage), target.seal(), verification);
}

test(
  "v3 portable replay reconstructs the public projection from genesis",
  () =>
    withFixture(async (source) => {
      const frames = await portableHistory(source);
      const expected = recovered(writableStore(source.storage), source.seal());
      await withFixture((target) => {
        const effects = target.observeEffects();
        const replayed = replayPortable(target, frames);
        expect(viewV3(replayed).image).toEqual(viewV3(expected).image);
        expect(replayed.recordFloor).toBe(expected.recordFloor);
        expect(effects()).toEqual(noWrites);
      });
    }),
  timeout,
);

test(
  "v3 portable replay accepts a page with more than 1024 commands",
  () =>
    withFixture(async (source) => {
      await populate(source);
      const start = commits(source).length;
      expect((await checkpoint(source)).status).toBe(200);
      for (let count = start; count < 1025; count += 12) {
        const batch = Array.from({ length: Math.min(12, 1025 - count) }, frame);
        expect((await append(source, ...batch)).status).toBe(200);
        do {
          expect((await checkpoint(source)).status).toBe(200);
        } while (commits(source).length > 0);
      }
      const native = pages(source).find(
        ({ id }) => id === "transcript:0",
      )!.body;
      const history = JSON.parse(native) as Json[];
      expect(history).toHaveLength(1025);
      expect(Buffer.byteLength(native)).toBeLessThanOrEqual(PAGE_BYTES);
      expect(commits(source)).toEqual([]);
      const frames = history.map((entry) =>
        entry.operation === "fixture.note"
          ? { sequence: entry.sequence }
          : entry,
      );
      const expected = recovered(writableStore(source.storage), source.seal());
      expect(expected.head).toBe(1025);
      await withFixture((target) => {
        const replayed = replayPortable(target, frames);
        expect(viewV3(replayed).image).toEqual(viewV3(expected).image);
        expect(replayed.recordFloor).toBe(expected.recordFloor);
      });
    }),
  timeout,
);

test(
  "v3 portable replay keeps the live frame depth limit",
  () =>
    withFixture(async (source) => {
      const recordAtDepth = (depth: number) => {
        const value: unknown = JSON.parse(
          "[".repeat(depth) + "0" + "]".repeat(depth),
        );
        return putRecord("r1", 1, value);
      };
      expect((await append(source, recordAtDepth(60))).status).toBe(200);
      expect((await checkpoint(source)).status).toBe(200);
      const native = pages(source).find(
        ({ id }) => id === "transcript:0",
      )!.body;
      const frames = JSON.parse(native) as Json[];
      const expected = recovered(writableStore(source.storage), source.seal());
      await withFixture((target) => {
        const replayed = replayPortable(target, frames);
        expect(viewV3(replayed).image).toEqual(viewV3(expected).image);
        const deeper = { ...frames[0], ...recordAtDepth(61) };
        expect(() => replayPortable(target, [deeper])).toThrow(ForgeFailure);
      });
    }),
  timeout,
);

for (const [fault, edit] of [
  [
    "private frame",
    (frames: Json[]) => {
      frames[5]!.private = { approval: "fixture-only" };
    },
  ],
  [
    "sequence gap",
    (frames: Json[]) => {
      frames[5] = { sequence: 7 };
    },
  ],
  [
    "repeated marker",
    (frames: Json[]) => {
      frames[5] = { sequence: 5 };
    },
  ],
  [
    "changed record after-image",
    (frames: Json[]) => {
      (frames[0]!.changes as Json[])[0]!.value = {
        revision: 1,
        value: { text: "tampered" },
      };
    },
  ],
  [
    "altered refusal digest",
    (frames: Json[]) => {
      (frames[2]!.outcome as Json).resultDigest =
        digestBytes("different refusal");
    },
  ],
] as const) {
  test(
    `v3 portable replay refuses a ${fault}`,
    () =>
      withFixture(async (source) => {
        const frames = await portableHistory(source);
        edit(frames);
        await withFixture((target) => {
          const effects = target.observeEffects();
          expect(() => replayPortable(target, frames)).toThrow(ForgeFailure);
          expect(effects()).toEqual(noWrites);
        });
      }),
    timeout,
  );
}

test(
  "live v3 writes and recovery refuse an archived refusal",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const before = f.observeEffects();
      const frame = JSON.parse(commits(f)[2]!.body) as Json;
      const { result, ...outcome } = frame.outcome as Json;
      const archived = {
        ...outcome,
        resultDigest: digestBytes(canonicalJson(result)),
      };
      const attempted = {
        operation: frame.operation,
        time: frame.time,
        events: frame.events,
        outcome: archived,
      };
      expect(await append(f, attempted)).toMatchObject({ status: 400 });
      expect(before()).toEqual(noWrites);
      changeCommit(f, 3, (stored) => ({ ...stored, outcome: archived }));
      f.restart();
      expect(await f.send(probe)).toMatchObject(refused);
    }),
  timeout,
);

type Portable = {
  pages: { id: string; body: string }[];
  head: number;
  eventWatermark: number;
  recordFloor: number;
  publicDigest: string;
  source: string;
};

async function withPortable(
  run: (
    target: Fixture,
    data: Portable,
    source: Fixture,
  ) => void | Promise<void>,
  extra = 0,
) {
  const target = guardFixture();
  try {
    await withFixture(async (source) => {
      let transcript = await portableHistory(source);
      for (let i = 0; i < extra; i++) {
        expect(
          await sendLease(source, "claim", "owner-a", {
            subject: `work-${i + 2}`,
            requestId: `extra-${i}`,
            ttlMs: i === 0 ? 1 : HOUR,
          }),
        ).toMatchObject({ status: 200 });
      }
      if (extra > 0) {
        await drain(source, transcript.length, transcript.length + extra);
        transcript = JSON.parse(
          pages(source).find(({ id }) => id === "transcript:0")!.body,
        ) as Json[];
        transcript[5] = { sequence: 6 };
      }
      const manifest = JSON.parse(root(source).body) as {
        coveredHead: number;
        eventWatermark: number;
        publicDigest: string;
      };
      const data = {
        pages: pages(source).map((page) =>
          page.id === "transcript:0"
            ? { ...page, body: canonicalJson(transcript) }
            : page,
        ),
        head: manifest.coveredHead,
        eventWatermark: manifest.eventWatermark,
        recordFloor: 3,
        publicDigest: manifest.publicDigest,
        source: String(source.context.id),
      };
      await run(target, data, source);
    });
  } finally {
    target.db.close();
  }
}

function editHistory(data: Portable, edit: (frames: Json[]) => void) {
  const page = data.pages.find(({ id }) => id === "transcript:0")!;
  const frames = JSON.parse(page.body) as Json[];
  edit(frames);
  page.body = canonicalJson(frames);
}

function editProjection(
  data: Portable,
  collection: string,
  key: string,
  edit: (body: string) => string,
) {
  const [directory, snapshot] = data.pages;
  const entries = JSON.parse(directory!.body) as DirectoryItem[];
  const item = entries.find(
    (e) => e.collection === collection && e.key === key,
  )!;
  const from = item.offset!;
  const to = from + item.length!;
  const original = Buffer.from(snapshot!.body);
  const replacement = Buffer.from(edit(original.subarray(from, to).toString()));
  expect(replacement.length).toBe(item.length!);
  snapshot!.body = Buffer.concat([
    original.subarray(0, from),
    replacement,
    original.subarray(to),
  ]).toString();
  item.digest = digestBytes(replacement);
  directory!.body = canonicalJson(entries);
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
}

function portableUpload(target: Fixture, { pages, ...projection }: Portable) {
  const manifest = trustedManifest(target.seal(), {
    ...projection,
    format: "forge-cloud-portable/4",
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
  });
  const digest = digestBytes(canonicalJson(manifest));
  return (page: number, member = pages[page] ?? pages[0]!, pin = digest) =>
    target.send(
      "restore",
      { page, ...member, ...(page === 0 && { manifest }) },
      page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
    );
}

const restoreResult = (page: number, verified = false) => ({
  status: 200,
  body: { ok: true, value: { page, verified } },
});
const restoreRefusal = {
  status: 400,
  body: { ok: false, error: { code: "RESTORE_INVALID_ROW" } },
};
const fullRestoreRefusal = {
  ...restoreRefusal,
  body: {
    ok: false,
    error: {
      ...restoreRefusal.body.error,
      message: "Cloud v3 portable restore could not be verified",
      retry: "never",
    },
  },
};
const restoreExit = (reply: { body: unknown }) =>
  exitCode(failed((reply.body as { error: ForgeError }).error));
const unprovisioned = async (target: Fixture) => {
  expect(await target.send("status")).toMatchObject({
    status: 200,
    body: { ok: true, value: { initialized: false } },
  });
  expect(tableNames(target)).not.toContain("cloud_v3_root");
  expect(tableNames(target)).not.toContain("cloud_v3_commits");
  expect(target.values.has("provisioned")).toBe(false);
};

test(
  "v3 restore verifies a public transcript and saves each staging result",
  () =>
    withPortable(async (target, data) => {
      const upload = portableUpload(target, data);
      const first = await upload(0);
      const second = await upload(1);
      target.restart();
      const firstRetry = await upload(0);
      const before = { ...target.reads };
      const verified = await upload(2);
      const reads = {
        rows: target.reads.rows - before.rows,
        bytes: target.reads.bytes - before.bytes,
      };
      target.restart();
      const finalRetry = await upload(2);
      expect(await target.send("status")).toMatchObject(stopped);
      expect([first, second, verified]).toMatchObject([
        restoreResult(0),
        restoreResult(1),
        restoreResult(2, true),
      ]);
      expect(firstRetry).toEqual(first);
      expect(finalRetry).toEqual(verified);
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(2 * MiB);
      console.log("v3 restore final verification reads", reads);
    }),
  timeout,
);

test(
  "v3 restore replays refused typed claims without writing",
  async () => {
    const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
    const source = guardFixture(env);
    const target = guardFixture(env);
    using _source = source.db;
    using _target = target.db;
    const claim = (f: Fixture, id: string) =>
      f.send(
        `${probe}/command`,
        {
          op: "issue.claim",
          requestId: `refused-claim-${id}`,
          input: { id },
          context: holder,
        },
        {
          "X-Forge-Owner": "owner-a",
          "X-Forge-Owner-Expires": String(E1),
        },
      );

    expect(await source.send(probe, {})).toMatchObject({ status: 200 });
    const missing = await claim(source, "forge-9");
    expect(missing).toMatchObject({
      status: 404,
      body: { ok: false, error: { code: "NOT_FOUND" } },
    });
    const record = { id: "work-1", status: "open", dependsOn: [] };
    expect(await append(source, putRecord("r1", 1, record))).toMatchObject({
      status: 200,
    });
    expect(
      await sendLease(source, "claim", "owner-a", {
        subject: "issue:work-1",
        requestId: "raw-held",
        ttlMs: HOUR,
      }),
    ).toMatchObject({ status: 200 });
    const held = await claim(source, "forge-1");
    expect(held).toMatchObject({
      status: 409,
      body: { ok: false, error: { code: "LEASE_HELD" } },
    });
    await drain(source, 0, 4);
    const { head, eventWatermark, recordFloor, root } = recovered(
      writableStore(source.storage),
      source.seal(),
    );
    const data = {
      pages: pages(source),
      head,
      eventWatermark,
      recordFloor,
      publicDigest: root.publicDigest as string,
      source: String(source.context.id),
    };
    const upload = await stageRestore(target, data);
    expect(await upload(2)).toMatchObject(restoreResult(2, true));
    expect(pages(target)).toEqual(data.pages);

    target.restart();
    const effects = target.observeEffects();
    expect(await claim(target, "forge-9")).toEqual(missing);
    expect(await claim(target, "forge-1")).toEqual(held);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "v3 restore refuses exact retries when staged bytes have changed",
  () =>
    withPortable(async (target, data) => {
      const upload = portableUpload(target, data);
      expect(await upload(0)).toMatchObject(restoreResult(0));
      expect(await upload(1)).toMatchObject(restoreResult(1));
      expect(await upload(2)).toMatchObject(restoreResult(2, true));

      expect(tableNames(target)).toContain("cloud_v3_pages");
      const overwrite = target.db.query(
        "UPDATE cloud_v3_pages SET body=? WHERE id=?",
      );
      const directory = data.pages[0]!;
      overwrite.run("[]", directory.id);
      target.restart();
      const directoryEffects = target.observeEffects();
      expect(await upload(0)).toMatchObject(restoreRefusal);
      expect(await upload(2)).toMatchObject(restoreRefusal);
      expect(directoryEffects()).toEqual(noWrites);

      overwrite.run(directory.body, directory.id);
      overwrite.run("[]", "transcript:0");
      target.restart();
      const transcriptEffects = target.observeEffects();
      expect(await upload(2)).toMatchObject(restoreRefusal);
      expect(transcriptEffects()).toEqual(noWrites);
    }),
  timeout,
);

for (const [fault, tamper] of [
  [
    "missing release",
    (data: Portable) => editHistory(data, (f) => (f[3] = { sequence: 4 })),
  ],
  [
    "missing tombstone",
    (data: Portable) => {
      data.eventWatermark--;
      editHistory(data, (f) => (f[4] = { sequence: 5 }));
    },
  ],
  [
    "missing receipt-only frame",
    (data: Portable) => editHistory(data, (f) => (f[2] = { sequence: 3 })),
  ],
  ["lower number floor", (data: Portable) => (data.recordFloor = 2)],
  [
    "lower generation floor",
    (data: Portable) =>
      editProjection(data, "lease", "work-1", (body) =>
        body.replace('"generation":1', '"generation":0'),
      ),
  ],
  [
    "rehashed after-image",
    (data: Portable) =>
      editProjection(data, "record", "r1", (body) =>
        body.replace("café", "tacé"),
      ),
  ],
  [
    "altered refusal digest",
    (data: Portable) =>
      editHistory(data, (f) => {
        (f[2]!.outcome as Json).resultDigest = digestBytes("different refusal");
      }),
  ],
  [
    "uploaded activation frame",
    (data: Portable) =>
      editHistory(data, (f) => {
        f[5] = {
          ...frame(),
          format: "forge-cloud-commit/3",
          sequence: 6,
          operation: "restore.activate",
        };
      }),
  ],
  [
    "private frame",
    (data: Portable) =>
      editHistory(data, (f) => {
        f[5]!.private = { approval: "fixture-only" };
      }),
  ],
] as const) {
  test(
    `v3 restore refuses ${fault}`,
    () =>
      withPortable(async (target, data) => {
        const tables = tableNames(target);
        const { kv } = target.snapshot();
        tamper(data);
        const upload = portableUpload(target, data);
        const replies = [await upload(0), await upload(1)];
        replies.push(await upload(2));
        await unprovisioned(target);
        expect(replies).toMatchObject([
          restoreResult(0),
          restoreResult(1),
          restoreRefusal,
        ]);
        expect(tableNames(target)).not.toContain("cloud_v3_restore");
        expect(tableNames(target)).toEqual(tables);
        expect(target.snapshot().kv).toEqual(kv);
      }),
    timeout,
  );
}

test(
  "v3 restore clears staging when verification refuses the final page",
  () =>
    withPortable(async (target, data) => {
      const tables = tableNames(target);
      const { kv } = target.snapshot();
      data.recordFloor = 2;
      const upload = await stageRestore(target, data);
      const reply = await upload(2);
      expect(reply).toMatchObject(restoreRefusal);
      expect(restoreExit(reply)).toBe(1);
      expect(tableNames(target)).not.toContain("cloud_v3_restore");
      await unprovisioned(target);
      expect(tableNames(target)).not.toContain("cloud_v3_pages");
      expect(tableNames(target)).toEqual(tables);
      expect(target.snapshot().kv).toEqual(kv);
      expect(kv).toEqual([]);
    }),
  timeout,
);

test(
  "v3 restore accepts a different artifact after verification refuses the final page",
  () =>
    withPortable(async (target, data) => {
      const clean = guardFixture();
      using _clean = clean.db;
      const original = structuredClone(data);
      data.recordFloor = 2;
      const rejected = await stageRestore(target, data);
      expect(await rejected(2)).toMatchObject(restoreRefusal);

      const ids = [
        "cf314cbb-07ca-46e8-b45b-fbec8a88e083",
        "1be06559-e694-4a85-b13e-8ab79702d19a",
      ] as const;
      let id = 0;
      const random = spyOn(crypto, "randomUUID").mockImplementation(
        () => ids[id++ % ids.length]!,
      );
      try {
        const upload = portableUpload(target, original);
        expect(await upload(0)).toMatchObject(restoreResult(0));
        expect(await upload(1)).toMatchObject(restoreResult(1));
        id = 0;
        expect(await upload(2)).toMatchObject(restoreResult(2, true));
        expect(await target.send("status")).toMatchObject(stopped);

        const baseline = await stageRestore(clean, original);
        id = 0;
        expect(await baseline(2)).toMatchObject(restoreResult(2, true));
        const state = (f: Fixture) => {
          const { load: _load, ...image } = recovered(
            writableStore(f.storage),
            f.seal(),
          );
          return image;
        };
        expect(state(target)).toEqual(state(clean));
      } finally {
        random.mockRestore();
      }
    }),
  timeout,
);

test(
  "v3 restore keeps staged pages when other requests are refused before verification",
  () =>
    withPortable(async (target, data) => {
      const other = structuredClone(data);
      editHistory(other, (frames) => {
        frames[5] = { sequence: 6, private: {} };
      });
      expect(digestBytes(other.pages[2]!.body)).not.toBe(
        digestBytes(data.pages[2]!.body),
      );
      const upload = await stageRestore(target, data);
      const stray = portableUpload(target, other);
      const staged = target.snapshot();
      for (const send of [
        () => stray(0),
        () => upload(2, { id: "transcript:0", body: "[]" }),
        () => stray(2),
      ]) {
        const effects = target.observeEffects();
        const reply = await send();
        expect(reply).toMatchObject(restoreRefusal);
        expect(restoreExit(reply)).toBe(1);
        expect(effects()).toEqual(noWrites);
        expect(target.snapshot()).toEqual(staged);
      }
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
    }),
  timeout,
);

test.each(["before commit", "after commit"] as const)(
  "v3 restore keeps the original refusal if resetting staging fails %s",
  (phase) =>
    withPortable(async (target, data) => {
      const tables = tableNames(target);
      data.recordFloor = 2;
      const upload = await stageRestore(target, data);
      const staged = target.snapshot();
      const effects = target.observeEffects();
      const transact = target.storage.transactionSync.bind(target.storage);
      let resets = 0;
      const interruptReset = () => {
        if (tableNames(target).includes("cloud_v3_restore")) return;
        resets++;
        throw new Error("Injected restore reset failure");
      };
      target.storage.transactionSync = (body) => {
        const result = transact(() => {
          const value = body();
          if (phase === "before commit") interruptReset();
          return value;
        });
        if (phase === "after commit") interruptReset();
        return result;
      };
      let reply;
      try {
        reply = await upload(2);
      } finally {
        target.storage.transactionSync = transact;
      }
      expect(reply).toEqual(fullRestoreRefusal);
      expect(resets).toBe(1);
      expect(restoreExit(reply)).toBe(1);
      if (phase === "before commit") {
        expect(target.snapshot()).toEqual(staged);
        const retry = await upload(2);
        expect(retry).toEqual(reply);
        expect(restoreExit(retry)).toBe(1);
      }
      expect(tableNames(target)).not.toContain("cloud_v3_restore");
      expect(tableNames(target)).toEqual(tables);
      expect(target.snapshot().kv).toEqual(staged.kv);
      expect(effects().alarmWrites).toBe(0);
    }),
  timeout,
);

test(
  "v3 provision accepts a fresh target after a refused restore resets staging",
  () =>
    withPortable(async (target, data) => {
      const { kv } = target.snapshot();
      data.recordFloor = 2;
      const upload = await stageRestore(target, data);
      const reply = await upload(2);
      expect(reply).toMatchObject(restoreRefusal);
      expect(restoreExit(reply)).toBe(1);
      expect(target.snapshot().kv).toEqual(kv);

      expect(await target.send(probe, {})).toMatchObject({
        status: 200,
        body: { ok: true, value: { generation: 0, coveredHead: 0 } },
      });
      expect(tableNames(target)).toEqual([
        "cloud_v3_commits",
        "cloud_v3_pages",
        "cloud_v3_root",
      ]);
      expect(commits(target)).toEqual([]);
      expect(pages(target)).toEqual([
        { id: "directory:0", body: "[]" },
        { id: "transcript:0", body: "[]" },
      ]);
    }),
  timeout,
);

test(
  "v3 restore keeps staging if the verification read fails",
  () =>
    withPortable(async (target, data) => {
      const upload = await stageRestore(target, data);
      const staged = target.snapshot();
      const execute = target.storage.sql.exec.bind(target.storage.sql);
      let faulted = false;
      target.storage.sql.exec = (statement, ...bindings) => {
        if (
          !faulted &&
          statement.startsWith(
            "SELECT id, CASE WHEN length(CAST(body AS BLOB))",
          ) &&
          statement.includes("FROM cloud_v3_restore")
        ) {
          faulted = true;
          throw new ForgeFailure({
            code: "UNAVAILABLE",
            message: "Injected staged read failure",
            retry: "never",
          });
        }
        return execute(statement, ...bindings);
      };
      try {
        const reply = await upload(2);
        expect(reply).toEqual(fullRestoreRefusal);
        expect(restoreExit(reply)).toBe(1);
      } finally {
        target.storage.sql.exec = execute;
      }
      expect(faulted).toBe(true);
      expect(target.snapshot()).toEqual(staged);
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
    }),
  timeout,
);

test.each(["CREATE TABLE cloud_v3_root", "INSERT INTO cloud_v3_commits"])(
  "v3 restore keeps staging if activation storage refuses %s",
  (prefix) =>
    withPortable(async (target, data) => {
      const upload = await stageRestore(target, data);
      const staged = target.snapshot();
      const execute = target.storage.sql.exec.bind(target.storage.sql);
      const failure = new ForgeFailure({
        code: "STORAGE_LIMIT_EXCEEDED",
        message: "Injected activation storage refusal",
        retry: "never",
      });
      let faulted = false;
      target.storage.sql.exec = (statement, ...bindings) => {
        if (!faulted && statement.startsWith(prefix)) {
          faulted = true;
          throw failure;
        }
        return execute(statement, ...bindings);
      };
      try {
        expect(await upload(2)).toEqual({
          status: 503,
          body: { ok: false, error: failure.error },
        });
      } finally {
        target.storage.sql.exec = execute;
      }
      expect(faulted).toBe(true);
      expect(target.snapshot()).toEqual(staged);
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
    }),
  timeout,
);

test(
  "v3 restore keeps staging if the transaction replaces the verification refusal",
  () =>
    withPortable(async (target, data) => {
      const tables = [...tableNames(target), "cloud_v3_restore"];
      data.recordFloor = 2;
      const upload = await stageRestore(target, data);
      const staged = target.snapshot();
      const effects = target.observeEffects();
      const transact = target.storage.transactionSync.bind(target.storage);
      let replacement: ForgeFailure | undefined;
      target.storage.transactionSync = (body) => {
        try {
          return transact(body);
        } catch (error) {
          if (!(error instanceof ForgeFailure)) throw error;
          replacement = new ForgeFailure(error.error);
          throw replacement;
        }
      };
      try {
        const reply = await upload(2);
        expect(replacement).toBeInstanceOf(ForgeFailure);
        expect(reply).toMatchObject(restoreRefusal);
        expect(reply).toEqual({
          status: 400,
          body: { ok: false, error: replacement!.error },
        });
      } finally {
        target.storage.transactionSync = transact;
      }
      expect(target.snapshot()).toEqual(staged);
      expect(tableNames(target)).toEqual(tables);
      expect(effects()).toEqual({ ...noWrites, sqlWriteAttempts: 1 });
    }),
  timeout,
);

test(
  "v3 restore refuses bad pins, repeated members, skipped pages and extras",
  () =>
    withPortable(async (target, data) => {
      const upload = portableUpload(target, data);
      const duplicate = portableUpload(target, {
        ...data,
        pages: [data.pages[0]!, data.pages[0]!, data.pages[2]!],
      });
      const replies = [
        await upload(0, undefined, digestBytes("different manifest")),
        await duplicate(0),
        await upload(1),
        await upload(0),
        await upload(0, { ...data.pages[0]!, body: "[]" }),
        await upload(2),
        await upload(1, data.pages[0]),
        await upload(1),
        await upload(2),
        await upload(3),
      ];
      expect(replies).toMatchObject([
        restoreRefusal,
        restoreRefusal,
        restoreRefusal,
        restoreResult(0),
        restoreRefusal,
        restoreRefusal,
        restoreRefusal,
        restoreResult(1),
        restoreResult(2, true),
        restoreRefusal,
      ]);
    }),
  timeout,
);

test(
  "v3 staging keeps both project setup paths from provisioning the target",
  () =>
    withPortable(async (target, data) => {
      const upload = portableUpload(target, data);
      await unprovisioned(target);
      expect(await upload(0)).toMatchObject(restoreResult(0));
      target.restart();
      const effects = target.observeEffects();
      expect(await checkpoint(target)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(await target.send(probe, {})).toMatchObject({ status: 409 });
      expect(
        await target.send("devices", { device: "fixture", ttlMs: HOUR }),
      ).toMatchObject({ status: 409 });
      await unprovisioned(target);
    }),
  timeout,
);

const stopped = {
  status: 200,
  body: { ok: true, value: { initialized: true, stopped: true } },
};

async function stageRestore(target: Fixture, data: Portable) {
  const upload = portableUpload(target, data);
  expect(await upload(0)).toMatchObject(restoreResult(0));
  expect(await upload(1)).toMatchObject(restoreResult(1));
  await unprovisioned(target);
  return upload;
}

const typedEnv = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const missingUpdate = {
  op: "issue.update",
  requestId: "restored-update",
  input: { id: "forge-9", expectRevision: 1, title: "After" },
  context: { ...holder, leaseGeneration: 1 },
};
const invalidUpdate = {
  ...missingUpdate,
  requestId: "invalid-update",
  input: { ...missingUpdate.input, dependsOn: ["forge-1"] },
};
const typed = (f: Fixture, body: Json, expires = E1) =>
  f.send(`${probe}/command`, body, {
    "X-Forge-Owner": "owner-a",
    "X-Forge-Owner-Expires": String(expires),
  });

function typedBackup(source: Fixture): Portable {
  const store = writableStore(source.storage);
  const { head, eventWatermark, recordFloor, root } = recovered(
    store,
    source.seal(),
  );
  return {
    pages: pages(source),
    head,
    eventWatermark,
    recordFloor,
    publicDigest: root.publicDigest as string,
    source: String(source.context.id),
  };
}

async function grantTypedUpdate(source: Fixture) {
  const record = putRecord("r1", 1, {
    id: "work-1",
    prefix: "forge",
    title: "Before",
    status: "open",
    labels: [],
    dependsOn: [],
    createdAt: new Date(T0).toISOString(),
  });
  expect((await append(source, record)).status).toBe(200);
  const subject = "issue:work-1";
  const claim = { subject, requestId: "restore-claim", ttlMs: HOUR };
  const release = { subject, requestId: "restore-release", generation: 1 };
  const update = {
    ...missingUpdate,
    input: { ...missingUpdate.input, id: "forge-1" },
  };
  expect((await sendLease(source, "claim", "owner-a", claim)).status).toBe(200);
  expect((await typed(source, update)).status).toBe(200);
  expect((await sendLease(source, "release", "owner-a", release)).status).toBe(
    200,
  );
  await drain(source, 0, 4);
}

for (const scenario of [
  "NOT_FOUND",
  "INPUT_INVALID",
  "mixed history",
] as const) {
  test(
    `v3 restore replays a refused typed update with ${scenario}`,
    async () => {
      const source = guardFixture(typedEnv);
      const target = guardFixture(typedEnv);
      using _source = source.db;
      using _target = target.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      const mixed = scenario === "mixed history";
      if (mixed) {
        await grantTypedUpdate(source);
        setSystemTime(E1 + 1);
      }
      const calls =
        scenario === "INPUT_INVALID" ? [invalidUpdate] : [missingUpdate];
      if (mixed) calls.push(invalidUpdate);
      const expires = mixed ? E1 + HOUR : E1;
      const replies = [];
      for (const call of calls) {
        const invalid = call === invalidUpdate;
        const reply = await typed(source, call, expires);
        expect(reply).toMatchObject({
          status: invalid ? 400 : 404,
          body: { error: { code: invalid ? "INPUT_INVALID" : "NOT_FOUND" } },
        });
        replies.push(reply);
      }
      const prior = mixed ? 4 : 0;
      await drain(source, prior, prior + calls.length);
      const data = typedBackup(source);
      const upload = await stageRestore(target, data);
      const activationTime = Date.now();
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      expect(pages(target)).toEqual(data.pages);
      const expected = await view(source);
      const restored = await view(target);
      expect(restored).toMatchObject({
        pages: (expected as Json).pages,
        publicDigest: data.publicDigest,
      });
      const db = writableStore(target.storage);
      const image = recovered(db, target.seal());
      const global = controlGlobal(image.root.incarnation, activationTime);
      expect(restored.image).toEqual({
        ...expected.image,
        control: controlDigest(global),
        head: data.head + 1,
        eventWatermark: data.eventWatermark + 1,
      });
      expect(controlSlot(db, image)).toEqual(global);
      target.restart();
      const effects = target.observeEffects();
      for (const [index, call] of calls.entries())
        expect(await typed(target, call, expires)).toEqual(replies[index]!);
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );
}

for (const fault of [
  "snapshot error",
  "receipt metadata",
  "refusal digest",
  "missing outcome",
] as const) {
  test(
    `v3 restore refuses a typed transcript with ${fault}`,
    async () => {
      const source = guardFixture(typedEnv);
      const target = guardFixture(typedEnv);
      using _source = source.db;
      using _target = target.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      expect((await typed(source, missingUpdate)).status).toBe(404);
      await drain(source, 0, 1);
      const data = typedBackup(source);
      const [directory, snapshot] = data.pages;
      const [entry] = JSON.parse(directory!.body) as DirectoryItem[];
      if (fault === "snapshot error" || fault === "receipt metadata") {
        editProjection(data, "outcome", entry!.key, (body) =>
          fault === "snapshot error"
            ? body.replace("Issue was not found", "Issue was not FOUND")
            : body.replace(`"retryUntil":${E1}`, `"retryUntil":${E1 + 1}`),
        );
      } else if (fault === "refusal digest") {
        editHistory(data, ([frame]) => {
          (frame!.outcome as Json).resultDigest =
            digestBytes("different refusal");
        });
      } else if (fault === "missing outcome") {
        directory!.body = "[]";
        snapshot!.body = "";
        data.publicDigest = digestBytes("[]");
      }
      const upload = await stageRestore(target, data);
      const reset = observeRestoreReset(target);
      expect(await upload(2)).toMatchObject(restoreRefusal);
      await unprovisioned(target);
      reset();
    },
    timeout,
  );
}

const createBody = {
  op: "issue.create",
  requestId: "restored-create",
  input: { title: "A" },
  context: { actor: holder.actor },
};
const invalidCreate = {
  ...createBody,
  requestId: "invalid-create",
  input: { title: "A", dependsOn: ["forge-1"] },
};
const grantedUpdate = {
  ...missingUpdate,
  input: { ...missingUpdate.input, id: "forge-1" },
};
const issueClaim = {
  op: "issue.claim",
  requestId: "history-claim",
  input: { id: "forge-1", ttlSeconds: 60 },
  context: holder,
};
const rawLease = (f: Fixture, route: string, owner: string, input: Json) =>
  sendLease(f, route, owner, { subject: "issue:work-1", ...input });
const ok = (reply: { status: number }) => expect(reply.status).toBe(200);
const exited = ({ body }: { body: unknown }) =>
  exitCode(
    (body as { error?: ForgeError }).error
      ? failed((body as { error: ForgeError }).error)
      : ({ ok: true } as Parameters<typeof exitCode>[0]),
  );

async function createdHistory(source: Fixture) {
  const created = await typed(source, createBody);
  const missing = await typed(source, missingUpdate);
  expect([created.status, missing.status]).toEqual([200, 404]);
  const claim = { requestId: "raw-1", ttlMs: HOUR };
  ok(await rawLease(source, "claim", "owner-a", claim));
  await drain(source, 0, 3);
  return [created, missing];
}

async function restoring<T>(
  build: (source: Fixture) => Promise<T>,
  run: (scene: {
    source: Fixture;
    target: Fixture;
    data: Portable;
    built: T;
  }) => Promise<void>,
) {
  const source = guardFixture(typedEnv);
  const target = guardFixture(typedEnv);
  using _source = source.db;
  using _target = target.db;
  expect(await source.send(probe, {})).toMatchObject({ status: 200 });
  const built = await build(source);
  await run({ source, target, data: typedBackup(source), built });
}

async function restored(source: Fixture, target: Fixture, data: Portable) {
  const upload = await stageRestore(target, data);
  setSystemTime(T0 + 1);
  const reply = await upload(2);
  expect(reply).toMatchObject(restoreResult(2, true));
  expect(exited(reply)).toBe(0);
  expect(pages(target)).toEqual(data.pages);
  const from = writableStore(source.storage);
  const to = writableStore(target.storage);
  const origin = recovered(from, source.seal());
  const image = recovered(to, target.seal());
  const { lease: _lease, ...expected } = viewV3(origin).image as Json;
  const { lease: _restored, ...actual } = viewV3(image).image as Json;
  const global = controlGlobal(image.root.incarnation, T0 + 1);
  expect(actual).toEqual({
    ...expected,
    control: controlDigest(global),
    head: data.head + 1,
    eventWatermark: data.eventWatermark + 1,
  });
  expect(controlSlot(to, image)).toEqual(global);
  for (const subject of origin.entries.lease.keys()) {
    const lease = readV3Value(from, origin, "lease", subject)!;
    expect(readV3Value(to, image, "lease", subject)).toEqual({
      ...lease,
      releasedAt: lease.releasedAt ?? iso(T0 + 1),
    });
  }
  return [...origin.entries.outcome.keys()].map(
    (key) => readV3Value(to, image, "outcome", key)!.outcome,
  );
}

async function refusesTampered(
  build: (source: Fixture) => Promise<unknown>,
  tamper: (data: Portable, source: Fixture) => void,
) {
  const sibling = guardFixture(typedEnv);
  using _sibling = sibling.db;
  await restoring(build, async ({ source, target, data }) => {
    const honest = await stageRestore(sibling, data);
    expect(await honest(2)).toMatchObject(restoreResult(2, true));
    tamper(data, source);
    const upload = await stageRestore(target, data);
    const reset = observeRestoreReset(target);
    const reply = await upload(2);
    expect(reply).toMatchObject(restoreRefusal);
    expect(exited(reply)).toBe(1);
    await unprovisioned(target);
    reset();
  });
}

function receiptOf(source: Fixture, revision: number) {
  const db = writableStore(source.storage);
  const image = recovered(db, source.seal());
  for (const key of image.entries.outcome.keys()) {
    const { result } = readV3Value(db, image, "outcome", key)!.outcome;
    if ((result as Json | undefined)?.revision === revision)
      return { key, result: result as Json };
  }
  throw new Error("no receipt");
}

test(
  "v3 restore accepts a history with a successful create and replays it",
  () =>
    restoring(createdHistory, async ({ source, target, data, built }) => {
      const outcomes = await restored(source, target, data);
      expect(outcomes.map(({ result }) => result)).toContainEqual(
        expect.objectContaining({ id: "forge-1", title: "A", revision: 1 }),
      );
      target.restart();
      const effects = target.observeEffects();
      expect(await typed(target, createBody)).toEqual(built[0]!);
      expect(await typed(target, missingUpdate)).toEqual(built[1]!);
      expect(effects()).toEqual(noWrites);
      expect(built.map(exited)).toEqual([0, 3]);
    }),
  timeout,
);

test(
  "v3 restore accepts a recorded create refusal and replays it",
  () =>
    restoring(
      async (source) => {
        const reply = await typed(source, invalidCreate);
        expect(reply.status).toBe(400);
        await drain(source, 0, 1);
        return reply;
      },
      async ({ source, target, data, built }) => {
        await restored(source, target, data);
        target.restart();
        const effects = target.observeEffects();
        expect(await typed(target, invalidCreate)).toEqual(built);
        expect(effects()).toEqual(noWrites);
        expect(exited(built)).toBe(6);
      },
    ),
  timeout,
);

test(
  "v3 restore accepts a typed update receipt and replays it as stale",
  () =>
    restoring(grantTypedUpdate, async ({ source, target, data }) => {
      const outcomes = await restored(source, target, data);
      expect(outcomes.map(({ result }) => result)).toContainEqual(
        expect.objectContaining({
          title: "After",
          revision: 2,
          lease: expect.anything() as unknown,
        }),
      );
      target.restart();
      const effects = target.observeEffects();
      const reply = await typed(target, grantedUpdate);
      expect(reply).toMatchObject({
        status: 409,
        body: { error: { code: "LEASE_STALE" } },
      });
      expect(exited(reply)).toBe(4);
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

const restoreReplies = typedReplyCases(T0, "owner-a");
const restoreReply = (f: Fixture, body: object) =>
  f.sendText(`${probe}/command`, body, {
    "X-Forge-Owner": "owner-a",
    "X-Forge-Owner-Expires": String(E1),
  });

function withRestoredReplies(
  run: (target: Fixture, first: Map<string, string>) => Promise<void>,
) {
  return restoring(
    async (source) => {
      const cases = Object.values(restoreReplies);
      const first = new Map<string, string>();
      for (const { call, expected } of cases) {
        const reply = await restoreReply(source, call);
        expectTypedReply(reply, expected);
        first.set(call.requestId, reply.text);
      }
      await drain(source, 0, cases.length);
      return first;
    },
    async ({ source, target, data, built }) => {
      const db = writableStore(source.storage);
      const origin = recovered(db, source.seal());
      const prior = [...origin.entries.outcome.keys()].map(
        (key) => readV3Value(db, origin, "outcome", key)!.outcome,
      );
      expect(await restored(source, target, data)).toEqual(prior);
      target.restart();
      await run(target, built);
    },
  );
}

for (const { call, expected } of [
  restoreReplies.create,
  restoreReplies.createWithFields,
  restoreReplies.missing,
  restoreReplies.revisionConflict,
]) {
  test(
    `v3 restore replays the first ${call.requestId} reply text`,
    () =>
      withRestoredReplies(async (target, first) => {
        const reply = await readOnlyReply(target, () =>
          restoreReply(target, call),
        );
        expectTypedReply(reply, expected);
        const changed = {
          ...restoreReplies.create.call,
          input: { title: "Changed" },
        };
        expectTypedReply(
          await readOnlyReply(target, () => restoreReply(target, changed)),
          changedCommandReply,
        );
        expect(reply.text).toBe(first.get(call.requestId)!);
      }),
    timeout,
  );
}

test(
  "v3 restore keeps typed claim and update receipts and refuses their replays as stale",
  () =>
    withRestoredReplies(async (target) => {
      const lease = restoreReplies.update.expected.result.lease;
      const expected = {
        status: 409,
        exit: 4,
        error: {
          code: "LEASE_STALE",
          message:
            "Request no longer matches the current lease on issue:work-1",
          retry: "reconcile_first",
          lease,
        },
      } as const;
      for (const { call } of [restoreReplies.claim, restoreReplies.update]) {
        const replay = () =>
          readOnlyReply(target, () => restoreReply(target, call));
        const first = await replay();
        const second = await replay();
        expectTypedReply(first, expected);
        expectTypedReply(second, expected);
        expect(second.text).toBe(first.text);
      }
    }),
  timeout,
);

test(
  "v3 restore refuses a changed update digest after restoring the honest history",
  () =>
    refusesTampered(grantTypedUpdate, (data) =>
      editHistory(data, (f) => {
        (f[2]!.outcome as Json).resultDigest = digestBytes("different update");
      }),
    ),
  timeout,
);

const createEdits: [string, (data: Portable, source: Fixture) => void][] = [
  [
    "an edited event value",
    (data) =>
      editHistory(data, (f) => {
        ((f[0]!.events as Json[])[0]!.value as Json).title = "B";
      }),
  ],
  [
    "edited changes",
    (data) =>
      editHistory(data, (f) => {
        (((f[0]!.changes as Json[])[0]!.value as Json).value as Json).title =
          "B";
      }),
  ],
  [
    "an edited digest",
    (data) =>
      editHistory(data, (f) => {
        (f[0]!.outcome as Json).resultDigest = digestBytes("different create");
      }),
  ],
  [
    "a signed numeric title",
    (data, source) => {
      const { key, result } = receiptOf(source, 1);
      const numeric = (body: string) =>
        body.replace('"title":"A"', '"title":123');
      editHistory(data, (f) => {
        ((f[0]!.events as Json[])[0]!.value as Json).title = 123;
        (((f[0]!.changes as Json[])[0]!.value as Json).value as Json).title =
          123;
        (f[0]!.outcome as Json).resultDigest = digestValue({
          ...result,
          title: 123,
        });
      });
      editProjection(data, "record", "r1", numeric);
      editProjection(data, "outcome", key, numeric);
    },
  ],
];

for (const [name, tamper] of createEdits)
  test(
    `v3 restore refuses a create history with ${name}`,
    () => refusesTampered(createdHistory, tamper),
    timeout,
  );

type Mode = "archived" | "portable";
const modes: Mode[] = ["archived", "portable"];
const iso = (time: number) => new Date(time).toISOString();
const ZERO = `sha256:${"0".repeat(64)}`;
const outcomeOf = (row: Json | undefined) => row!.outcome as Json;
const transcript = (f: Fixture) =>
  JSON.parse(pages(f).find(({ id }) => id === "transcript:0")!.body) as Json[];

function foldOf(f: Fixture, mode: Mode, rows: Json[], stubNotes = true) {
  const db = writableStore(f.storage);
  const admit = Project.admitLeaseRequest;
  if (mode === "archived") return foldTranscript(db, rows, mode, admit);
  const portableTranscript = canonicalJson(
    rows.map((row) =>
      stubNotes && row.operation === "fixture.note"
        ? { sequence: row.sequence }
        : row,
    ),
  );
  const manifest = verifiedPortable(f.seal(), portableTranscript);
  return recoverV3(db, f.seal(), { admit, manifest, portableTranscript });
}

function refuses(f: Fixture, mode: Mode, rows: Json[], stubNotes = true) {
  const effects = f.observeEffects();
  let thrown: unknown;
  try {
    foldOf(f, mode, rows, stubNotes);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ForgeFailure);
  expect((thrown as ForgeFailure).error).toMatchObject({
    code: "UNAVAILABLE",
    message: "Cloud v3 root is unavailable",
  });
  expect(effects()).toEqual(noWrites);
}

async function history(source: Fixture) {
  const lease = (route: string, owner: string, input: Json) =>
    rawLease(source, route, owner, { ttlMs: HOUR, ...input });
  ok(await typed(source, createBody));
  ok(await lease("claim", "owner-a", { requestId: "h-claim" }));
  ok(await typed(source, grantedUpdate));
  ok(await lease("renew", "owner-a", { requestId: "h-renew", generation: 1 }));
  const release = { requestId: "h-release", generation: 1 };
  ok(await lease("release", "owner-a", release));
  ok(await typed(source, issueClaim));
  ok(await append(source, putRecord("r2", 1, "later")));
  ok(await append(source, frame()));
  const refused = await lease("claim", "owner-b", { requestId: "h-refused" });
  expect(refused.status).toBe(409);
  await drain(source, 0, 9);
  return transcript(source);
}

async function withHistory(
  run: (source: Fixture, rows: Json[]) => void | Promise<void>,
) {
  const source = guardFixture(typedEnv);
  using _source = source.db;
  expect(await source.send(probe, {})).toMatchObject({ status: 200 });
  await run(source, await history(source));
}

for (const mode of modes)
  test(
    `v3 ${mode} fold installs the results and leases the live image holds`,
    () =>
      withHistory((source, rows) => {
        const db = writableStore(source.storage);
        const live = recovered(db, source.seal());
        const folded = foldOf(source, mode, rows);
        expect(viewV3(folded).image).toEqual(viewV3(live).image);
        expect(folded.recordFloor).toBe(live.recordFloor);
        for (const name of ["lease", "outcome", "witness"] as const)
          for (const key of live.entries[name].keys())
            expect(JSON.stringify(readV3Value(db, folded, name, key))).toBe(
              canonicalJson(readV3Value(db, live, name, key)),
            );
        const results = [...live.entries.outcome.keys()]
          .map((key) => readV3Value(db, folded, "outcome", key)!.outcome)
          .filter(({ scope }) => scope.family === "command")
          .map(({ result }) => result);
        expect(results).toHaveLength(3);
        for (const expected of [
          { id: "forge-1", title: "A", revision: 1 },
          { id: "forge-1", title: "After", revision: 2 },
          { id: "forge-1", generation: expect.any(Number) as unknown },
        ])
          expect(results).toContainEqual(expect.objectContaining(expected));
      }),
    timeout,
  );

const tampers: [string, (rows: Json[]) => void][] = [
  ["a create digest", (f) => (outcomeOf(f[0]).resultDigest = ZERO)],
  ["an update digest", (f) => (outcomeOf(f[2]).resultDigest = ZERO)],
  ["a typed claim digest", (f) => (outcomeOf(f[5]).resultDigest = ZERO)],
  [
    "a raw claim expiry",
    (f) => ((f[1]!.lease as Json).expiresAt = iso(T0 + 2 * HOUR)),
  ],
  [
    "a raw renew expiry",
    (f) => ((f[3]!.lease as Json).expiresAt = iso(T0 + 2 * HOUR)),
  ],
  [
    "a raw release time",
    (f) => ((f[4]!.lease as Json).releasedAt = iso(T0 + 1)),
  ],
  ["a raw refusal digest", (f) => (outcomeOf(f[8]).resultDigest = ZERO)],
  ["a raw refusal status", (f) => (outcomeOf(f[8]).status = "INPUT_INVALID")],
  ["a result beside its digest", (f) => (outcomeOf(f[0]).result = {})],
  [
    "a numeric title",
    (f) => {
      const [event] = f[0]!.events as Json[];
      const { id: _id, prefix: _prefix, ...item } = event!.value as Json;
      (event!.value as Json).title = 7;
      (((f[0]!.changes as Json[])[0]!.value as Json).value as Json).title = 7;
      outcomeOf(f[0]).resultDigest = digestValue({
        ...item,
        title: 7,
        id: "forge-1",
        revision: 1,
        updatedAt: iso(f[0]!.time as number),
      });
    },
  ],
];

for (const mode of modes)
  for (const [name, edit] of tampers)
    test(
      `v3 ${mode} fold refuses ${name}`,
      () =>
        withHistory((source, rows) => {
          foldOf(source, mode, rows);
          const edited = structuredClone(rows);
          edit(edited);
          refuses(source, mode, edited);
        }),
      timeout,
    );

test(
  "v3 portable fold refuses a literal fixture.note frame",
  () =>
    withHistory((source, rows) => {
      foldOf(source, "portable", rows);
      expect(rows.some((row) => row.operation === "fixture.note")).toBe(true);
      refuses(source, "portable", rows, false);
    }),
  timeout,
);

test(
  "v3 archived fold refuses a sequence stub frame",
  () =>
    withHistory((source, rows) => {
      foldOf(source, "archived", rows);
      const edited = structuredClone(rows);
      edited[7] = { sequence: rows[7]!.sequence };
      refuses(source, "archived", edited);
    }),
  timeout,
);

for (const mode of modes)
  test(
    `v3 ${mode} fold refuses an update result that is not a tracker item`,
    async () => {
      const source = guardFixture(typedEnv);
      using _source = source.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      await grantTypedUpdate(source);
      const rows = transcript(source);
      foldOf(source, mode, rows);
      const edited = structuredClone(rows);
      const extra = (item: unknown) => ((item as Json).extra = 1);
      extra((edited[0]!.events as Json[])[0]!.value);
      extra(((edited[0]!.changes as Json[])[0]!.value as Json).value);
      extra(((edited[2]!.changes as Json[])[0]!.value as Json).value);
      outcomeOf(edited[2]).resultDigest = digestValue({
        ...receiptOf(source, 2).result,
        extra: 1,
      });
      refuses(source, mode, edited);
    },
    timeout,
  );

const dependent = (id: string, dependsOn: string[]) => ({
  id,
  prefix: "forge",
  title: "A",
  status: "open",
  labels: [],
  dependsOn,
  createdAt: iso(T0),
});

for (const mode of ["archived", "portable", "tail"] as const)
  test(
    `v3 ${mode} replay keeps the claim blocker text live publication wrote`,
    async () => {
      const source = guardFixture(typedEnv);
      using _source = source.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      const puts = putRecords(
        { key: "r1", revision: 1, value: dependent("work-1", ["work-2"]) },
        { key: "r2", revision: 1, value: dependent("work-2", []) },
      );
      ok(await append(source, puts));
      const dependency = { subject: "issue:work-2", requestId: "dependency" };
      ok(
        await rawLease(source, "claim", "owner-a", {
          ...dependency,
          ttlMs: HOUR,
        }),
      );
      const first = await typed(source, issueClaim);
      expect(first).toMatchObject({
        status: 409,
        body: { error: { code: "CLAIM_BLOCKED" } },
      });
      expect(exited(first)).toBe(1);
      const db = writableStore(source.storage);
      const liveImage = recovered(db, source.seal());
      const live = readV3Value(db, liveImage, "lease", "issue:work-2");
      let folded: ReturnType<typeof recoverV3>;
      if (mode === "tail") folded = recovered(db, source.seal());
      else {
        await drain(source, 0, 3);
        folded = foldOf(source, mode, transcript(source));
      }
      expect(
        JSON.stringify(readV3Value(db, folded, "lease", "issue:work-2")),
      ).toBe(canonicalJson(live));
      let thrown: unknown;
      try {
        const claim = {
          subject: "issue:work-1",
          prefix: "forge",
          holder,
          ttlMs: 60_000,
        } as Parameters<typeof claimEffect>[1];
        claimEffect(folded, claim, T0, T0 + HOUR);
      } catch (error) {
        thrown = error;
      }
      const { error } = first.body as { error: ForgeError };
      expect((thrown as ForgeFailure).error).toMatchObject({
        code: "CLAIM_BLOCKED",
        message: error.message,
        observed: error.observed,
      });
    },
    timeout,
  );

test(
  "v3 restore activates in one commit and recovers the entire stopped image",
  () =>
    withPortable(async (target, data, source) => {
      const upload = await stageRestore(target, data);
      setSystemTime(T0 + 1);
      const before = { ...target.reads };
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      const reads = {
        rows: target.reads.rows - before.rows,
        bytes: target.reads.bytes - before.bytes,
      };
      expect(await target.send("status")).toMatchObject(stopped);
      expect(tableNames(target)).toEqual([
        "cloud_v3_commits",
        "cloud_v3_pages",
        "cloud_v3_restore",
        "cloud_v3_root",
      ]);
      expect([...target.values]).toEqual([]);
      expect(
        target.db.query("SELECT body FROM cloud_v3_restore ORDER BY id").all(),
      ).toEqual(data.pages.map(() => ({ body: "" })));
      const log = commits(target);
      expect(log.map(({ sequence }) => sequence)).toEqual([data.head + 1]);
      const activation = JSON.parse(log[0]!.body) as Json;
      expect(activation).toMatchObject({
        operation: "restore.activate",
        time: T0 + 1,
      });
      expect(activation.events).toHaveLength(1);

      const from = writableStore(source.storage);
      const to = writableStore(target.storage);
      const origin = recovered(from, source.seal());
      const restored = recovered(to, target.seal());
      const { lease: _lease, ...expected } = viewV3(origin).image as Json;
      const { lease: _restoredLease, ...actual } = viewV3(restored)
        .image as Json;
      const global = controlGlobal(restored.root.incarnation, T0 + 1);
      expect(actual).toEqual({
        ...expected,
        control: controlDigest(global),
        head: data.head + 1,
        eventWatermark: data.eventWatermark + 1,
      });
      expect(controlSlot(to, restored)).toEqual(global);
      expect(restored.recordFloor).toBe(data.recordFloor);
      expect(restored.root.incarnation).not.toBe(origin.root.incarnation);
      expect(restored.root.restoreEpoch).not.toBe(origin.root.restoreEpoch);
      for (const subject of origin.entries.lease.keys()) {
        const lease = readV3Value(from, origin, "lease", subject)!;
        expect(readV3Value(to, restored, "lease", subject)).toEqual({
          ...lease,
          releasedAt: lease.releasedAt ?? new Date(T0 + 1).toISOString(),
        });
      }
      expect(restored.entries.lease.size).toBe(3);
      await expectWarmAndCold(target, viewV3(restored).image);
      expect(await target.send("status")).toMatchObject(stopped);
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(2 * MiB);
      console.log("v3 restore activation reads", reads);
    }, 2),
  timeout,
);

test(
  "v3 restored raw lease requests keep their refusal text and receipts",
  () => {
    const cases = [
      [
        "claim",
        { requestId: "restore-claim", ttlMs: HOUR },
        { code: "LEASE_NOT_HELD", lease: { generation: 1 } },
      ],
      [
        "renew",
        { requestId: "restore-renew", generation: 1, ttlMs: HOUR / 2 },
        { code: "INPUT_CONFLICT" },
      ],
      [
        "release",
        { requestId: "restore-release", generation: 1 },
        { code: "INPUT_CONFLICT" },
      ],
    ] as const;
    return restoring(
      async (source) => {
        for (const [route, input] of cases) {
          ok(await sendLease(source, route, "owner-a", input));
        }
        await drain(source, 0, cases.length);
      },
      async ({ source, target, data }) => {
        const db = writableStore(source.storage);
        const origin = recovered(db, source.seal());
        const receipts = [...origin.entries.outcome.keys()].map(
          (key) => readV3Value(db, origin, "outcome", key)!.outcome,
        );
        expect(receipts).toHaveLength(cases.length);
        expect(await restored(source, target, data)).toEqual(receipts);
        target.restart();
        for (const [route, input, error] of cases) {
          const reply = () =>
            target.sendText(...leaseRequest(route, "owner-a", input));
          const first = await readOnlyReply(target, reply);
          const replay = await readOnlyReply(target, reply);
          expect(first.status).toBe(409);
          expect(JSON.parse(first.text)).toMatchObject({ ok: false, error });
          expect(replay.status).toBe(409);
          expect(replay.text).toBe(first.text);
        }
      },
    );
  },
  timeout,
);

test(
  "v3 restored witness checks the held generation before the stop",
  () =>
    withPortable(async (target, data, source) => {
      const forged = { ...frame(), operation: "restore.activate" };
      expect(await append(source, forged)).toMatchObject({ status: 400 });
      const upload = await stageRestore(target, data);
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      target.restart();
      const guard = target.observeEffects();
      const claim = { requestId: "acq-1", ttlMs: HOUR };
      expect(await sendLease(target, "claim", "owner-a", claim)).toMatchObject({
        status: 409,
        body: { error: { code: "LEASE_NOT_HELD", lease: { generation: 1 } } },
      });
      expect(
        await sendLease(target, "claim", "owner-b", {
          ...claim,
          requestId: "acq-2",
        }),
      ).toMatchObject({
        status: 409,
        body: { error: { code: "INPUT_CONFLICT" } },
      });
      expect(
        await sendLease(target, "release", "owner-a", {
          requestId: "rel-1",
          generation: 1,
        }),
      ).toMatchObject({
        status: 409,
        body: { error: { code: "INPUT_CONFLICT" } },
      });
      expect(await append(target, frame())).toMatchObject({ status: 409 });
      expect(guard()).toEqual(noWrites);
      target.db.run(
        "CREATE TABLE cloud_v3_retired_pages (id TEXT PRIMARY KEY, body TEXT)",
      );
      const before = target.observeEffects();
      expect(await checkpoint(target)).toMatchObject(refused);
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 restore rolls back publication before commit and accepts a complete staged retry",
  () =>
    withPortable(async (target, data) => {
      const upload = await stageRestore(target, data);
      const before = target.snapshot();
      const executeSql = target.storage.sql.exec.bind(target.storage.sql);
      target.storage.sql.exec = (statement, ...bindings) => {
        if (statement.startsWith("INSERT INTO cloud_v3_commits"))
          throw new Error("before activation commit");
        return executeSql(statement, ...bindings);
      };
      const interrupted = await upload(2);
      target.storage.sql.exec = executeSql;
      expect(interrupted.status).toBe(500);
      expect(target.snapshot()).toEqual(before);
      await unprovisioned(target);
      const page = data.pages[2]!;
      target.db.run(
        "INSERT INTO cloud_v3_restore VALUES (?, ?, ?, NULL, NULL, 1)",
        [page.id, page.body, digestBytes(JSON.stringify({ page: 2, ...page }))],
      );
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      expect(await target.send("status")).toMatchObject(stopped);
    }),
  timeout,
);

test(
  "v3 restore recovers a post-commit fault and returns the same saved retries",
  () =>
    withPortable(async (target, data) => {
      const upload = await stageRestore(target, data);
      const transact = target.storage.transactionSync.bind(target.storage);
      target.storage.transactionSync = (body) => {
        const result = transact(body);
        if (tableNames(target).includes("cloud_v3_root"))
          throw new Error("after activation commit");
        return result;
      };
      const interrupted = await upload(2);
      target.storage.transactionSync = transact;
      expect(interrupted.status).toBe(500);
      expect(await target.send("status")).toMatchObject(stopped);
      const warm = await view(target);
      const committed = commits(target);
      const before = target.observeEffects();
      target.restart();
      expect(await view(target)).toEqual(warm);
      expect(await upload(0)).toMatchObject(restoreResult(0));
      const first = { ...target.reads };
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      const reads = {
        rows: target.reads.rows - first.rows,
        bytes: target.reads.bytes - first.bytes,
      };
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(2 * MiB);
      console.log("v3 restore activation retry reads", reads);
      expect(
        await upload(0, undefined, digestBytes("other manifest")),
      ).toMatchObject(restoreRefusal);
      expect(committed).toHaveLength(1);
      expect(commits(target)).toEqual(committed);
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

for (const damage of ["missing", "altered", "extra", "mac"] as const) {
  test(
    `v3 restore cold recovery refuses ${damage} activation proof`,
    () =>
      withPortable(async (target, data) => {
        const upload = await stageRestore(target, data);
        expect(await upload(2)).toMatchObject(restoreResult(2, true));
        expect(tableNames(target)).toContain("cloud_v3_commits");
        if (damage === "missing") target.db.run("DELETE FROM cloud_v3_commits");
        if (damage === "altered")
          changeCommit(target, data.head + 1, (body) => ({
            ...body,
            time: T0 + 1,
          }));
        if (damage === "mac")
          target.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=?", [
            `${"0".repeat(16)}.${"0".repeat(64)}`,
            data.head + 1,
          ]);
        if (damage === "extra")
          target.db.run(
            "INSERT INTO cloud_v3_commits SELECT ?, body, mac FROM cloud_v3_commits",
            [data.head + 2],
          );
        target.restart();
        const before = target.observeEffects();
        expect(await target.send("status")).toMatchObject(refused);
        expect(await target.send(probe)).toMatchObject(refused);
        expect(before()).toEqual(noWrites);
      }),
    timeout,
  );
}

test(
  "v3 restore refuses to activate more than sixteen imported leases",
  () =>
    withPortable(async (target, { head }, source) => {
      const extra = 16;
      await withFixture(async (donor) => {
        for (let i = 0; i < extra; i++) {
          expect(
            await sendLease(donor, "claim", "owner-a", {
              subject: `work-${i + 2}`,
              requestId: `extra-${i}`,
              ttlMs: i === 0 ? 1 : HOUR,
            }),
          ).toMatchObject({ status: 200 });
        }
        for (const { sequence, body } of commits(donor)) {
          const next = head + sequence;
          const frame = JSON.parse(body) as Json;
          insertLegacyRow(
            source,
            next,
            canonicalJson({ ...frame, sequence: next }),
          );
        }
      });
      source.restart();
      await drain(source, head, head + extra);
      const data = typedBackup(source);
      editHistory(data, (frames) => {
        frames[5] = { sequence: 6 };
      });
      const upload = await stageRestore(target, data);
      const reset = observeRestoreReset(target);
      expect(await upload(2)).toMatchObject({
        status: 413,
        body: { error: { code: "RESTORE_TOO_LARGE" } },
      });
      await unprovisioned(target);
      reset();
    }),
  timeout,
);

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
  await drain(source, 0, 2);
  await run(target, typedBackup(source));
}

function refusalEntry(data: Portable) {
  const entries = JSON.parse(data.pages[0]!.body) as DirectoryItem[];
  const bytes = Buffer.from(data.pages[1]!.body);
  const text = ({ offset, length }: DirectoryItem) =>
    bytes.subarray(offset, offset! + length!).toString();
  const item = entries.find((e) => text(e).includes('"code":"NOT_FOUND"'))!;
  return { entries, item, text, size: bytes.length };
}

function forgeRefusal(data: Portable, edit: (result: Json) => unknown) {
  const { entries, item, text } = refusalEntry(data);
  const saved = JSON.parse(text(item)) as { outcome: { result: Json } };
  edit(saved.outcome.result);
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
  editProjection(data, item.collection, item.key, (same) => same);
  editHistory(data, (frames) => {
    const { outcome } = frames.find(
      (f) => (f.outcome as Json).id === item.key,
    )!;
    (outcome as Json).resultDigest = digestBytes(
      canonicalJson(saved.outcome.result),
    );
  });
}

function retarget(
  data: Portable,
  edit: (found: ReturnType<typeof refusalEntry>) => unknown,
) {
  const found = refusalEntry(data);
  edit(found);
  data.pages[0]!.body = canonicalJson(found.entries);
}

const accent = (result: Json) =>
  Object.assign(result, { message: "caf\u00e9" });
const splitAccent = (data: Portable, atEnd: boolean) => {
  forgeRefusal(data, accent);
  retarget(data, ({ item, text }) => {
    const at = Buffer.from(text(item)).indexOf(0xc3) + 1;
    return atEnd
      ? Object.assign(item, { length: at })
      : Object.assign(item, {
          offset: item.offset! + at,
          length: item.length! - at,
        });
  });
};

test(
  "v3 restore restores and replays a refused typed update with a multi-byte message",
  () =>
    withTyped(async (target, data) => {
      forgeRefusal(data, accent);
      const upload = await stageRestore(target, data);
      const reset = observeRestoreReset(target);
      expect(await upload(2)).toEqual({
        status: 400,
        body: {
          ok: false,
          error: {
            code: "RESTORE_INVALID_ROW",
            message: "Cloud v3 portable restore could not be verified",
            retry: "never",
          },
        },
      });
      reset();
      const glyphs = "caf\u00e9 \u{1F600}";
      const source = guardFixture(typedEnv);
      const honest = guardFixture(typedEnv);
      using _source = source.db;
      using _honest = honest.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      ok(
        await append(
          source,
          putRecords(
            { key: "r1", revision: 1, value: dependent("work-1", ["work-2"]) },
            { key: "r2", revision: 1, value: dependent("work-2", []) },
          ),
        ),
      );
      const named = {
        actor: { kind: "agent", id: glyphs },
        session: { id: glyphs, device: "owner-a" },
      };
      ok(
        await rawLease(source, "claim", "owner-a", {
          subject: "issue:work-2",
          requestId: "dependency",
          ttlMs: HOUR,
          holder: named,
        }),
      );
      const blocked = await typed(source, issueClaim);
      expect(blocked).toMatchObject({
        status: 409,
        body: { error: { code: "CLAIM_BLOCKED" } },
      });
      expect(JSON.stringify(blocked.body)).toContain(glyphs);
      await drain(source, 0, 3);
      const restored = await stageRestore(honest, typedBackup(source));
      expect(await restored(2)).toMatchObject(restoreResult(2, true));
      honest.restart();
      expect(await typed(honest, issueClaim)).toEqual(blocked);
    }),
  timeout,
);

for (const [fault, tamper] of [
  [
    "a result missing a field",
    (d: Portable) => forgeRefusal(d, (r) => delete r.message),
  ],
  [
    "a result code that contradicts the status",
    (d: Portable) =>
      forgeRefusal(d, (r) => Object.assign(r, { code: "INPUT_INVALID" })),
  ],
  [
    "a result with an extra field",
    (d: Portable) => forgeRefusal(d, (r) => Object.assign(r, { extra: true })),
  ],
  [
    "a duplicate directory entry",
    (d: Portable) =>
      retarget(d, ({ entries, item }) =>
        entries.splice(entries.indexOf(item), 0, { ...item }),
      ),
  ],
  [
    "an offset past the snapshot",
    (d: Portable) =>
      retarget(d, ({ item, size }) => Object.assign(item, { offset: size })),
  ],
  [
    "a last entry whose length runs past the snapshot end",
    (d: Portable) =>
      retarget(d, ({ entries, size }) => {
        const last = entries.at(-1)!;
        last.length = size - last.offset! + 1;
      }),
  ],
  [
    "a saved outcome nested past 64 levels",
    (d: Portable) =>
      forgeRefusal(d, (r) =>
        Object.assign(r, {
          observed: JSON.parse("[".repeat(70) + "]".repeat(70)) as unknown,
        }),
      ),
  ],
  [
    "an entry that overlaps another outcome",
    (d: Portable) =>
      retarget(d, ({ entries, item }) => {
        const { offset, length } = entries.find((e) => e !== item)!;
        Object.assign(item, { offset, length });
      }),
  ],
  [
    "a slice that ends inside a multi-byte character",
    (d: Portable) => splitAccent(d, true),
  ],
  [
    "a slice that starts inside a multi-byte character",
    (d: Portable) => splitAccent(d, false),
  ],
  [
    "a 100000-level directory page inside the page cap",
    (d: Portable) => {
      d.pages[0]!.body = "[".repeat(100_000) + "]".repeat(100_000);
    },
  ],
] as const) {
  test(
    `v3 restore guards a saved refusal against ${fault}`,
    () =>
      withTyped(async (target, data) => {
        tamper(data);
        const upload = await stageRestore(target, data);
        const reset = observeRestoreReset(target);
        expect(await upload(2)).toMatchObject(restoreRefusal);
        await unprovisioned(target);
        reset();
      }),
    timeout,
  );
}

type Edit = (data: Portable, r: Json) => void;
const kRequests = {
  create: createBody,
  invalid: invalidCreate,
  denied: { ...grantedUpdate, requestId: "k-denied" },
  update: { ...grantedUpdate, requestId: "k-update" },
  missing: { ...missingUpdate, requestId: "k-missing" },
  claim: { ...issueClaim, requestId: "k-claim" },
};
const kOrder = Object.values(kRequests);

async function typedFixture(run: (f: Fixture) => Promise<void>) {
  const f = guardFixture(typedEnv);
  using _db = f.db;
  expect(await f.send(probe, {})).toMatchObject({ status: 200 });
  await run(f);
}

async function kBuild(f: Fixture, withTail = false) {
  const replies = [
    await typed(f, kRequests.create),
    await typed(f, kRequests.invalid),
    await typed(f, kRequests.denied),
  ];
  const raw = (route: string, owner: string, input: Json) =>
    rawLease(f, route, owner, { ttlMs: HOUR, ...input });
  ok(await raw("claim", "owner-a", { requestId: "k-raw" }));
  replies.push(
    await typed(f, kRequests.update),
    await typed(f, kRequests.missing),
  );
  expect(await raw("claim", "owner-b", { requestId: "k-held" })).toMatchObject({
    status: 409,
  });
  ok(await raw("renew", "owner-a", { requestId: "k-renew", generation: 1 }));
  ok(
    await raw("release", "owner-a", { requestId: "k-release", generation: 1 }),
  );
  await drain(f, 0, 9);
  ok(await append(f, putRecord("r2", 1, "later")));
  ok(await append(f, frame()));
  f.restart();
  await drain(f, 9, 11);
  if (!withTail) return replies;
  replies.push(await typed(f, kRequests.claim));
  ok(await append(f, frame()));
  return replies;
}

function tamperRoot(
  f: Fixture,
  edit: Edit,
  late: (r: Json) => void = () => undefined,
) {
  const data = { pages: pages(f) } as Portable;
  const r = JSON.parse(root(f).body) as Json;
  edit(data, r);
  const listed = r.pages as Json[];
  for (const entry of listed) {
    const body = data.pages.find(({ id }) => id === entry.id)!.body;
    Object.assign(entry, {
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    });
  }
  r.bytes = Object.fromEntries(
    listed.map(({ kind, bytes }) => [String(kind), bytes]),
  );
  late(r);
  for (const { id, body } of data.pages)
    f.db.run("UPDATE cloud_v3_pages SET body=? WHERE id=?", [body, id]);
  const body = canonicalJson(r);
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
    body,
    trustedSeal(f.db, body),
  ]);
  f.restart();
}

async function coldRefused(f: Fixture) {
  const before = f.snapshot();
  const effects = f.observeEffects();
  const reply = await f.send(probe);
  expect(reply).toMatchObject(refused);
  expect(reply.body).not.toHaveProperty("value");
  expect(exited(reply)).toBe(1);
  expect(effects()).toEqual(noWrites);
  expect(f.snapshot()).toEqual(before);
  return before;
}

async function refusesCold(f: Fixture, edit: Edit, late?: (r: Json) => void) {
  f.restart();
  expect((await f.send(probe)).status).toBe(200);
  tamperRoot(f, edit, late);
  return coldRefused(f);
}

const smallHistory = async (f: Fixture) => {
  ok(await append(f, putRecord("r1", 1, "x")));
  await drain(f, 0, 1);
};
const editedTitle = (data: Portable) =>
  editProjection(data, "record", "r1", (body) =>
    body.replace("After", "Bfter"),
  );
const brokenJson = (body: string) => `[${body.slice(1)}`;
const reTranscript = (
  data: Portable,
  r: Json,
  edit: (frames: Json[]) => void,
) => {
  editHistory(data, edit);
  r.transcriptDigest = digestBytes(data.pages[2]!.body);
};
const differentRefusal = (frames: Json[]) => {
  (frames[1]!.outcome as Json).resultDigest = digestBytes("different refusal");
};
const refusalSource = async (f: Fixture) => {
  expect(await leaseClaim(f, "owner-a")).toMatchObject({ status: 200 });
  expect(await leaseClaim(f, "owner-b")).toMatchObject({
    status: 409,
    body: { error: { code: "LEASE_HELD" } },
  });
};
const refusedCheckpoint = async (f: Fixture) => {
  const before = f.snapshot();
  const effects = f.observeEffects();
  const reply = await checkpoint(f);
  expect(reply).toMatchObject(refused);
  expect(exited(reply)).toBe(1);
  expect(effects()).toEqual(noWrites);
  expect(f.snapshot()).toEqual(before);
  expect(stagingTables(f)).toEqual([]);
};

test(
  "v3 cold recovery after two checkpoints serves the honest history and replays every typed request",
  () =>
    typedFixture(async (f) => {
      const originals = await kBuild(f, true);
      const warm = await view(f);
      expect(warm).toMatchObject({ coveredHead: 11, image: { head: 13 } });
      const replayAll = async () => {
        const out = [];
        for (const body of kOrder) out.push(await typed(f, body));
        return out;
      };
      let effects = f.observeEffects();
      const replays = await replayAll();
      expect(effects()).toEqual(noWrites);
      expect(replays.map(({ status }) => status)).toEqual([
        200, 400, 409, 409, 404, 200,
      ]);
      expect(replays.map(exited)).toEqual([0, 6, 4, 4, 3, 0]);
      expect(replays[2]).toMatchObject({
        body: { error: { code: "LEASE_NOT_HELD" } },
      });
      expect(replays[3]).toMatchObject({
        body: { error: { code: "LEASE_STALE" } },
      });
      for (const i of [0, 1, 2, 4, 5]) expect(replays[i]).toEqual(originals[i]);
      expect(originals[3]!.status).toBe(200);
      expect(receiptOf(f, 2).result).toMatchObject({
        title: "After",
        revision: 2,
      });
      f.restart();
      effects = f.observeEffects();
      expect(await view(f)).toEqual(warm);
      expect(await replayAll()).toEqual(replays);
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 cold recovery refuses an edited record value that was re-signed with its directory entry",
  () =>
    typedFixture(async (f) => {
      await kBuild(f);
      const before = await refusesCold(f, editedTitle);
      const effects = f.observeEffects();
      const reply = await typed(f, kRequests.create);
      expect(reply).toMatchObject(refused);
      expect(exited(reply)).toBe(1);
      expect(effects()).toEqual(noWrites);
      expect(f.snapshot()).toEqual(before);
    }),
  timeout,
);

for (const slot of ["record", "outcome"] as const)
  test(
    `v3 checkpoint refuses an edited ${slot} value before staging anything`,
    () =>
      typedFixture(async (sibling) => {
        await kBuild(sibling, true);
        expect(await checkpoint(sibling)).toMatchObject({ status: 200 });
        await typedFixture(async (f) => {
          await kBuild(f, true);
          const { key } = receiptOf(f, 1);
          tamperRoot(f, (data) =>
            slot === "record"
              ? editedTitle(data)
              : editProjection(data, "outcome", key, (body) =>
                  body.replace('"title":"A"', '"title":"B"'),
                ),
          );
          await refusedCheckpoint(f);
        });
      }),
    timeout,
  );

test(
  "v3 archived check accepts the honest image and refuses an edited one through the pass 2 call shape",
  () =>
    typedFixture(async (f) => {
      await kBuild(f);
      const db = writableStore(f.storage);
      const failure = () =>
        new ForgeFailure({
          code: "UNAVAILABLE",
          message: "direct check refusal",
          retry: "never",
        });
      const run = () => {
        const check = archivedCheck(db, {
          admit: Project.admitLeaseRequest,
          failure,
          pages: new Map(pages(f).map(({ id, body }) => [id, body])),
        });
        const { coveredHead } = readV3Root(db, f.seal());
        return recoverV3(db, f.seal(), check, {
          through: coveredHead,
        });
      };
      expect(run().head).toBe(11);
      tamperRoot(f, editedTitle);
      const effects = f.observeEffects();
      let thrown: unknown;
      try {
        run();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ForgeFailure);
      expect((thrown as ForgeFailure).error).toMatchObject({
        code: "UNAVAILABLE",
        message: "direct check refusal",
      });
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

const coldCases: [string, Edit, ((r: Json) => void)?][] = [
  [
    "a snapshot roster hash that differs from its bytes",
    () => undefined,
    (r) => {
      (r.pages as Json[])[1]!.hash = digestBytes("another snapshot");
    },
  ],
  [
    "a public digest that differs from the projection of the history",
    (_, r) => {
      r.publicDigest = digestBytes("another projection");
    },
  ],
  [
    "an event watermark one above the history",
    (_, r) => {
      r.eventWatermark = Number(r.eventWatermark) + 1;
    },
  ],
  [
    "a transcript digest that differs from the transcript bytes",
    (_, r) => {
      r.transcriptDigest = digestBytes("another transcript");
    },
  ],
  [
    "a directory revision that differs from the history",
    (data) => {
      const entries = JSON.parse(data.pages[0]!.body) as DirectoryItem[];
      entries.find(({ key }) => key === "r1")!.revision = 2;
      data.pages[0]!.body = canonicalJson(entries);
    },
  ],
  [
    "a transcript with a leading space",
    (data, r) => {
      data.pages[2]!.body = ` ${data.pages[2]!.body}`;
      r.transcriptDigest = digestBytes(data.pages[2]!.body);
    },
  ],
];

for (const [name, edit, late] of coldCases)
  test(
    `v3 cold recovery refuses ${name}`,
    () =>
      typedFixture(async (f) => {
        await smallHistory(f);
        await refusesCold(f, edit, late);
      }),
    timeout,
  );

test(
  "v3 cold recovery refuses an overwritten receipt whose archived digest was edited",
  () =>
    typedFixture(async (f) => {
      await grantTypedUpdate(f);
      setSystemTime(E1 + 1);
      expect((await typed(f, missingUpdate, E1 + HOUR)).status).toBe(404);
      await drain(f, 4, 5);
      await refusesCold(f, (data, r) =>
        reTranscript(data, r, (frames) => {
          (frames[2]!.outcome as Json).resultDigest =
            digestBytes("different update");
        }),
      );
    }),
  timeout,
);

test(
  "v3 cold recovery maps a broken saved command refusal to the cold refusal",
  () =>
    typedFixture(async (f) => {
      expect((await typed(f, missingUpdate)).status).toBe(404);
      await drain(f, 0, 1);
      const before = await refusesCold(f, (d) =>
        editProjection(d, "outcome", refusalEntry(d).item.key, brokenJson),
      );
      const effects = f.observeEffects();
      const reply = await typed(f, missingUpdate);
      expect(reply).toMatchObject(refused);
      expect(exited(reply)).toBe(1);
      expect(effects()).toEqual(noWrites);
      expect(f.snapshot()).toEqual(before);
    }),
  timeout,
);

test(
  "v3 cold recovery refuses an edited lease refusal message in the uncheckpointed tail",
  () =>
    withFixture(async (f) => {
      await refusalSource(f);
      f.restart();
      expect((await f.send(probe)).status).toBe(200);
      const parsed = JSON.parse(commits(f)[1]!.body) as Json;
      const result = (parsed.outcome as Json).result as Json;
      result.message = `${String(result.message)}!`;
      const body = canonicalJson(parsed);
      f.db.run("UPDATE cloud_v3_commits SET body=?, mac=? WHERE sequence=2", [
        body,
        f.sign(2, body),
      ]);
      f.restart();
      await coldRefused(f);
    }),
  timeout,
);

test(
  "v3 cold recovery refuses an edited lease refusal digest in the archived transcript",
  () =>
    withFixture(async (f) => {
      await refusalSource(f);
      await drain(f, 0, 2);
      await refusesCold(f, (data, r) =>
        reTranscript(data, r, differentRefusal),
      );
    }),
  timeout,
);

test(
  "v3 checkpoint refuses an edited lease refusal digest in the archived transcript",
  () =>
    withFixture(async (sibling) => {
      const build = async (f: Fixture) => {
        await refusalSource(f);
        await drain(f, 0, 2);
        ok(await append(f, frame()));
      };
      await build(sibling);
      expect(await checkpoint(sibling)).toMatchObject({ status: 200 });
      await withFixture(async (f) => {
        await build(f);
        tamperRoot(f, (data, r) => reTranscript(data, r, differentRefusal));
        await refusedCheckpoint(f);
      });
    }),
  timeout,
);

test(
  "v3 cold recovery serves a fresh genesis root and its first checkpoint succeeds",
  () =>
    withFixture(async (f) => {
      f.restart();
      const effects = f.observeEffects();
      expect(await view(f)).toMatchObject({
        coveredHead: 0,
        image: { head: 0 },
      });
      expect(effects()).toEqual(noWrites);
      ok(await append(f, frame()));
      expect(await checkpoint(f)).toMatchObject({ status: 200 });
    }),
  timeout,
);

test(
  "v3 cold recovery refuses a genesis transcript replaced by a same-length body",
  () =>
    withFixture(async (f) => {
      f.restart();
      expect((await f.send(probe)).status).toBe(200);
      f.db.run("UPDATE cloud_v3_pages SET body='{}' WHERE id='transcript:0'");
      f.restart();
      await coldRefused(f);
    }),
  timeout,
);

async function activatedScene(
  run: (
    copy: () => Promise<Fixture>,
    scene: { data: Portable; replies: { status: number; body: unknown }[] },
  ) => Promise<void>,
) {
  const source = guardFixture(typedEnv);
  using _source = source.db;
  expect(await source.send(probe, {})).toMatchObject({ status: 200 });
  const raw = (route: string, input: Json) =>
    rawLease(source, route, "owner-a", { ttlMs: HOUR, ...input });
  const replies = [
    await typed(source, createBody),
    await typed(source, missingUpdate),
  ];
  ok(await raw("claim", { requestId: "m-raw" }));
  replies.push(
    await typed(source, { ...grantedUpdate, requestId: "m-update" }),
  );
  ok(await raw("renew", { requestId: "m-renew", generation: 1 }));
  ok(await raw("release", { requestId: "m-release", generation: 1 }));
  replies.push(await typed(source, issueClaim));
  ok(await append(source, frame()));
  await drain(source, 0, 8);
  const data = typedBackup(source);
  editHistory(data, (frames) => {
    for (const [i, row] of frames.entries())
      if (row.operation === "fixture.note")
        frames[i] = { sequence: row.sequence };
  });
  const copy = async () => {
    const target = guardFixture(typedEnv);
    const upload = await stageRestore(target, data);
    setSystemTime(T0 + 1);
    expect(await upload(2)).toMatchObject(restoreResult(2, true));
    return target;
  };
  await run(copy, { data, replies });
}

test(
  "v3 activated recovery folds in portable mode and replays the imported receipts",
  () =>
    activatedScene(async (copy, { data, replies }) => {
      const target = await copy();
      using _target = target.db;
      target.restart();
      const effects = target.observeEffects();
      expect(await view(target)).toMatchObject({
        image: {
          head: data.head + 1,
          eventWatermark: data.eventWatermark + 1,
        },
      });
      const replay = [
        await typed(target, createBody),
        await typed(target, missingUpdate),
        await typed(target, { ...grantedUpdate, requestId: "m-update" }),
        await typed(target, issueClaim),
      ];
      expect(effects()).toEqual(noWrites);
      expect(replay.slice(0, 2)).toEqual([replies[0]!, replies[1]!]);
      for (const stale of replay.slice(2)) {
        expect(stale).toMatchObject({
          status: 409,
          body: { error: { code: "LEASE_STALE" } },
        });
        expect(exited(stale)).toBe(4);
      }
      expect(receiptOf(target, 1).result).toMatchObject({
        id: "forge-1",
        title: "A",
      });
      expect(receiptOf(target, 2).result).toMatchObject({
        title: "After",
        revision: 2,
      });
      const db = writableStore(target.storage);
      expect(
        readV3Value(db, recovered(db, target.seal()), "lease", "issue:work-1"),
      ).toHaveProperty("releasedAt", iso(T0 + 1));
    }),
  timeout,
);

test(
  "v3 activated recovery refuses an edited record value",
  () =>
    activatedScene(async (copy) => {
      const target = await copy();
      using _target = target.db;
      await refusesCold(target, editedTitle);
    }),
  timeout,
);

test(
  "v3 activated recovery maps a broken saved command refusal to the cold refusal",
  () =>
    activatedScene(async (copy) => {
      const target = await copy();
      using _target = target.db;
      await refusesCold(target, (d) =>
        editProjection(d, "outcome", refusalEntry(d).item.key, brokenJson),
      );
    }),
  timeout,
);

const storedImage = (f: Fixture) =>
  recovered(writableStore(f.storage), f.seal());
const sealedComponent = (f: Fixture) =>
  recoverV3(writableStore(f.storage), f.seal(), {
    admit: Project.admitLeaseRequest,
    sealed: () => undefined,
  });

function activationRow(root: Json, sequence: number, time: number) {
  const control = controlGlobal(root.incarnation, time);
  return {
    format: "forge-cloud-commit/3",
    operation: "restore.activate",
    restoreEpoch: root.restoreEpoch,
    sequence,
    time,
    control,
    events: [
      {
        type: "lane.stop",
        actor: "restore",
        scope: "all",
        at: control.stopAll,
      },
    ],
  };
}

function replaceSignedFrame(
  f: Fixture,
  r: Json,
  sequence: number,
  frame: Json,
) {
  const body = canonicalJson(frame);
  f.db.run("UPDATE cloud_v3_commits SET body=?, mac=? WHERE sequence=?", [
    body,
    signRow(f.seal(), r.incarnation, sequence, body),
    sequence,
  ]);
  return digestBytes(body);
}

const withActivation = (
  use: (scene: {
    target: Fixture;
    image: ReturnType<typeof recoverV3>;
    upload: Awaited<ReturnType<typeof stageRestore>>;
    sourceIncarnation: unknown;
  }) => void | Promise<void>,
) =>
  withPortable(async (target, data, source) => {
    const upload = await stageRestore(target, data);
    setSystemTime(T0 + 1);
    const final = await upload(2);
    expect(final).toMatchObject(restoreResult(2, true));
    expect(exited(final)).toBe(0);
    const image = storedImage(target);
    expect([image.head, image.eventWatermark, image.recordFloor]).toEqual([
      data.head + 1,
      data.eventWatermark + 1,
      data.recordFloor,
    ]);
    expect(commits(target)).toEqual([
      {
        sequence: image.head,
        body: canonicalJson(activationRow(image.root, image.head, T0 + 1)),
      },
    ]);
    const from = writableStore(source.storage);
    const to = writableStore(target.storage);
    const origin = storedImage(source);
    for (const key of origin.entries.lease.keys()) {
      const lease = readV3Value(from, origin, "lease", key)!;
      expect(readV3Value(to, image, "lease", key)).toEqual({
        ...lease,
        releasedAt: lease.releasedAt ?? iso(T0 + 1),
      });
    }
    await use({
      target,
      image,
      upload,
      sourceIncarnation: origin.root.incarnation,
    });
  });

const servedControl = (image: ReturnType<typeof recoverV3>) =>
  (viewV3(image).image as Json).control;

test(
  "v3 activation serves control on warm and cold reads and final retry",
  () =>
    withActivation(async ({ target, image, upload }) => {
      const before = target.observeEffects();
      await view(target);
      const warm = await view(target);
      target.restart();
      expect(await view(target)).toEqual(warm);
      const retry = await upload(2);
      expect(retry).toMatchObject(restoreResult(2, true));
      expect(exited(retry)).toBe(0);
      expect(before()).toEqual(noWrites);
      const global = controlGlobal(image.root.incarnation, T0 + 1);
      expect(warm.image.control).toEqual(controlDigest(global));
      expect(
        controlSlot(writableStore(target.storage), storedImage(target)),
      ).toEqual(global);
    }),
  timeout,
);

type ControlEntry = readonly [key: string, value: Json];
function addSnapshotControl(
  data: Portable,
  controls: readonly ControlEntry[],
  swapped = false,
) {
  const [directory, snapshot] = data.pages;
  const old = JSON.parse(directory!.body) as DirectoryItem[];
  let offset = 0;
  const bodies = controls.map(([, value]) => canonicalJson(value));
  const added = controls.map<DirectoryItem>(([key], i) => {
    const body = bodies[i]!;
    const length = Buffer.byteLength(body);
    const entry = {
      collection: "control",
      key,
      offset,
      length,
      page: snapshot!.id,
      digest: digestBytes(body),
    };
    offset += length;
    return entry;
  });
  for (const entry of old)
    if (entry.offset !== undefined) entry.offset += offset;
  const entries = swapped ? [...old, ...added] : [...added, ...old];
  directory!.body = canonicalJson(entries);
  snapshot!.body = bodies.join("") + snapshot!.body;
  data.publicDigest = digestValue(
    entries.map(({ collection, key, digest, revision }) => [
      collection,
      key,
      entryDigest(digest ?? null, revision),
    ]),
  );
  return entries;
}

function addRootControl(
  f: Fixture,
  controls: readonly ControlEntry[],
  swapped = false,
) {
  tamperRoot(f, (data, r) => {
    const entries = addSnapshotControl(data, controls, swapped);
    const listed = r.pages as Json[];
    const ends = [entries[0]!, entries.at(-1)!].map(({ collection, key }) => [
      collection,
      key,
    ]);
    [listed[0]!.first, listed[0]!.last] = ends;
    listed[0]!.count = entries.length;
    listed[1]!.count = entries.filter(({ page }) => page !== undefined).length;
    r.counts = Object.fromEntries(
      listed.map(({ kind, count }) => [String(kind), count]),
    );
    r.publicDigest = data.publicDigest;
  });
}

const issueControl = (incarnation: unknown, id = "work-1") => ({
  version: 1,
  id,
  incarnation,
  epoch: 1,
  stoppedAt: iso(T0),
});

test.each([
  ["imported slots", true],
  ["empty control", false],
] as const)(
  "v3 activation serves only its global with %s",
  (_label, imported) =>
    withActivation(({ target, image, sourceIncarnation }) => {
      if (imported)
        addRootControl(target, [
          ["global", controlGlobal(sourceIncarnation, T0)],
          ["issue:work-1", issueControl(sourceIncarnation)],
        ]);
      const before = target.observeEffects();
      const actual = imported ? sealedComponent(target) : storedImage(target);
      const { control: _expected, ...ordinary } = viewV3(image).image as Json;
      const { control: _actual, ...kept } = viewV3(actual).image as Json;
      expect(kept).toEqual(ordinary);
      expect(before()).toEqual(noWrites);
      const global = controlGlobal(image.root.incarnation, T0 + 1);
      expect(servedControl(actual)).toEqual(controlDigest(global));
      expect(controlSlot(writableStore(target.storage), actual)).toEqual(
        global,
      );
    }),
  timeout,
);

const controlVariants = [
  ["global", controlGlobal("x".repeat(257), T0)],
  ["issue:work-1", issueControl("source", "work-2")],
  ["global", controlGlobal("source", T0)],
] as const satisfies readonly ControlEntry[];

function unavailableRead(read: () => unknown) {
  try {
    read();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    expect((error as ForgeFailure).error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Cloud v3 root is unavailable",
    });
    return;
  }
  throw new Error("Expected an unavailable v3 root");
}

test.each([
  ["ordered", false, undefined],
  ["swapped", true, undefined],
  ["malformed global", false, controlVariants[0]],
  ["mismatched issue", false, controlVariants[1]],
] as const)(
  "v3 component recovery checks %s control slots",
  (_label, swapped, malformed) =>
    withPortable((_target, _data, source) => {
      const origin = storedImage(source);
      const global = controlGlobal(origin.root.incarnation, T0);
      const issue = issueControl(origin.root.incarnation);
      const valid = [
        ["global", global],
        ["issue:work-1", issue],
      ] as const;
      addRootControl(
        source,
        valid.map((slot) => (malformed?.[0] === slot[0] ? malformed : slot)),
        swapped,
      );
      const before = source.observeEffects();
      if (swapped) unavailableRead(() => sealedComponent(source));
      else {
        const image = sealedComponent(source);
        const db = writableStore(source.storage);
        for (const [key, value] of valid)
          if (key !== malformed?.[0])
            expect(controlSlot(db, image, key)).toEqual(value);
        if (malformed)
          unavailableRead(() => controlSlot(db, image, malformed[0]));
        else
          expect((viewV3(image).image as Json).lease).toEqual(
            (viewV3(origin).image as Json).lease,
          );
      }
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

async function rejectedFinalPage(target: Fixture, data: Portable) {
  const upload = await stageRestore(target, data);
  const reset = observeRestoreReset(target);
  const reply = await upload(2);
  expect(reply).toMatchObject(restoreRefusal);
  expect(exited(reply)).toBe(1);
  reset();
  await unprovisioned(target);
}

for (const mode of ["cold", "portable"] as const)
  test.each(controlVariants)(
    "v3 " + mode + " recovery refuses unearned snapshot %s",
    (key, value) =>
      withPortable(async (target, data, source) => {
        if (mode === "portable") {
          addSnapshotControl(data, [[key, value]]);
          await rejectedFinalPage(target, data);
        } else {
          await view(source);
          addRootControl(source, [[key, value]]);
          await coldRefused(source);
        }
      }),
    timeout,
  );

test.each([
  ["epoch", 2],
  ["stopAll", iso(T0 + 2)],
  ["incarnation", "different"],
] as const)(
  "v3 recovery rejects authenticated activation with changed control %s",
  (key, value) =>
    withActivation(async ({ target, image }) => {
      tamperRoot(target, (_data, r) => {
        const row = activationRow(r, image.head, T0 + 1);
        r.activationDigest = replaceSignedFrame(target, r, image.head, {
          ...row,
          control: { ...row.control, [key]: value },
        });
      });
      await coldRefused(target);
    }),
  timeout,
);

test.each([
  [1632, "\ud800".repeat(256)],
  [1024, "\ud800".repeat(154) + "abcd"],
] as const)(
  "v3 recovery enforces the bound for %i activation control bytes",
  (bytes, incarnation) =>
    withActivation(async ({ target, image }) => {
      await withFixture((fresh) => {
        tamperRoot(target, (_data, r) => {
          const genesis = JSON.parse(root(fresh).body) as Json;
          Object.assign(r, {
            incarnation,
            parentDigest: digestValue({
              ...genesis,
              incarnation,
              restoreEpoch: r.restoreEpoch,
            }),
          });
          const row = activationRow(r, image.head, T0 + 1);
          expect(Buffer.byteLength(canonicalJson(row.control))).toBe(bytes);
          r.activationDigest = replaceSignedFrame(target, r, image.head, row);
        });
      });
      if (bytes > 1024) await coldRefused(target);
      else {
        const before = target.observeEffects();
        expect((await view(target)).image.control).toEqual(
          controlDigest(controlGlobal(incarnation, T0 + 1)),
        );
        expect(before()).toEqual(noWrites);
      }
    }),
  timeout,
);

test.each([
  ["activation", { ...frame(), operation: "restore.activate" }],
  ["promotion", { ...frame(), operation: "restore.promote" }],
  ["control field", { ...frame(), control: controlGlobal("source", T0) }],
] as const)(
  "v3 append refuses %s without writing",
  (_label, candidate) =>
    withFixture(async (f) => {
      const before = f.observeEffects();
      const reply = await append(f, candidate);
      expect(reply).toMatchObject({
        status: 400,
        body: { error: { code: "INPUT_INVALID" } },
      });
      expect(exited(reply)).toBe(6);
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

test.each([
  ["root incarnation", undefined],
  ["padded incarnation", " padded "],
  ["oversized incarnation", "\ud800".repeat(256)],
] as const)(
  "v3 absent global uses the validator for %s",
  (_label, incarnation) =>
    withFixture(async (f) => {
      await smallHistory(f);
      if (incarnation !== undefined)
        tamperRoot(f, (_data, root) => {
          root.incarnation = incarnation;
        });
      const before = f.observeEffects();
      const db = writableStore(f.storage);
      for (const image of [storedImage(f), storedImage(f)]) {
        const expected = {
          version: 1,
          incarnation: image.root.incarnation,
          epoch: 0,
          resumeAllEpoch: 0,
          stopAll: null,
        };
        const projection = viewV3(image);
        expect(readV3Value(db, image, "record", "r1")).toBe("x");
        if (incarnation === undefined) {
          const global = readV3GlobalControl(db, image);
          expect<unknown>(global).toEqual(expected);
          expect(readLaneControl(global, undefined)).toMatchObject({
            ok: true,
            result: { stopped: false },
          });
        } else {
          if (incarnation.length === 256)
            expect(Buffer.byteLength(canonicalJson(expected))).toBeGreaterThan(
              1_024,
            );
          unavailableRead(() => readV3GlobalControl(db, image));
        }
        expect(image.entries.control.size).toBe(0);
        expect(viewV3(image)).toEqual(projection);
      }
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

test.each([
  ["valid", false],
  ["malformed", true],
] as const)(
  "v3 global reader keeps %s pointer-backed control distinct from absence",
  (_label, malformed) =>
    withPortable((_target, _data, source) => {
      const value = malformed
        ? controlVariants[0][1]
        : controlGlobal("stored", T0);
      addRootControl(source, [["global", value]]);
      const before = source.observeEffects();
      const db = writableStore(source.storage);
      for (const image of [sealedComponent(source), sealedComponent(source)]) {
        const projection = viewV3(image);
        if (malformed) unavailableRead(() => readV3GlobalControl(db, image));
        else expect<unknown>(readV3GlobalControl(db, image)).toEqual(value);
        expect([...image.entries.control.keys()]).toEqual(["global"]);
        expect(viewV3(image)).toEqual(projection);
      }
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 checkpoints keep the four-collection digest for empty control",
  () =>
    withFixture(async (f) => {
      await smallHistory(f);
      const saved = pages(f);
      const bodies = new Map(
        saved.map(({ id, body }) => [id, Buffer.from(body)]),
      );
      const legacyProjection = () =>
        digestProjection(
          inventory(storedImage(f), bodies, [
            "lease",
            "outcome",
            "record",
            "witness",
          ]),
        );
      const publicDigest = () =>
        readV3Root(writableStore(f.storage), f.seal()).publicDigest;
      const expected = digestValue([
        ["record", "r1", digestValue([1, digestValue("x")])],
      ]);
      expect(publicDigest()).toBe(expected);
      expect(legacyProjection()).toBe(expected);
      ok(await checkpoint(f));
      expect(publicDigest()).toBe(expected);
      f.restart();
      const before = f.observeEffects();
      expect(pages(f)).toEqual(saved);
      expect(publicDigest()).toBe(expected);
      expect(legacyProjection()).toBe(expected);
      expect((await view(f)).image.control).toEqual({});
      expect(before()).toEqual(noWrites);
    }),
  timeout,
);

for (const mode of ["live", "archived", "portable"] as const)
  test.each([["restore.activate"], ["restore.promote"]] as const)(
    "v3 " + mode + " history refuses %s without a promotion proof",
    (operation) =>
      withFixture(async (source) => {
        ok(await append(source, putRecord("r1", 1, "x"), frame()));
        if (mode !== "live") await drain(source, 0, 2);
        if (mode !== "portable") {
          source.restart();
          const before = source.observeEffects();
          ok(await source.send(probe));
          expect(before()).toEqual(noWrites);
        }

        const db = writableStore(source.storage);
        const r = JSON.parse(root(source).body) as Json;
        const activation = { ...activationRow(r, 2, T0), events: [] };
        const candidate =
          operation === "restore.activate"
            ? activation
            : {
                format: activation.format,
                operation,
                sequence: 2,
                time: T0,
                events: [],
                activationDigest: digestValue(activation),
              };

        if (mode === "live") {
          const recoverThrough = (through: number) =>
            recoverV3(
              db,
              source.seal(),
              { admit: Project.admitLeaseRequest, sealed: () => undefined },
              { through },
            );
          replaceSignedFrame(source, r, 2, candidate);
          source.restart();
          expect(recoverThrough(1).head).toBe(1);
          unavailableRead(() => recoverThrough(2));
          await coldRefused(source);
          return;
        }

        const fold = (frames: Json[]) =>
          foldTranscript(db, frames, mode, Project.admitLeaseRequest);
        const replaceNote = (frames: Json[]) => {
          expect(fold(frames).head).toBe(2);
          frames[1] = candidate;
          unavailableRead(() => fold(frames));
        };
        if (mode === "archived") {
          tamperRoot(source, (data, root) =>
            reTranscript(data, root, replaceNote),
          );
          await coldRefused(source);
          return;
        }

        const data = typedBackup(source);
        editHistory(data, (frames) => {
          frames[1] = { sequence: 2 };
        });
        const honest = guardFixture();
        using _honest = honest.db;
        const upload = await stageRestore(honest, data);
        const final = await upload(2);
        expect(final).toMatchObject(restoreResult(2, true));
        expect(exited(final)).toBe(0);
        expect(
          readV3Value(
            writableStore(honest.storage),
            storedImage(honest),
            "record",
            "r1",
          ),
        ).toBe("x");

        editHistory(data, replaceNote);
        const target = guardFixture();
        using _target = target.db;
        await rejectedFinalPage(target, data);
      }),
    timeout,
  );

const restoreOperations = [
  "restore.activate",
  "restore.promote",
  "restore.future",
] as const;
const invalidAppend = { code: "INPUT_INVALID", message: "Invalid v3 frame" };

function observeAppendGuard(f: Fixture) {
  const effects = f.observeEffects();
  const rows = commits(f);
  const transaction = f.storage.transactionSync.bind(f.storage);
  let transactions = 0;
  f.storage.transactionSync = (body) => {
    transactions++;
    return transaction(body);
  };
  return () => {
    expect(transactions).toBe(0);
    expect(effects()).toEqual(noWrites);
    expect(commits(f)).toEqual(rows);
  };
}

function invalidRestoreAppend(write: () => unknown) {
  try {
    write();
  } catch (error) {
    expect(error).toBeInstanceOf(ForgeFailure);
    expect((error as ForgeFailure).error).toMatchObject(invalidAppend);
    return;
  }
  throw new Error("Expected the restore append to fail");
}

test.each(restoreOperations)(
  "v3 probe rejects %s before opening an append transaction",
  (operation) =>
    withFixture(async (f) => {
      ok(await append(f, frame()));
      const before = await view(f);
      const unchanged = observeAppendGuard(f);
      const reply = await append(f, { ...frame(), operation });
      expect(reply).toMatchObject({
        status: 400,
        body: { ok: false, error: invalidAppend },
      });
      expect(exited(reply)).toBe(6);
      unchanged();
      expect(await view(f)).toEqual(before);
      const next = await append(f, frame());
      ok(next);
      expect(exited(next)).toBe(0);
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([1, 2]);
    }),
  timeout,
);

test.each(restoreOperations)(
  "v3 direct append rejects %s before inspecting a malformed outcome",
  (operation) =>
    withFixture(async (f) => {
      ok(await append(f, frame()));
      const image = storedImage(f);
      const unchanged = observeAppendGuard(f);
      invalidRestoreAppend(() =>
        appendFrameBatch(writableStore(f.storage), f.seal(), image, [
          { ...frame(), operation, outcome: {} },
        ]),
      );
      unchanged();
      expect([image.head, image.stale, image.staged]).toEqual([1, false, []]);
      ok(await append(f, frame()));
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([1, 2]);
    }),
  timeout,
);

test.each(restoreOperations)(
  "v3 probe batch containing %s rejects the whole batch before opening a transaction",
  (operation) =>
    withFixture(async (f) => {
      ok(await append(f, frame()));
      const image = storedImage(f);
      const unchanged = observeAppendGuard(f);
      invalidRestoreAppend(() =>
        appendProbeBatch(
          writableStore(f.storage),
          f.seal(),
          [frame(), { ...frame(), operation }],
          () => image,
        ),
      );
      unchanged();
      expect([image.head, image.stale, image.staged]).toEqual([1, false, []]);
      ok(await append(f, frame()));
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([1, 2]);
    }),
  timeout,
);

async function coldActivationRefused(target: Fixture) {
  target.restart();
  const before = target.snapshot();
  const effects = target.observeEffects();
  const reply = await target.send(probe);
  expect(reply).toMatchObject({
    status: 503,
    body: {
      ok: false,
      error: { code: "UNAVAILABLE", message: "Cloud v3 root is unavailable" },
    },
  });
  expect(exited(reply)).toBe(1);
  expect(effects()).toEqual(noWrites);
  expect(target.snapshot()).toEqual(before);
}

function rebindActivation(
  target: Fixture,
  genesis: Json,
  sequence: number,
  incarnation: unknown,
  restoreEpoch: string,
) {
  tamperRoot(target, (_data, r) => {
    Object.assign(r, {
      incarnation,
      restoreEpoch,
      parentDigest: digestValue({ ...genesis, incarnation, restoreEpoch }),
    });
    r.activationDigest = replaceSignedFrame(
      target,
      r,
      sequence,
      activationRow(r, sequence, T0 + 1),
    );
  });
  expect(
    readV3Root(writableStore(target.storage), target.seal()),
  ).toMatchObject({
    incarnation,
    restoreEpoch,
  });
}

test.each([
  ["leading space", " E1"],
  ["257 characters", "E".repeat(257)],
  ["control character", "E\u0001"],
] as const)(
  "v3 cold activation rejects an epoch with %s",
  (_label, restoreEpoch) =>
    withActivation(({ target, image }) =>
      withFixture(async (fresh) => {
        const genesis = JSON.parse(root(fresh).body) as Json;
        const { incarnation } = image.root;
        rebindActivation(
          target,
          genesis,
          image.head,
          incarnation,
          "E".repeat(256),
        );
        const honest = target.observeEffects();
        const reply = await target.send(probe);
        ok(reply);
        expect(exited(reply)).toBe(0);
        expect(honest()).toEqual(noWrites);
        rebindActivation(
          target,
          genesis,
          image.head,
          incarnation,
          restoreEpoch,
        );
        await coldActivationRefused(target);
      }),
    ),
  timeout,
);

test(
  "v3 cold activation accepts 2048 canonical bytes and rejects 2049",
  () =>
    withActivation(({ target, image }) =>
      withFixture(async (fresh) => {
        const genesis = JSON.parse(root(fresh).body) as Json;
        const restoreEpoch = "\ud800".repeat(256);
        expect(
          readLaneControl(controlGlobal(restoreEpoch, T0), undefined).ok,
        ).toBe(true);
        const baseline = activationRow(
          { incarnation: "", restoreEpoch },
          image.head,
          T0 + 1,
        );
        for (const bytes of [2048, 2049]) {
          const incarnation = "I".repeat(
            bytes - Buffer.byteLength(canonicalJson(baseline)),
          );
          rebindActivation(
            target,
            genesis,
            image.head,
            incarnation,
            restoreEpoch,
          );
          const { body } = commits(target)[0]!;
          expect(Buffer.byteLength(body)).toBe(bytes);
          const { control } = JSON.parse(body) as Json;
          expect(Buffer.byteLength(canonicalJson(control))).toBeLessThanOrEqual(
            1024,
          );
          expect(readLaneControl(control, undefined).ok).toBe(true);
          if (bytes === 2048) {
            const honest = target.observeEffects();
            const reply = await target.send(probe);
            ok(reply);
            expect(exited(reply)).toBe(0);
            expect(honest()).toEqual(noWrites);
          } else await coldActivationRefused(target);
        }
      }),
    ),
  timeout,
);

test(
  "v3 cold activation rejects a safe integer outside the Date range",
  () =>
    withActivation(async ({ target, image }) => {
      tamperRoot(target, (_data, r) => {
        const row = activationRow(r, image.head, T0 + 1);
        r.activationDigest = replaceSignedFrame(target, r, image.head, {
          ...row,
          time: 8_640_000_000_000_001,
        });
      });
      await coldActivationRefused(target);
    }),
  timeout,
);

type FoldObservation = {
  context: string;
  segmentIncarnation?: string;
  incarnations: Set<string>;
  restoreEpochs: Set<string>;
  approvalIds: Set<string>;
  pending?: unknown;
};

function observedFold(image: ReturnType<typeof recoverV3>): unknown {
  const fold = (image as { fold?: FoldObservation }).fold;
  return (
    fold && {
      context: fold.context,
      segmentIncarnation: fold.segmentIncarnation,
      incarnations: [...fold.incarnations].sort(),
      restoreEpochs: [...fold.restoreEpochs].sort(),
      approvalIds: [...fold.approvalIds].sort(),
      pending: fold.pending,
    }
  );
}

test(
  "v3 activated root retains fold lineage and one pending activation on warm and cold reads",
  () =>
    activatedScene(async (copy, { data }) => {
      const target = await copy();
      using _target = target.db;
      const warm = storedImage(target);
      const warmReply = await view(target);
      target.restart();
      const effects = target.observeEffects();
      const coldReply = await view(target);
      const cold = storedImage(target);
      const { incarnation, restoreEpoch, activationDigest } = warm.root;
      const sequence = data.head + 1;
      const time = T0 + 1;
      expect(commits(target)).toEqual([
        {
          sequence,
          body: canonicalJson(activationRow(warm.root, sequence, time)),
        },
      ]);
      expect(activationDigest).toBe(digestBytes(commits(target)[0]!.body));
      expect(coldReply).toEqual(warmReply);
      expect(coldReply).toMatchObject({
        publicDigest: data.publicDigest,
        image: {
          head: sequence,
          eventWatermark: data.eventWatermark + 1,
          control: controlDigest(controlGlobal(incarnation, time)),
        },
      });
      expect(effects()).toEqual(noWrites);
      for (const image of [warm, cold]) {
        expect<unknown>(viewV3(image)).toEqual(warmReply);
        expect(observedFold(image)).toEqual({
          context: "rooted",
          segmentIncarnation: incarnation,
          incarnations: [incarnation],
          restoreEpochs: [restoreEpoch],
          approvalIds: [],
          pending: { sequence, time, digest: activationDigest },
        });
      }
    }),
  timeout,
);

test(
  "v3 ordinary root retains its own fold lineage on warm and cold reads",
  () =>
    withFixture(async (f) => {
      ok(await append(f, putRecord("r1", 1, "x"), frame(), frame()));
      await drain(f, 0, 3);
      const warm = storedImage(f);
      const warmReply = await view(f);
      f.restart();
      const effects = f.observeEffects();
      const coldReply = await view(f);
      const cold = storedImage(f);
      const record = entryDigest(digestValue("x"), 1);
      expect(coldReply).toEqual(warmReply);
      expect(coldReply).toMatchObject({
        publicDigest: digestValue([["record", "r1", record]]),
        image: { head: 3, eventWatermark: 1, record: { r1: record } },
      });
      expect(effects()).toEqual(noWrites);
      for (const image of [warm, cold]) {
        expect<unknown>(viewV3(image)).toEqual(warmReply);
        expect(observedFold(image)).toEqual({
          context: "rooted",
          segmentIncarnation: warm.root.incarnation,
          incarnations: [warm.root.incarnation],
          restoreEpochs: [],
          approvalIds: [],
          pending: undefined,
        });
      }
    }),
  timeout,
);

test(
  "v3 portable fold starts without a source segment incarnation",
  () =>
    withFixture((f) => {
      const effects = f.observeEffects();
      const image = foldTranscript(
        writableStore(f.storage),
        [{ sequence: 1 }, { sequence: 2 }],
        "portable",
        Project.admitLeaseRequest,
      );
      expect([image.head, image.eventWatermark]).toEqual([2, 0]);
      expect(effects()).toEqual(noWrites);
      expect(observedFold(image)).toEqual({
        context: "portable",
        segmentIncarnation: undefined,
        incarnations: [],
        restoreEpochs: [],
        approvalIds: [],
        pending: undefined,
      });
    }),
  timeout,
);

test(
  "v3 cold activation rejects a frame epoch different from the sealed root",
  () =>
    withActivation(async ({ target, image }) => {
      tamperRoot(target, (_data, r) => {
        const row = activationRow(r, image.head, T0 + 1);
        const restoreEpoch =
          image.root.restoreEpoch === "other" ? "new" : "other";
        r.activationDigest = replaceSignedFrame(target, r, image.head, {
          ...row,
          restoreEpoch,
        });
      });
      await coldActivationRefused(target);
    }),
  timeout,
);

test(
  "v3 cold activation rejects an extra commit at the covered head",
  () =>
    withActivation(async ({ target, image }) => {
      const sequence = image.root.coveredHead;
      expect(sequence).toBeGreaterThan(0);
      const body = canonicalJson({
        ...frame(),
        format: "forge-cloud-commit/3",
        sequence,
      });
      target.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
        sequence,
        body,
        target.sign(sequence, body),
      ]);
      await coldActivationRefused(target);
    }),
  timeout,
);

test.each(["live", "archived", "portable"] as const)(
  "v3 %s history refuses an ordinary-shaped restore.future frame",
  (mode) =>
    withFixture(async (source) => {
      ok(await append(source, putRecord("r1", 1, "x"), frame()));
      const r = JSON.parse(root(source).body) as Json;
      const candidate = {
        ...frame(),
        format: "forge-cloud-commit/3",
        operation: "restore.future",
        sequence: 2,
      };
      if (mode === "live") {
        expect((await view(source)).image.head).toBe(2);
        replaceSignedFrame(source, r, 2, candidate);
        await coldActivationRefused(source);
        return;
      }
      await drain(source, 0, 2);
      const fold = (frames: Json[]) =>
        foldTranscript(
          writableStore(source.storage),
          frames,
          mode,
          Project.admitLeaseRequest,
        );
      const replaceNote = (frames: Json[]) => {
        if (mode === "portable") frames[1] = { sequence: 2 };
        expect(fold(frames).head).toBe(2);
        frames[1] = candidate;
        unavailableRead(() => fold(frames));
      };
      if (mode === "archived") {
        expect((await view(source)).image.head).toBe(2);
        tamperRoot(source, (data, sealed) =>
          reTranscript(data, sealed, replaceNote),
        );
        await coldActivationRefused(source);
      } else {
        const data = typedBackup(source);
        editHistory(data, replaceNote);
        const target = guardFixture();
        using _target = target.db;
        await rejectedFinalPage(target, data);
      }
    }),
  timeout,
);

type PromotionFold = NonNullable<V3Image["fold"]> & { segmentEpoch?: string };
type Discovery = { current: boolean };
type CoveredContext = { root: V3Image["root"]; boundary?: number };
const foldPromotionHistory: (
  ...args: [...Parameters<typeof foldTranscript>, context?: CoveredContext]
) => V3Image = foldTranscript;

const fixtureRow = (sequence: number): Json => ({
  ...frame(),
  format: "forge-cloud-commit/3",
  sequence,
});
const activationIdentity = (number: number) => ({
  incarnation: `promotion-incarnation-${number}`,
  restoreEpoch: `promotion-epoch-${number}`,
});
const approvalId = (number: number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function promotionPair(
  head: number,
  number: number,
  identity = activationIdentity(number),
  activationTime = T0 + number * 10,
) {
  const activation = activationRow(identity, head + 1, activationTime);
  const sequence = head + 2;
  const time = activation.time + 2;
  const activationDigest = digestValue(activation);
  const principal = digestValue(["promotion-owner", number]);
  const promote = {
    ...fixtureRow(sequence),
    operation: "restore.promote",
    sequence,
    time,
    activationDigest,
    approval: {
      id: approvalId(number),
      operationDigest: digestValue(["restore.promote", activationDigest]),
      approver: digestValue(["owner", "fixture"]),
      approvedAt: activation.time + 1,
      expiresAt: time + HOUR / 10,
    },
    events: [{ type: "restore.promote", actor: "owner", at: iso(time) }],
    outcome: {
      id: `c2:${digestValue(["promotion-id", number]).slice(7)}`,
      scope: { family: "command" as const, principal, version: 2 as const },
      fingerprint: canonicalJson({
        input: digestValue(["fixture-approval", number]),
        scope: { principal, version: 2 },
      }),
      status: "ok",
      result: { state: "promoted", stopped: true, sequence },
      retryUntil: time + HOUR,
    },
  };
  return { activation, promote };
}

type PromotionPair = ReturnType<typeof promotionPair>;
const pairRows = ({ activation, promote }: PromotionPair): Json[] => [
  activation,
  promote,
];
const archivedRows = (rows: readonly Json[]): Json[] =>
  rows.map((row) => archived(canonicalJson(row)));

type FixtureSlot = {
  collection: keyof V3Image["entries"];
  key: string;
  value: unknown;
  revision?: number;
};

function promotionProjection(rows: readonly Json[]) {
  const slots = new Map<string, FixtureSlot>();
  const put = (
    collection: FixtureSlot["collection"],
    key: string,
    value: unknown,
    revision?: number,
  ) =>
    slots.set(`${collection}/${key}`, {
      collection,
      key,
      value,
      ...(revision === undefined ? {} : { revision }),
    });
  let floor = 0;
  let watermark = 0;
  for (const row of rows) {
    watermark += Array.isArray(row.events) ? row.events.length : 0;
    if (row.operation === "restore.activate") {
      for (const [key, slot] of slots) {
        if (slot.collection !== "lease") continue;
        const lease = slot.value as Json;
        if (lease.releasedAt === undefined)
          slots.set(key, {
            ...slot,
            value: { ...lease, releasedAt: iso(row.time as number) },
          });
      }
      put("control", "global", row.control);
    }
    for (const { key, value } of (row.changes ?? []) as {
      key: string;
      value: Json;
    }[]) {
      put("record", key, value.value, value.revision as number);
      floor = Math.max(floor, Number(key.slice(1)));
    }
    const lease = row.lease as Json | undefined;
    const witness = row.witness as Json | undefined;
    const outcome = row.outcome as Json | undefined;
    if (lease) put("lease", String(lease.subject), lease);
    if (witness) put("witness", String(witness.id), { lease, witness });
    if (outcome && typeof outcome.id === "string" && outcome.id !== "")
      put("outcome", outcome.id, {
        outcome,
        time: row.time,
        ...(lease && { lease }),
      });
  }
  return {
    slots: [...slots.values()].sort((a, b) => {
      const left = `${a.collection}/${a.key}`;
      const right = `${b.collection}/${b.key}`;
      return left < right ? -1 : Number(left !== right);
    }),
    floor,
    watermark,
  };
}

function promotionArtifact(
  rows: readonly Json[],
  history = archivedRows(rows),
) {
  const { slots, floor, watermark } = promotionProjection(rows);
  let snapshot = "";
  const directory = slots.map(({ collection, key, value, revision }) => {
    const body = canonicalJson(value);
    const offset = Buffer.byteLength(snapshot);
    snapshot += body;
    return {
      collection,
      key,
      ...(revision === undefined ? {} : { revision }),
      page: "snapshot:0",
      offset,
      length: Buffer.byteLength(body),
      digest: digestBytes(body),
    };
  });
  const pages = [
    { id: "directory:0", body: canonicalJson(directory) },
    { id: "snapshot:0", body: snapshot },
    { id: "transcript:0", body: canonicalJson(history) },
  ];
  const publicDigest = digestValue(
    directory.map(({ collection, key, revision, digest }) => [
      collection,
      key,
      revision === undefined ? digest : digestValue([revision, digest]),
    ]),
  );
  return {
    data: {
      pages,
      head: history.length,
      eventWatermark: watermark,
      recordFloor: floor,
      publicDigest,
      source: "promotion-fixture",
    },
    directory,
    slots,
  };
}

function installPromotionRoot(
  f: Fixture,
  covered: ReturnType<typeof promotionArtifact>,
  identity: ReturnType<typeof activationIdentity>,
  generation: number,
  tail: readonly Json[] = [],
  edit: (r: Json) => void = () => undefined,
) {
  const base = { ...(JSON.parse(root(f).body) as Json), ...identity };
  const { data, directory } = covered;
  const end = (entry?: DirectoryItem) =>
    entry ? [entry.collection, entry.key] : null;
  const spans = [
    [end(directory[0]), end(directory.at(-1))],
    [null, null],
    data.head ? [1, data.head] : [null, null],
  ];
  const counts = [directory.length, directory.length, data.head];
  const listed = data.pages.map(({ id, body }, index) => ({
    id,
    ordinal: 0,
    kind: id.split(":")[0]!,
    count: counts[index],
    first: spans[index]![0],
    last: spans[index]![1],
    bytes: Buffer.byteLength(body),
    hash: digestBytes(body),
  }));
  const activated = {
    ...base,
    generation: 1,
    parentDigest: digestValue(base),
    activationDigest: digestValue(tail[0] ?? null),
    coveredHead: data.head,
    eventWatermark: data.eventWatermark,
    publicDigest: data.publicDigest,
    transcriptDigest: listed[2]!.hash,
    bytes: Object.fromEntries(listed.map(({ kind, bytes }) => [kind, bytes])),
    counts: Object.fromEntries(listed.map(({ kind, count }) => [kind, count])),
    pages: listed,
  };
  const { activationDigest: _digest, ...ordinary } = activated;
  const r: Json =
    generation === 1 && tail[0]?.operation === "restore.activate"
      ? activated
      : {
          ...ordinary,
          generation,
          parentDigest:
            generation === 2 ? digestValue(activated) : digestValue(base),
        };
  edit(r);
  for (const { id, body } of data.pages)
    f.db.run("INSERT OR REPLACE INTO cloud_v3_pages VALUES (?, ?)", [id, body]);
  const body = canonicalJson(r);
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
    body,
    trustedSeal(f.db, body),
  ]);
  insertPromotionTail(f, r, tail);
  f.restart();
  return r;
}

function insertPromotionTail(f: Fixture, r: Json, rows: readonly Json[]) {
  for (const [index, frame] of rows.entries()) {
    const sequence = Number(r.coveredHead) + index + 1;
    const body = canonicalJson(frame);
    f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
      sequence,
      body,
      signRow(f.seal(), r.incarnation, sequence, body),
    ]);
  }
}

async function promotionSource(withLeases = false) {
  const source = guardFixture(typedEnv);
  using _source = source.db;
  ok(await source.send(probe, {}));
  if (withLeases) {
    for (const name of ["open", "released"])
      ok(
        await rawLease(source, "claim", "owner-a", {
          subject: `issue:work-${name}`,
          requestId: `promotion-claim-${name}`,
          ttlMs: HOUR,
        }),
      );
    ok(
      await rawLease(source, "release", "owner-a", {
        subject: "issue:work-released",
        requestId: "promotion-release",
        generation: 1,
      }),
    );
  }
  for (const index of [1, 2, 3])
    ok(
      await typed(source, {
        ...createBody,
        requestId: `promotion-create-${index}`,
        input: { title: `Source issue ${index}` },
      }),
    );
  return commits(source).map(({ body }) => JSON.parse(body) as Json);
}

const atSequence = (row: Json, sequence: number): Json => ({
  ...row,
  sequence,
});
const cutFold = (
  f: Fixture,
  mode: Mode,
  rows: readonly Json[],
  context?: CoveredContext,
) =>
  foldPromotionHistory(
    writableStore(f.storage),
    rows,
    mode,
    Project.admitLeaseRequest,
    context,
  );

function expectedPromotionUsage(
  rows: readonly Json[],
  members = archivedRows(rows),
) {
  const { data, directory } = promotionArtifact(rows, members);
  return {
    transcript: jsonBytes(members),
    snapshot: Buffer.byteLength(data.pages[1]!.body),
    directory:
      2 +
      directory.reduce(
        (bytes, slot) =>
          bytes +
          jsonBytes({ ...slot, offset: 999999, length: 999999, digest: ZERO }) +
          1,
        0,
      ),
  };
}

function assertPromotionUsage(
  f: Fixture,
  image: V3Image,
  rows: readonly Json[],
) {
  expect(usageOf(image)).toEqual(rootedRecount(f, image));
  expect(usageOf(image)).toEqual(expectedPromotionUsage(rows));
}

async function promotionCheckpointRefused(f: Fixture) {
  const before = f.snapshot();
  const effects = f.observeEffects();
  const reply = await checkpoint(f);
  expect(reply).toMatchObject(refused);
  expect(exited(reply)).toBe(1);
  expect(effects()).toEqual(noWrites);
  expect(f.snapshot()).toEqual(before);
}

test.each([
  ["B1 one pair", 1, "ordinary"],
  ["LR0 two pairs", 2, "ordinary"],
  ["B11s maximum lifetime", 1, "lifetime"],
  ["B11s approval at activation time", 1, "approval time"],
] as const)(
  "v3 portable promotion accepts %s",
  async (_label, pairs, variant) => {
    const [first, second, third] = await promotionSource();
    const one = promotionPair(1, 1);
    if (variant === "lifetime")
      one.promote.approval.expiresAt =
        one.promote.approval.approvedAt + 600_000;
    if (variant === "approval time")
      one.promote.approval.approvedAt = one.activation.time;
    const rows = [first!, ...pairRows(one), atSequence(second!, 4)];
    if (pairs === 2)
      rows.push(...pairRows(promotionPair(4, 2)), atSequence(third!, 7));
    const { data } = promotionArtifact(rows);
    const f = guardFixture(typedEnv);
    using _db = f.db;
    setSystemTime(T0 + 100);
    const upload = await stageRestore(f, data);
    const final = await upload(2);
    expect(final.status).toBe(200);
    expect(final).toEqual(restoreResult(2, true));
    expect(exited(final)).toBe(0);
    const before = f.snapshot();
    const effects = f.observeEffects();
    for (const [index, expected] of [
      restoreResult(0),
      restoreResult(1),
      final,
    ].entries())
      expect(await upload(index)).toEqual(expected);
    expect(effects()).toEqual(noWrites);
    expect(f.snapshot()).toEqual(before);
    for (const label of ["after restore", "after restart"]) {
      const image = storedImage(f);
      expect(image.root.activationDigest, label).toBeDefined();
      expect(image.root.incarnation).not.toBe(
        one.activation.control.incarnation,
      );
      if (pairs === 2)
        expect(image.root.incarnation).not.toBe(
          activationIdentity(2).incarnation,
        );
      expect([image.head, image.eventWatermark]).toEqual([
        data.head + 1,
        data.eventWatermark + 1,
      ]);
      expect(controlSlot(writableStore(f.storage), image)).toEqual(
        controlGlobal(image.root.incarnation, T0 + 100),
      );
      assertPromotionUsage(f, image, [
        ...rows,
        activationRow(image.root, data.head + 1, T0 + 100),
      ]);
      f.restart();
    }
  },
  timeout,
);

test(
  "D0 v3 discovers a current activation above a wholly portable covered pair",
  () =>
    withFixture(async (f) => {
      const [first, second] = await promotionSource();
      const covered = [
        first!,
        ...pairRows(promotionPair(1, 1)),
        atSequence(second!, 4),
      ];
      const identity = activationIdentity(2);
      installPromotionRoot(f, promotionArtifact(covered), identity, 1, [
        activationRow(identity, covered.length + 1, T0 + 100),
      ]);
      const before = f.snapshot();
      const effects = f.observeEffects();
      const reply = await f.send(probe);
      expect(reply.status).toBe(200);
      expect(exited(reply)).toBe(0);
      expect(controlSlot(writableStore(f.storage), storedImage(f))).toEqual(
        controlGlobal(identity.incarnation, T0 + 100),
      );
      expect(effects()).toEqual(noWrites);
      expect(f.snapshot()).toEqual(before);
    }),
  timeout,
);

async function tailPromotion(
  options: { stub?: boolean; pointers?: boolean; notes?: number } = {},
) {
  const source = await promotionSource(options.pointers);
  const covered = options.pointers
    ? [
        atSequence(source[3]!, 1),
        ...pairRows(promotionPair(1, 1)),
        ...source.slice(0, 3).map((row, index) => atSequence(row, index + 4)),
      ]
    : source.slice(0, 1);
  if (options.stub) covered.push({ sequence: covered.length + 1 });
  const pair = promotionPair(covered.length, 2);
  const extra = Array.from({ length: options.notes ?? 0 }, (_, i) =>
    fixtureRow(covered.length + 3 + i),
  );
  const prefix = promotionArtifact(covered);
  const tail = [...pairRows(pair), ...extra];
  const identity = activationIdentity(2);
  return { prefix, covered, pair, identity, tail };
}

test.each([
  ["B2 ordinary prefix", false],
  ["U3 page-backed lease and control", true],
] as const)(
  "v3 recovers the generation-2 pair with %s twice",
  (_label, pointers) =>
    withFixture(async (f) => {
      const { prefix, covered, pair, identity, tail } = await tailPromotion({
        pointers,
      });
      installPromotionRoot(f, prefix, identity, 2, tail);
      const h = prefix.data.head;
      const w = prefix.data.eventWatermark;
      for (const _label of ["first recovery", "after restart"]) {
        const image = storedImage(f);
        expect(image.head).toBe(h + 2);
        expect(image.eventWatermark).toBe(w + 2);
        const db = writableStore(f.storage);
        expect(controlSlot(db, image)).toEqual(pair.activation.control);
        if (pointers) {
          expect(
            readV3Value(db, image, "lease", "issue:work-open"),
          ).toMatchObject({
            releasedAt: iso(pair.activation.time),
          });
          expect(
            readV3Value(db, image, "lease", "issue:work-released"),
          ).toMatchObject({
            releasedAt: iso(T0),
          });
        }
        assertPromotionUsage(f, image, [...covered, ...tail]);
        expect(usageOf(image)).toMatchObject({
          transcript: jsonBytes([
            ...(JSON.parse(prefix.data.pages[2]!.body) as Json[]),
            ...archivedRows(tail),
          ]),
        });
        expect(image.tailBytes).toBe(
          tail.reduce((n, row) => n + jsonBytes(row), 0),
        );
        f.restart();
      }
    }),
  timeout,
);

test.each([
  ["B3 first checkpoint", false, 0, [2]],
  ["B4 two cuts", false, 12, [12, 14]],
  ["B5 mixed covered boundary", true, 1, [3]],
] as const)(
  "v3 promotion checkpoint covers %s",
  (_label, stub, notes, cuts) =>
    withFixture(async (f) => {
      const { prefix, covered, identity, tail } = await tailPromotion({
        stub,
        notes,
      });
      installPromotionRoot(f, prefix, identity, 2, tail);
      const { head, eventWatermark } = prefix.data;
      for (const [index, count] of cuts.entries()) {
        const reply = await checkpoint(f);
        expect(reply.status).toBe(200);
        expect(exited(reply)).toBe(0);
        expect(reply.body).toMatchObject({
          value: { coveredHead: head + count, more: count !== tail.length },
        });
        expect(JSON.parse(root(f).body)).toMatchObject({
          generation: 3 + index,
          coveredHead: head + count,
          eventWatermark: eventWatermark + 2,
        });
        expect(commits(f)).toHaveLength(tail.length - count);
        const warm = storedImage(f);
        expect([warm.head, warm.eventWatermark]).toEqual([
          head + tail.length,
          eventWatermark + 2,
        ]);
        assertPromotionUsage(f, warm, [...covered, ...tail]);
        expect(await f.send(probe)).toEqual({
          status: 200,
          body: { ok: true, value: viewV3(warm) },
        });
        f.restart();
        expect(await f.send(probe)).toMatchObject({ status: 200 });
        const cold = storedImage(f);
        expect(viewV3(cold)).toEqual(viewV3(warm));
        assertPromotionUsage(f, cold, [...covered, ...tail]);
      }
    }),
  timeout,
);

test(
  "B5c v3 expands a covered stub and keeps a literal note after the activation",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const rows = [
        first!,
        { sequence: 2 },
        ...pairRows(promotionPair(2, 1)),
        fixtureRow(5),
      ];
      const artifact = promotionArtifact(rows);
      installPromotionRoot(f, artifact, activationIdentity(1), 3);
      const checked = readV3Root(writableStore(f.storage), f.seal());
      const image = cutFold(f, "archived", archivedRows(rows), {
        root: checked,
        boundary: 3,
      });
      expect([image.head, image.eventWatermark]).toEqual([
        5,
        artifact.data.eventWatermark,
      ]);
    }),
  timeout,
);

test.each(modes)(
  "v3 promotion %s usage matches each complete prefix (U1/U2)",
  (mode) =>
    withFixture(async (f) => {
      const source = await promotionSource(true);
      const before = source.slice(0, 4);
      const first = promotionPair(before.length, 1);
      const afterFirst = [...before, ...pairRows(first)];
      const between = [
        ...afterFirst,
        atSequence(source[4]!, afterFirst.length + 1),
      ];
      const second = promotionPair(between.length, 2);
      const afterSecond = [...between, ...pairRows(second)];
      const rows = [
        ...afterSecond,
        atSequence(source[5]!, afterSecond.length + 1),
      ];
      const db = writableStore(f.storage);
      const rooted = readV3Root(db, f.seal());
      for (const prefix of [before, afterFirst, between, afterSecond, rows]) {
        const members = archivedRows(prefix);
        const boundary = members.findLast(
          (row) => row.operation === "restore.activate",
        )?.sequence as number | undefined;
        const context =
          mode === "archived"
            ? { root: rooted, ...(boundary === undefined ? {} : { boundary }) }
            : undefined;
        const image = cutFold(f, mode, members, context);
        const expected = promotionArtifact(prefix, members);
        expect(usageOf(image)).toEqual(expectedPromotionUsage(prefix, members));
        expect(usageOf(image)).toEqual(recount(image, members));
        expect([image.head, image.eventWatermark]).toEqual([
          prefix.length,
          expected.data.eventWatermark,
        ]);
        const released = expected.slots.find(
          ({ collection, key }) =>
            collection === "lease" && key === "issue:work-released",
        );
        const original = promotionProjection(before).slots.find(
          ({ collection, key }) =>
            collection === "lease" && key === "issue:work-released",
        );
        expect(
          canonicalJson(readV3Value(db, image, "lease", "issue:work-released")),
        ).toBe(canonicalJson(original!.value));
        expect(released?.value).toEqual(original?.value);
      }
    }),
  timeout,
);

type PromotionEdit = (row: Json) => void;
type PromotionFault = readonly [label: string, edit: PromotionEdit];

function fieldAt(value: Json, path: string) {
  const parts = path.split(".");
  const field = parts.pop()!;
  const target = parts.reduce((parent, key) => parent[key] as Json, value);
  return { target, field };
}

function replaceField(path: string, value: unknown): PromotionEdit {
  return (row) => {
    const { target, field } = fieldAt(row, path);
    target[field] = value;
  };
}

function fingerprintEdit(edit: PromotionEdit): PromotionEdit {
  return (row) => {
    const outcome = row.outcome as Json;
    const fingerprint = JSON.parse(String(outcome.fingerprint)) as Json;
    edit(fingerprint);
    outcome.fingerprint = canonicalJson(fingerprint);
  };
}

const levels = [
  ["frame", "", "activationDigest"],
  ["approval", "approval.", "id"],
  ["outcome", "outcome.", "status"],
  ["scope", "outcome.scope.", "principal"],
  ["result", "outcome.result.", "sequence"],
  ["event", "events.0.", "actor"],
  ["fingerprint", "fingerprint.", "input"],
  ["fingerprint scope", "fingerprint.scope.", "version"],
] as const;

const promotionKeys: PromotionFault[] = levels.flatMap(([label, prefix, key]) =>
  ["missing", "extra"].map((kind): PromotionFault => {
    const edit: PromotionEdit = (row) => {
      if (kind === "missing") {
        const { target, field } = fieldAt(
          row,
          prefix.replace(/^fingerprint\./, "") + key,
        );
        delete target[field];
      } else {
        replaceField(
          prefix.replace(/^fingerprint\./, "") + "unexpected",
          true,
        )(row);
      }
    };
    return [
      `R1 ${label} ${kind} key`,
      prefix.startsWith("fingerprint.") ? fingerprintEdit(edit) : edit,
    ];
  }),
);

const fieldTypes: PromotionFault[] = [
  "activationDigest",
  "approval",
  "events",
  "format",
  "operation",
  "outcome",
  "sequence",
  "time",
  "approval.id",
  "approval.operationDigest",
  "approval.approver",
  "approval.approvedAt",
  "approval.expiresAt",
  "outcome.id",
  "outcome.scope",
  "outcome.fingerprint",
  "outcome.status",
  "outcome.result",
  "outcome.retryUntil",
  "outcome.scope.family",
  "outcome.scope.principal",
  "outcome.scope.version",
  "outcome.result.state",
  "outcome.result.stopped",
  "outcome.result.sequence",
  "events.0.type",
  "events.0.actor",
  "events.0.at",
].map((field) => [`R2 ${field} type`, replaceField(field, null)]);

const fingerprintFaults: PromotionFault[] = [
  ...[null, [], {}].flatMap((bad): PromotionFault[] => [
    [
      `R4 input ${canonicalJson(bad)}`,
      fingerprintEdit(replaceField("input", bad)),
    ],
    [
      `R4 principal ${canonicalJson(bad)}`,
      (row) => {
        replaceField("outcome.scope.principal", bad)(row);
        fingerprintEdit(replaceField("scope.principal", bad))(row);
      },
    ],
  ]),
  [
    "R4 unequal principals",
    fingerprintEdit(replaceField("scope.principal", ZERO)),
  ],
];

const timeFaults: PromotionFault[] = [
  ...["time", "approval.approvedAt", "approval.expiresAt"].flatMap((field) =>
    [
      ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
      ["negative integer", -1],
      ["fraction", T0 + 0.5],
      ["outside Date range", 8_640_000_000_000_001],
      ["five-digit year", Date.UTC(10_000, 0, 1)],
    ].map(([label, value]): PromotionFault => [
      `R6 ${field} ${label}`,
      replaceField(field, value),
    ]),
  ),
  ["R6 approved before activation", replaceField("approval.approvedAt", T0)],
  [
    "R6 approved after the frame",
    (row) => replaceField("approval.approvedAt", Number(row.time) + 1)(row),
  ],
  [
    "R6 expiry equals frame time",
    (row) => replaceField("approval.expiresAt", row.time)(row),
  ],
  [
    "R6 lifetime exceeds 600000 ms",
    (row) => {
      const { approvedAt } = row.approval as Json;
      replaceField("approval.expiresAt", Number(approvedAt) + 600_001)(row);
    },
  ],
  [
    "R6 frame time precedes activation",
    (row) => {
      const time = Number(row.time) - 3;
      row.time = time;
      replaceField("events.0.at", iso(time))(row);
    },
  ],
];

const promotionFaults: PromotionFault[] = [
  ...promotionKeys,
  ...fieldTypes,
  ...["input", "scope", "scope.principal", "scope.version"].map(
    (path): PromotionFault => [
      `R2 fingerprint ${path} type`,
      fingerprintEdit(replaceField(path, false)),
    ],
  ),
  [
    "R2 fingerprint spacing",
    (row) => {
      const outcome = row.outcome as Json;
      outcome.fingerprint = String(outcome.fingerprint).replace(":", ": ");
    },
  ],
  [
    "R2 fingerprint key order",
    (row) => {
      const outcome = row.outcome as Json;
      const { input, scope } = JSON.parse(String(outcome.fingerprint)) as Json;
      outcome.fingerprint = JSON.stringify({ scope, input });
    },
  ],
  ...[
    ["uppercase", "ABCDEF00-0000-4000-8000-000000000001"],
    ["version 1", "abcdef00-0000-1000-8000-000000000001"],
    ["short", "abcdef00"],
  ].map(([label, value]): PromotionFault => [
    `R3 approval id ${label}`,
    replaceField("approval.id", value),
  ]),
  [
    "R3 principal not a digest",
    (row) => {
      replaceField("outcome.scope.principal", "owner")(row);
      fingerprintEdit(replaceField("scope.principal", "owner"))(row);
    },
  ],
  ["R3 input not a digest", fingerprintEdit(replaceField("input", "input"))],
  ...fingerprintFaults,
  ["R5 approver not a digest", replaceField("approval.approver", "owner")],
  ...timeFaults,
  [
    "R7 sequence overflow",
    replaceField("sequence", Number.MAX_SAFE_INTEGER + 1),
  ],
  [
    "R7 result sequence differs",
    (row) =>
      replaceField("outcome.result.sequence", Number(row.sequence) + 1)(row),
  ],
  [
    "R9 approval binds a different digest",
    replaceField("approval.operationDigest", ZERO),
  ],
  [
    "R9 frame binds a different activation",
    (row) => {
      row.activationDigest = ZERO;
      replaceField(
        "approval.operationDigest",
        digestValue(["restore.promote", ZERO]),
      )(row);
    },
  ],
  ["R10 no events", replaceField("events", [])],
  [
    "R10 two events",
    (row) => {
      const [event] = row.events as Json[];
      row.events = [event, event];
    },
  ],
  ["R10 wrong actor", replaceField("events.0.actor", "restore")],
  ["R10 wrong time", replaceField("events.0.at", iso(T0))],
  ["R11 status", replaceField("outcome.status", "INPUT_INVALID")],
  [
    "R11 retry deadline",
    (row) => replaceField("outcome.retryUntil", row.time)(row),
  ],
  [
    "R11 scope version",
    (row) => {
      replaceField("outcome.scope.version", 1)(row);
      fingerprintEdit(replaceField("scope.version", 1))(row);
    },
  ],
  ["R11 scope family", replaceField("outcome.scope.family", "lease")],
  [
    "R14 oversized and outside the closed grammar",
    replaceField("unexpected", "x".repeat(4096)),
  ],
];

type PromotionRoute = "cold" | "checkpoint" | "portable";
const promotionRoutes: readonly PromotionRoute[] = [
  "cold",
  "checkpoint",
  "portable",
];

async function refusesPromotion(
  route: PromotionRoute,
  prefix: Json[],
  tail: Json[],
  identity = activationIdentity(1),
  members?: Json[],
) {
  const rows = [...prefix, ...tail];
  if (route === "portable") {
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await rejectedFinalPage(f, promotionArtifact(rows, members).data);
    return;
  }
  await withFixture(async (f) => {
    if (route === "cold") {
      installPromotionRoot(f, promotionArtifact(rows, members), identity, 3);
      await coldRefused(f);
    } else {
      if (members) {
        installPromotionRoot(f, promotionArtifact(rows, members), identity, 3, [
          fixtureRow(rows.length + 1),
        ]);
      } else {
        installPromotionRoot(f, promotionArtifact(prefix), identity, 2, tail);
      }
      await promotionCheckpointRefused(f);
    }
  });
}

test.each(promotionRoutes)(
  "R6 v3 %s promotion isolates a five-digit expiry year",
  async (route) => {
    const [first] = await promotionSource();
    const boundary = Date.UTC(10_000, 0, 1);
    const identity = activationIdentity(1);
    const pair = promotionPair(1, 1, identity, boundary - 10);
    const prefix = [first!];
    const tail = pairRows(pair);
    pair.promote.approval.expiresAt = boundary - 1;

    if (route === "portable") {
      setSystemTime(boundary - 7);
      const f = guardFixture(typedEnv);
      using _db = f.db;
      const upload = await stageRestore(
        f,
        promotionArtifact([...prefix, ...tail]).data,
      );
      const reply = await upload(2);
      expect(reply).toEqual(restoreResult(2, true));
      expect(exited(reply)).toBe(0);
      const effects = f.observeEffects();
      expect(await upload(2)).toEqual(reply);
      expect(effects()).toEqual(noWrites);
    } else {
      await withFixture(async (f) => {
        if (route === "checkpoint") {
          installPromotionRoot(f, promotionArtifact(prefix), identity, 2, tail);
          const reply = await checkpoint(f);
          expect(reply).toMatchObject({
            status: 200,
            body: { value: { coveredHead: 3, more: false } },
          });
          expect(exited(reply)).toBe(0);
          f.restart();
        } else {
          installPromotionRoot(
            f,
            promotionArtifact([...prefix, ...tail]),
            identity,
            3,
          );
        }
        const effects = f.observeEffects();
        const reply = await f.send(probe);
        expect(reply).toMatchObject({
          status: 200,
          body: { value: { image: { head: 3 } } },
        });
        expect(exited(reply)).toBe(0);
        expect(effects()).toEqual(noWrites);
      });
    }

    pair.promote.approval.expiresAt = boundary;
    await refusesPromotion(route, prefix, tail, identity);
  },
  timeout,
);

for (const route of promotionRoutes) {
  test.each(promotionFaults)(
    `v3 ${route} promotion refuses %s`,
    async (_name, edit) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      const rows = pairRows(pair);
      edit(rows[1]!);
      await refusesPromotion(route, [first!], rows);
    },
    timeout,
  );

  test.each([
    "both outcome representations",
    "wrong archived result digest",
    "wrong archived result digest type",
  ] as const)(
    `R8 v3 ${route} promotion refuses %s`,
    async (fault) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      const tail = pairRows(pair);
      const members = archivedRows([first!, ...tail]);
      const mode =
        route === "checkpoint" && fault === "both outcome representations"
          ? undefined
          : members;
      if (fault === "wrong archived result digest")
        replaceField("outcome.resultDigest", ZERO)(members[2]!);
      else if (fault === "wrong archived result digest type")
        replaceField("outcome.resultDigest", null)(members[2]!);
      else if (mode)
        replaceField("outcome.result", pair.promote.outcome.result)(mode[2]!);
      else
        replaceField(
          "outcome.resultDigest",
          digestValue(pair.promote.outcome.result),
        )(tail[1]!);
      await refusesPromotion(
        route,
        [first!],
        tail,
        activationIdentity(1),
        mode,
      );
    },
    timeout,
  );

  test.each(["interrupted", "standalone", "duplicate"] as const)(
    `R12 v3 ${route} promotion refuses a %s pair`,
    async (fault) => {
      const [first, second] = await promotionSource();
      const pair = promotionPair(1, 1);
      const duplicate = {
        ...pair.promote,
        sequence: 4,
        outcome: {
          ...pair.promote.outcome,
          result: { ...pair.promote.outcome.result, sequence: 4 },
        },
      };
      const tail: Json[] =
        fault === "interrupted"
          ? [pair.activation, atSequence(second!, 3), duplicate]
          : fault === "standalone"
            ? [
                {
                  ...pair.promote,
                  sequence: 2,
                  outcome: {
                    ...pair.promote.outcome,
                    result: { ...pair.promote.outcome.result, sequence: 2 },
                  },
                },
              ]
            : [...pairRows(pair), duplicate];
      await refusesPromotion(route, [first!], tail);
    },
    timeout,
  );
}

test.each(["incarnation", "restoreEpoch", "approval"] as const)(
  "R13 v3 refuses reused %s in covered history and across the tail boundary",
  async (reuse) => {
    const [first] = await promotionSource();
    const firstIdentity = activationIdentity(1);
    const original = activationIdentity(2);
    const secondIdentity = {
      ...original,
      ...(reuse === "incarnation" && {
        incarnation: firstIdentity.incarnation,
      }),
      ...(reuse === "restoreEpoch" && {
        restoreEpoch: firstIdentity.restoreEpoch,
      }),
    };
    const prefix = [first!, ...pairRows(promotionPair(1, 1))];
    const second = promotionPair(prefix.length, 2, secondIdentity);
    if (reuse === "approval") second.promote.approval.id = approvalId(1);
    const tail = pairRows(second);
    await refusesPromotion("portable", prefix, tail, secondIdentity);
    await refusesPromotion("cold", prefix, tail, secondIdentity);
    await refusesPromotion("checkpoint", prefix, tail, secondIdentity);
    await withFixture(async (f) => {
      installPromotionRoot(
        f,
        promotionArtifact(prefix),
        secondIdentity,
        2,
        tail,
      );
      await coldRefused(f);
    });
    await withFixture(async (f) => {
      installPromotionRoot(
        f,
        promotionArtifact([...prefix, ...tail]),
        secondIdentity,
        3,
        [fixtureRow(prefix.length + tail.length + 1)],
      );
      await promotionCheckpointRefused(f);
    });
  },
  timeout,
);

test.each([
  [
    "B6 wrong activation digest",
    (pair: PromotionPair) => {
      pair.promote.activationDigest = ZERO;
      pair.promote.approval.operationDigest = digestValue([
        "restore.promote",
        ZERO,
      ]);
      return pairRows(pair);
    },
  ],
  [
    "B7 activation with the exact parent and no promote",
    (pair: PromotionPair) => [pair.activation],
  ],
  ["B8 wrong reconstructed parent", pairRows],
] as const)(
  "v3 promoted root refuses %s",
  (_label, tailOf) =>
    withFixture(async (f) => {
      const { prefix, pair, identity } = await tailPromotion();
      installPromotionRoot(f, prefix, identity, 2, tailOf(pair), (r) => {
        if (_label.startsWith("B8")) r.parentDigest = ZERO;
      });
      await coldRefused(f);
    }),
  timeout,
);

test.each(["copied identity", "fresh identity"] as const)(
  "B9 v3 portable history refuses a terminal activation with %s",
  async (variant) => {
    const [first] = await promotionSource();
    const firstPair = promotionPair(1, 1);
    const f = guardFixture(typedEnv);
    using _db = f.db;
    await rejectedFinalPage(
      f,
      promotionArtifact([
        first!,
        ...pairRows(firstPair),
        variant === "copied identity"
          ? atSequence(firstPair.activation, 4)
          : promotionPair(3, 2).activation,
      ]).data,
    );
  },
  timeout,
);

test.each(modes)(
  "PC3 v3 %s fold refuses incomplete or interrupted promotion",
  (mode) =>
    withFixture(async (f) => {
      const [first, second] = await promotionSource();
      const { activation } = promotionPair(1, 1);
      const effects = f.observeEffects();
      unavailableRead(() =>
        cutFold(f, mode, archivedRows([first!, activation])),
      );
      unavailableRead(() =>
        cutFold(
          f,
          mode,
          archivedRows([first!, activation, atSequence(second!, 3)]),
        ),
      );
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test.each([
  ["PC1 complete", "complete"],
  ["PC2 incomplete", "incomplete"],
  ["PC2 interrupted", "interrupted"],
] as const)(
  "v3 cold archived recovery with %s pending completion",
  (_label, shape) =>
    withFixture(async (f) => {
      const [first, second] = await promotionSource();
      const pair = promotionPair(1, 1);
      const rows = [first!, pair.activation];
      if (shape === "complete") rows.push(pair.promote);
      if (shape === "interrupted") rows.push(atSequence(second!, 3));
      installPromotionRoot(
        f,
        promotionArtifact(rows),
        activationIdentity(1),
        3,
      );
      if (shape === "complete") {
        const observed = f.observeEffects();
        const reply = await f.send(probe);
        expect(reply.status).toBe(200);
        expect(exited(reply)).toBe(0);
        expect(storedImage(f).fold?.pending).toBeUndefined();
        expect(observed()).toEqual(noWrites);
      } else {
        await coldRefused(f);
        if (shape === "incomplete") await promotionCheckpointRefused(f);
      }
    }),
  timeout,
);

test.each([
  ["BD1 covered incarnation", false, "incarnation"],
  ["BD1 covered restore epoch", false, "restoreEpoch"],
  ["BD2 tail incarnation", true, "incarnation"],
  ["BD2 tail restore epoch", true, "restoreEpoch"],
] as const)(
  "v3 root identity refuses %s",
  (_label, live, field) =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      const mismatch = {
        ...activationIdentity(1),
        [field]: activationIdentity(2)[field],
      };
      const tail = pairRows(pair);
      installPromotionRoot(
        f,
        promotionArtifact(live ? [first!] : [first!, ...tail]),
        mismatch,
        live ? 2 : 3,
        live ? tail : [],
      );
      await coldRefused(f);
    }),
  timeout,
);

test.each([1, 3])(
  "BD4 v3 ordinary generation %i refuses a first tail activation",
  (generation) =>
    withFixture(async (f) => {
      const { prefix, identity, tail } = await tailPromotion();
      installPromotionRoot(f, prefix, identity, generation, tail, (r) => {
        if (generation === 1) {
          delete r.activationDigest;
          r.parentDigest = digestValue(["ordinary generation", generation]);
        }
      });
      await coldRefused(f);
    }),
  timeout,
);

test(
  "BD5 v3 does not use a later tail activation as its boundary",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const prefix = promotionArtifact([first!]);
      const pair = promotionPair(2, 1);
      const tail = [fixtureRow(2), ...pairRows(pair)];
      installPromotionRoot(f, prefix, activationIdentity(1), 2, tail);
      await coldRefused(f);
      const db = writableStore(f.storage);
      const cut = recoverV3(
        db,
        f.seal(),
        archivedCheck(db, {
          admit: Project.admitLeaseRequest,
          failure: () => new Error("through cut"),
        }),
        { through: 2 },
      );
      expect([cut.head, cut.eventWatermark]).toEqual([
        2,
        prefix.data.eventWatermark,
      ]);
      expect(cut.tailBytes).toBe(jsonBytes(tail[0]));
    }),
  timeout,
);

test(
  "BD5 checkpoint through its first twelve rows ignores the out-of-cut activation",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const prefix = promotionArtifact([first!]);
      const pair = promotionPair(13, 1);
      const tail = [
        ...Array.from({ length: 12 }, (_, i) => fixtureRow(i + 2)),
        ...pairRows(pair),
      ];
      installPromotionRoot(f, prefix, activationIdentity(1), 2, tail);
      const reply = await checkpoint(f);
      expect(reply.status).toBe(200);
      expect(reply.body).toMatchObject({
        value: { coveredHead: 13, more: true },
      });
      expect(exited(reply)).toBe(0);
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([14, 15]);
      f.restart();
      await coldRefused(f);
    }),
  timeout,
);

test.each(["incarnation", "restoreEpoch"] as const)(
  "BD6 v3 current activation refuses covered %s reuse",
  (field) =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const prefix = promotionArtifact([
        first!,
        ...pairRows(promotionPair(1, 1)),
      ]);
      const identity = {
        ...activationIdentity(2),
        [field]: activationIdentity(1)[field],
      };
      installPromotionRoot(f, prefix, identity, 1, [
        activationRow(identity, 4, T0 + 100),
      ]);
      await coldRefused(f);
    }),
  timeout,
);

async function badPromotionMac(f: Fixture) {
  const { prefix, identity, tail } = await tailPromotion();
  installPromotionRoot(f, prefix, identity, 2, tail);
  f.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=?", [
    "invalid-mac",
    prefix.data.head + 1,
  ]);
}

test(
  "DC0 v3 checks the tail MAC before sealed receives discovery",
  () =>
    withFixture(async (f) => {
      await badPromotionMac(f);
      let calls = 0;
      const effects = f.observeEffects();
      unavailableRead(() =>
        recoverV3(writableStore(f.storage), f.seal(), {
          admit: Project.admitLeaseRequest,
          sealed() {
            calls++;
          },
        }),
      );
      expect(calls).toBe(0);
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "DC1 v3 passes authenticated current boundary discovery to sealed",
  () =>
    withFixture(async (current) =>
      withFixture(async (ordinary) => {
        const { prefix, identity, tail } = await tailPromotion();
        installPromotionRoot(current, prefix, identity, 2, tail);
        const seen: (Discovery | undefined)[] = [];
        const sealed = (_image: V3Image, value?: Discovery) => {
          seen.push(value);
        };
        const verification = { admit: Project.admitLeaseRequest, sealed };
        let caught: unknown;
        let image: V3Image | undefined;
        try {
          image = recoverV3(
            writableStore(current.storage),
            current.seal(),
            verification,
          );
        } catch (error) {
          caught = error;
        }
        expect(seen).toEqual([{ current: true }]);
        expect(caught).toBeUndefined();
        expect(image?.head).toBe(prefix.data.head + 2);
        recoverV3(
          writableStore(ordinary.storage),
          ordinary.seal(),
          verification,
        );
        expect(seen).toEqual([{ current: true }, { current: false }]);
      }),
    ),
  timeout,
);

test(
  "DC2 v3 cold recovery refuses a bad current activation MAC",
  () =>
    withFixture(async (f) => {
      await badPromotionMac(f);
      await coldRefused(f);
    }),
  timeout,
);

test.each(["row", "byte"] as const)(
  "DC3 v3 discovery enforces the %s limit",
  (limit) =>
    withFixture(async (f) => {
      const r = JSON.parse(root(f).body) as Json;
      const bytes = (16 * MiB) / 32;
      const count = limit === "row" ? 1025 : 33;
      const rows = Array.from({ length: count }, (_, index) => {
        const sequence = index + 1;
        return limit === "row"
          ? fixtureRow(sequence)
          : {
              ...paddedNote(bytes, sequence),
              format: "forge-cloud-commit/3",
              sequence,
            };
      });
      insertPromotionTail(f, r, rows);
      f.restart();
      await coldRefused(f);
    }),
  timeout,
);

function promotionImageState(image: V3Image) {
  const {
    root,
    entries,
    usage,
    head,
    eventWatermark,
    recordFloor,
    tailBytes,
    stale,
    staged,
  } = image;
  return structuredClone({
    root,
    entries,
    usage,
    head,
    eventWatermark,
    recordFloor,
    tailBytes,
    stale,
    staged,
  });
}

test.each([
  ["C6a ordinary handoff", false, undefined],
  ["C6b covered handoff", true, undefined],
  ["C6c projection digest", true, "publicDigest"],
  ["C6d event watermark", true, "eventWatermark"],
  ["C6e record floor", true, "recordFloor"],
] as const)(
  "v3 sealed reconciliation %s",
  (label, covered, fault) =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const identity = activationIdentity(1);
      const artifact = promotionArtifact(
        covered ? [first!, ...pairRows(promotionPair(1, 1))] : [first!],
      );
      installPromotionRoot(f, artifact, identity, covered ? 3 : 1, [], (r) => {
        if (fault === "publicDigest") r.publicDigest = ZERO;
        if (fault === "eventWatermark")
          r.eventWatermark = artifact.data.eventWatermark + 1;
      });
      const image = sealedComponent(f);
      if (fault === "recordFloor") image.recordFloor++;
      image.fold = {
        context: "portable",
        segmentIncarnation: "sentinel",
        incarnations: new Set(["sentinel"]),
        restoreEpochs: new Set(["sentinel-epoch"]),
        approvalIds: new Set(["sentinel-approval"]),
        pending: { sequence: 50, time: 10, digest: ZERO },
      };
      const fold = image.fold;
      const before = promotionImageState(image);
      const old = structuredClone(fold);
      const named = new Error(label);
      const sealed: (image: V3Image, discovery: Discovery) => void =
        archivedCheck(writableStore(f.storage), {
          admit: Project.admitLeaseRequest,
          failure: () => named,
        }).sealed;
      if (fault) {
        expect(() => sealed(image, { current: false })).toThrow(named);
        expect(image.fold).toBe(fold);
        expect(image.fold).toEqual(old);
      } else {
        sealed(image, { current: false });
        const expected: PromotionFold = {
          context: "rooted",
          segmentIncarnation: identity.incarnation,
          incarnations: new Set([identity.incarnation]),
          restoreEpochs: new Set(covered ? [identity.restoreEpoch] : []),
          approvalIds: new Set(covered ? [approvalId(1)] : []),
          ...(covered && { segmentEpoch: identity.restoreEpoch }),
        };
        expect(image.fold).toEqual(expected);
      }
      expect(promotionImageState(image)).toEqual(before);
      if (fault && fault !== "recordFloor") await coldRefused(f);
    }),
  timeout,
);

test(
  "C6e v3 cold recovery refuses a directory that raises the record floor",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const rows = [first!, ...pairRows(promotionPair(1, 1))];
      const projected = [
        {
          ...first!,
          changes: (first!.changes as Json[]).map((change) => ({
            ...change,
            key: "r2",
          })),
        },
        ...rows.slice(1),
      ];
      installPromotionRoot(
        f,
        promotionArtifact(projected, archivedRows(rows)),
        activationIdentity(1),
        3,
      );
      await coldRefused(f);
    }),
  timeout,
);

test.each(["in-memory", "page-backed"] as const)(
  "v3 promote cannot replace an occupied %s outcome (OC1/OC2)",
  (location) =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      const occupied = outcomeOf(first);
      pair.promote.outcome.id = String(occupied.id);
      const before = f.snapshot();
      const effects = f.observeEffects();
      if (location === "in-memory") {
        unavailableRead(() =>
          cutFold(f, "portable", archivedRows([first!, ...pairRows(pair)])),
        );
        expect(effects()).toEqual(noWrites);
        expect(f.snapshot()).toEqual(before);
      } else {
        const artifact = promotionArtifact([first!]);
        installPromotionRoot(
          f,
          artifact,
          activationIdentity(1),
          2,
          pairRows(pair),
        );
        const member = artifact.directory.find(
          ({ key }) => key === occupied.id,
        )!;
        expect(member.page).toBe("snapshot:0");
        const readSnapshot = () =>
          pages(f).find(({ id }) => id === member.page)!.body;
        const valueBefore = readSnapshot();
        await coldRefused(f);
        expect(readSnapshot()).toBe(valueBefore);
      }
    }),
  timeout,
);

test(
  "O1 v3 loads a page-backed promote receipt through readV3Value",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      installPromotionRoot(
        f,
        promotionArtifact([first!, ...pairRows(pair)]),
        activationIdentity(1),
        3,
      );
      const image = sealedComponent(f);
      const { outcome, time } = pair.promote;
      expect(image.entries.outcome.get(outcome.id)).toMatchObject({
        page: "snapshot:0",
      });
      expect(
        readV3Value(writableStore(f.storage), image, "outcome", outcome.id),
      ).toEqual({ outcome, time });
    }),
  timeout,
);

test(
  "O1 v3 cold recovery accepts the same page-backed promote receipt",
  () =>
    withFixture(async (f) => {
      const [first] = await promotionSource();
      const pair = promotionPair(1, 1);
      const artifact = promotionArtifact([first!, ...pairRows(pair)]);
      installPromotionRoot(f, artifact, activationIdentity(1), 3);
      const image = storedImage(f);
      const { outcome, time } = pair.promote;
      expect(image.head).toBe(artifact.data.head);
      expect(
        readV3Value(writableStore(f.storage), image, "outcome", outcome.id),
      ).toEqual({ outcome, time });
    }),
  timeout,
);

const promoteSlot = () => {
  const { outcome, time } = promotionPair(1, 1).promote;
  return { outcome, time };
};

test(
  "O2/O3 v3 validates the closed promote outcome slot",
  () => {
    const value = promoteSlot();
    expect(sealedAuthorityValid("outcome", value.outcome.id, value)).toBe(true);
  },
  timeout,
);

const slotFaults: PromotionFault[] = [
  ["lease", replaceField("lease", {})],
  ["witness", replaceField("witness", {})],
  ["extra member", replaceField("extra", true)],
  [
    "missing time",
    (value) => {
      delete value.time;
    },
  ],
  ["mismatched slot id", replaceField("outcome.id", `c2:${"f".repeat(64)}`)],
  ["extra result key", replaceField("outcome.result.extra", true)],
  ...[0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1].map((bad): PromotionFault => [
    `sequence ${bad}`,
    replaceField("outcome.result.sequence", bad),
  ]),
  ...[-1, 1.1, Number.MAX_SAFE_INTEGER + 1].map((bad): PromotionFault => [
    `time ${bad}`,
    replaceField("time", bad),
  ]),
  [
    "retry deadline",
    (value) => replaceField("outcome.retryUntil", value.time)(value),
  ],
  ...fingerprintFaults,
];

test.each(slotFaults)(
  "O3 v3 refuses a promote outcome slot with %s",
  (_name, edit) => {
    const value = promoteSlot();
    const id = value.outcome.id;
    edit(value);
    expect(sealedAuthorityValid("outcome", id, value)).toBe(false);
  },
  timeout,
);

test.each([true, false])(
  "O3 ordinary TrackerItem slot validity is %s",
  async (valid) => {
    const [first] = await promotionSource();
    const outcome = structuredClone(outcomeOf(first));
    if (!valid) delete (outcome.result as Json).id;
    expect(
      sealedAuthorityValid("outcome", String(outcome.id), {
        outcome,
        time: first!.time,
      }),
    ).toBe(valid);
  },
  timeout,
);

const replayHost = {
  project: "a",
  prefix: "forge",
  device: "owner-a",
  principal: ["owner", "owner-a", "owner-a"] as const,
  expiresAt: E1,
  now: T0 + 100,
};
const replayText = canonicalJson(createBody);
const conflict = {
  code: "INPUT_CONFLICT",
  message: "Request ID belongs to a different input",
  retry: "reconcile_first",
} satisfies ForgeError;

function promotionReplaySlot(kind: "same" | "other") {
  const { op, requestId, input, context } = parseCommand(
    replayText,
    replayHost,
  );
  const receipt = prepareReceipt("command", replayHost.principal, requestId, {
    op,
    input,
    context,
    device: replayHost.device,
  });
  const value = promoteSlot();
  const prior = {
    ...value.outcome,
    id: receipt.requestId,
    scope: { ...receiptScope(replayHost.principal), family: "command" },
    fingerprint: receipt.fingerprint,
  };
  if (kind === "other") {
    const other = prepareReceipt("command", replayHost.principal, requestId, {
      op,
      context,
      device: replayHost.device,
      input: { title: "Other issue" },
    });
    prior.fingerprint = other.fingerprint;
  }
  return { outcome: prior, time: value.time };
}

async function ordinaryReplaySlot() {
  const source = guardFixture(typedEnv);
  using _db = source.db;
  ok(await source.send(probe, {}));
  ok(await typed(source, createBody));
  const [commit] = commits(source);
  const row = JSON.parse(commit!.body) as Json;
  return { outcome: outcomeOf(row) as Json & { id: string }, time: row.time };
}

test.each([
  ["RC1 create fingerprint", "same"],
  ["RC2 ordinary create receipt", "ordinary"],
  ["RC3 different fingerprint", "other"],
] as const)(
  "v3 direct command replay checks %s",
  (_label, kind) =>
    withFixture(async (f) => {
      const image = storedImage(f);
      const value =
        kind === "ordinary"
          ? await ordinaryReplaySlot()
          : promotionReplaySlot(kind);
      const { result } = value.outcome;
      image.entries.outcome.set(value.outcome.id, { value });
      const before = promotionImageState(image);
      const effects = f.observeEffects();
      let reply: Response | undefined;
      let caught: unknown;
      try {
        reply = commandV3(
          writableStore(f.storage),
          f.seal(),
          image,
          replayText,
          replayHost,
        );
      } catch (error) {
        caught = error;
      }
      if (kind === "ordinary") {
        expect(caught).toBeUndefined();
        expect(reply?.status).toBe(200);
        expect(await reply?.json()).toEqual({
          ok: true,
          op: "issue.create",
          status: "OK",
          result,
          warnings: [],
        });
      } else {
        expect(caught).toBeInstanceOf(ForgeFailure);
        expect((caught as ForgeFailure).error).toEqual(requestConflict().error);
        expect(reply).toBeUndefined();
      }
      expect(effects()).toEqual(noWrites);
      expect(promotionImageState(image)).toEqual(before);
    }),
  timeout,
);

test(
  "RC1j v3 command route conflicts with a recovered promote receipt",
  async () => {
    const [first] = await promotionSource();
    const f = guardFixture(typedEnv);
    using _db = f.db;
    ok(await f.send(probe, {}));
    const pair = promotionPair(1, 1);
    Object.assign(pair.promote.outcome, promotionReplaySlot("same").outcome);
    const rows = [first!, ...pairRows(pair)];
    installPromotionRoot(f, promotionArtifact(rows), activationIdentity(1), 3);
    setSystemTime(replayHost.now);
    const before = f.snapshot();
    const effects = f.observeEffects();
    const image = storedImage(f);
    expect(image.head).toBe(rows.length);
    const reply = await typed(f, createBody);
    expect(reply).toMatchObject({
      status: 409,
      body: { ok: false, error: conflict },
    });
    expect(exited(reply)).toBe(4);
    expect(effects()).toEqual(noWrites);
    expect(f.snapshot()).toEqual(before);
  },
  timeout,
);
