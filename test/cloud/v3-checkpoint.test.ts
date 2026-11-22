import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { domain, Project } from "../../cloud/src/project.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { writableStore } from "../../cloud/src/store.ts";
import {
  PAGE_BYTES,
  readV3Value,
  recoverV3,
  viewV3,
} from "../../cloud/src/v3-store.ts";
import {
  guardFixture,
  noWrites,
  probe,
  trustedManifest,
  trustedSeal,
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
        await appendNotes(f, size);
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
      await appendNotes(f, 1024);
      const effects = f.observeEffects();
      expect(await append(f, frame())).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      await prefix(f, 0, 1024);
      expect((await append(f, frame())).status).toBe(200);
      expect(commits(f).at(-1)?.sequence).toBe(1025);
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
      const before = recoverV3(db, f.seal());
      const cut = await prefix(f, 0, before.head);
      expect(cut).toBeGreaterThanOrEqual(11);
      expect(cut).toBeLessThan(before.head);
      await expectWarmAndCold(f, viewV3(before).image);
      await drain(f, cut, before.head);
      const after = recoverV3(db, f.seal());
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

const sendLease = (f: Fixture, route: string, owner: string, input: Json) =>
  f.send(
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
  );

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
      const expected = recoverV3(writableStore(source.storage), source.seal());
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
      const expected = recoverV3(writableStore(source.storage), source.seal());
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
      const expected = recoverV3(writableStore(source.storage), source.seal());
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
  run: (target: Fixture, data: Portable, source: Fixture) => Promise<void>,
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
    const { head, eventWatermark, recordFloor, root } = recoverV3(
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
        tamper(data);
        const upload = portableUpload(target, data);
        const replies = [await upload(0), await upload(1)];
        const staged = target.snapshot();
        replies.push(await upload(2));
        await unprovisioned(target);
        expect(replies).toMatchObject([
          restoreResult(0),
          restoreResult(1),
          restoreRefusal,
        ]);
        expect(target.snapshot()).toEqual(staged);
      }),
    timeout,
  );
}

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
  const { head, eventWatermark, recordFloor, root } = recoverV3(
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
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      expect(pages(target)).toEqual(data.pages);
      const expected = await view(source);
      const restored = await view(target);
      expect(restored).toMatchObject({
        pages: (expected as Json).pages,
        publicDigest: data.publicDigest,
      });
      expect(restored.image).toEqual({
        ...expected.image,
        head: data.head + 1,
        eventWatermark: data.eventWatermark + 1,
      });
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
  "digest-only grant",
] as const) {
  test(
    `v3 restore refuses a typed transcript with ${fault}`,
    async () => {
      const source = guardFixture(typedEnv);
      const target = guardFixture(typedEnv);
      using _source = source.db;
      using _target = target.db;
      expect(await source.send(probe, {})).toMatchObject({ status: 200 });
      if (fault === "digest-only grant") await grantTypedUpdate(source);
      else {
        expect((await typed(source, missingUpdate)).status).toBe(404);
        await drain(source, 0, 1);
      }
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
      const staged = target.snapshot();
      expect(await upload(2)).toMatchObject(restoreRefusal);
      await unprovisioned(target);
      expect(target.snapshot()).toEqual(staged);
    },
    timeout,
  );
}

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
      const origin = recoverV3(from, source.seal());
      const restored = recoverV3(to, target.seal());
      const { lease: _lease, ...expected } = viewV3(origin).image as Json;
      const { lease: _restoredLease, ...actual } = viewV3(restored)
        .image as Json;
      expect(actual).toEqual({
        ...expected,
        head: data.head + 1,
        eventWatermark: data.eventWatermark + 1,
      });
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
    withPortable(async (target, data) => {
      const upload = await stageRestore(target, data);
      const before = target.snapshot();
      expect(await upload(2)).toMatchObject({
        status: 413,
        body: { error: { code: "RESTORE_TOO_LARGE" } },
      });
      await unprovisioned(target);
      expect(target.snapshot()).toEqual(before);
    }, 16),
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
      expect(await upload(2)).toMatchObject(restoreResult(2, true));
      target.restart();
      expect(await typed(target, missingUpdate)).toMatchObject({
        status: 404,
        body: { error: { code: "NOT_FOUND", message: "caf\u00e9" } },
      });
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
        const staged = target.snapshot();
        expect(await upload(2)).toMatchObject(restoreRefusal);
        await unprovisioned(target);
        expect(target.snapshot()).toEqual(staged);
      }),
    timeout,
  );
}
