import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { domain, Project } from "../../cloud/src/project.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { writableStore } from "../../cloud/src/store.ts";
import { recoverV3, viewV3 } from "../../cloud/src/v3-store.ts";
import { guardFixture, noWrites, probe } from "./v3-project.fixture.ts";

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
  "v3 checkpoint refuses a changed cut and keeps the staging append visible after eviction",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const source = active(f);
      const log = commits(f);
      let staged: Awaited<ReturnType<typeof view>> | undefined;
      afterSync(f, 1, async () => {
        expect((await append(f, putRecord("r4", 1, 9))).status).toBe(200);
        staged = await view(f);
        expect(staged).toMatchObject({ generation: 0, image: { head: 6 } });
      });
      const result = await checkpoint(f);
      expect(result).toMatchObject(refused);
      expect(staged).toBeDefined();
      expect(active(f)).toEqual(source);
      expect(commits(f).slice(0, -1)).toEqual(log);
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
      expect(await view(f)).toEqual(staged!);
      f.restart();
      expect(await view(f)).toEqual(staged!);
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
          digestBytes(body),
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
        const switched =
          point === "before collection" || point === "during collection";
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
              /^DELETE FROM cloud_v3_commits\b/i.test(statement)
            ) {
              f.storage.sql.exec = executeSql;
              f.db.run("DELETE FROM cloud_v3_commits WHERE sequence=1");
              crash();
            }
            return executeSql(statement, ...bindings);
          };
        } else {
          afterSync(f, switched ? 2 : 1, async () => {
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
        expect(commits(f)).toEqual(
          point === "during collection" ? log.slice(1) : log,
        );
        expect(pageSchema(f)).toEqual(schema);
        if (switched) {
          expect(retired(f)).toEqual(source.pages);
          expect(tableNames(f)).toEqual(tables.concat(maintenance).sort());
        } else {
          expect(active(f)).toEqual(source);
          if (point === "between renames")
            expect(stagingTables(f)).toHaveLength(2);
        }
        if (point === "before collection") {
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
        if (switched) {
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
          const tail = Array.from({ length: 13 }, () => frame());
          expect((await append(f, ...tail)).status).toBe(200);
          const effects = f.observeEffects();
          expect(await checkpoint(f)).toMatchObject(refused);
          expect(effects()).toEqual(noWrites);
          f.db.run("DELETE FROM cloud_v3_commits WHERE sequence=18");
          f.restart();
        }
        const rows = f.reads.rows;
        expect((await checkpoint(f)).status).toBe(200);
        const reads = f.reads.rows - rows;
        expect(reads).toBeLessThanOrEqual(64);
        console.log("v3 checkpoint retry rows", { point, reads });
        expect(commits(f)).toEqual([]);
        expect(tableNames(f)).toEqual(tables);
        expect(pageSchema(f)).toEqual(schema);
        const cut = switched ? 17 : 5;
        const image = { ...before.image, head: cut };
        await expectCut(f, switched ? 2 : 1, cut, image);
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

test(
  "v3 checkpoint refuses a tail that exceeds one maintenance turn before changing the source",
  () =>
    withFixture(async (f) => {
      expect(
        (await append(f, ...Array.from({ length: 65 }, () => frame()))).status,
      ).toBe(200);
      const source = active(f);
      const log = commits(f);
      const result = await checkpoint(f);
      expect(result).toMatchObject(refused);
      expect(active(f)).toEqual(source);
      expect(commits(f)).toEqual(log);
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
        digestBytes(updated),
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
      const project = new Project({ storage: f.storage, testV3: true });
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
  const verification = {
    admit: Project.admitLeaseRequest,
    pages: new Map<string, Buffer>(),
    sealed: () => {},
    portableTranscript: canonicalJson(frames),
  };
  return recoverV3(writableStore(target.storage), verification);
}

test(
  "v3 portable replay reconstructs the public projection from genesis",
  () =>
    withFixture(async (source) => {
      const frames = await portableHistory(source);
      const expected = recoverV3(writableStore(source.storage));
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
