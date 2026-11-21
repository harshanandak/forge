import { expect, test } from "bun:test";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { fixture, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const MiB = 1024 * 1024;
const HOUR = 3_600_000;
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};
const checkpointRoute = `${probe}/checkpoint`;
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};
type Fixture = ReturnType<typeof fixture>;
type Json = Record<string, unknown>;
interface DirectoryItem {
  collection: string;
  key: string;
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
const frame = (
  changes: readonly Json[] = [],
  events: readonly Json[] = [],
) => ({ operation: "fixture.put", time: Date.now(), events, changes });
const append = (f: Fixture, ...frames: Json[]) =>
  f.send(`${probe}/commits`, { frames });

async function withFixture(run: (f: Fixture) => Promise<void>) {
  const f = fixture();
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
      { subject: "work-1", holder, ...input },
      {
        "X-Forge-Owner": owner,
        "X-Forge-Owner-Expires": String(Date.now() + HOUR),
      },
    );
  expect(
    (
      await append(
        f,
        frame(
          [
            { key: "a", value: { revision: 1, text: "café" } },
            { key: "b", value: { revision: 1, text: "café" } },
            { key: "gone", value: 1 },
          ],
          [{ key: "a" }],
        ),
      )
    ).status,
  ).toBe(200);
  expect(
    (await lease("claim", "owner-a", { requestId: "acq-1", ttlMs: HOUR }))
      .status,
  ).toBe(200);
  expect(
    (await lease("claim", "owner-b", { requestId: "acq-2", ttlMs: HOUR }))
      .status,
  ).toBe(409);
  expect(
    (await lease("release", "owner-a", { requestId: "rel-1", generation: 1 }))
      .status,
  ).toBe(200);
  expect(
    (await append(f, frame([{ key: "gone", deleted: true }]))).status,
  ).toBe(200);
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

test(
  "v3 checkpoint seals records, release, refusal, tombstone and witness before collecting the log",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const before = await view(f);
      const original = commits(f).map(({ body }) => JSON.parse(body) as Json);
      const rows = f.reads.rows;
      const bytes = f.reads.bytes;
      const result = await checkpoint(f);
      expect(result.status).toBe(200);
      const reads = { rows: f.reads.rows - rows, bytes: f.reads.bytes - bytes };
      console.log("v3 checkpoint fixture reads", reads);
      expect(reads.rows).toBeLessThanOrEqual(64);
      expect(reads.bytes).toBeLessThanOrEqual(4 * MiB);
      expect(f.alarms).toEqual([]);
      expect(commits(f)).toEqual([]);
      expect(
        pages(f)
          .filter(({ id }) => id.startsWith("transcript:"))
          .flatMap(({ body }) => JSON.parse(body) as Json[]),
      ).toEqual(original);
      expect(await view(f)).toMatchObject({
        generation: 1,
        coveredHead: 5,
        eventWatermark: 1,
        image: before.image,
      });
      f.restart();
      expect((await view(f)).image).toEqual(before.image);

      expect(
        (await append(f, frame([{ key: "a", value: { revision: 2 } }]))).status,
      ).toBe(200);
      const next = await view(f);
      expect((await checkpoint(f)).status).toBe(200);
      expect(commits(f)).toEqual([]);
      f.restart();
      expect(await view(f)).toMatchObject({
        generation: 2,
        coveredHead: 6,
        image: next.image,
      });
    }),
  timeout,
);

test(
  "v3 checkpoint keeps a later append visible during staging and after eviction",
  () =>
    withFixture(async (f) => {
      await populate(f);
      let staged: Awaited<ReturnType<typeof view>> | undefined;
      afterSync(f, 1, async () => {
        expect(
          (await append(f, frame([{ key: "late", value: 9 }]))).status,
        ).toBe(200);
        staged = await view(f);
        expect(staged).toMatchObject({ generation: 0, image: { head: 6 } });
      });
      const result = await checkpoint(f);
      expect(result.status).toBe(200);
      expect(staged).toBeDefined();
      expect(commits(f).map(({ sequence }) => sequence)).toEqual([6]);
      const expected = { generation: 1, coveredHead: 5, image: staged!.image };
      expect(await view(f)).toMatchObject(expected);
      f.restart();
      expect(await view(f)).toMatchObject(expected);
    }),
  timeout,
);

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

function resealProposal(f: Fixture, countChange: number) {
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
    }[];
    counts: Record<string, number>;
    bytes: Record<string, number>;
  };
  for (const page of proposal.pages) {
    if (page.kind === "transcript") continue;
    const body = pageBody(f, page.id);
    const bytes = Buffer.byteLength(body);
    proposal.bytes[page.kind] = proposal.bytes[page.kind]! + bytes - page.bytes;
    proposal.counts[page.kind] = proposal.counts[page.kind]! + countChange;
    page.bytes = bytes;
    page.count += countChange;
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
    ({ collection, key }) => collection === "record" && key === "a",
  )!;
  const b = entries.find(
    ({ collection, key }) => collection === "record" && key === "b",
  )!;
  if (change === "a pointer to another key with identical value bytes") {
    a.offset = b.offset!;
    writePage(f, directoryId, canonicalJson(entries));
    resealProposal(f, 0);
    return;
  }

  const snapshotId = "snapshot:0";
  const snapshot = Buffer.from(pageBody(f, snapshotId));
  if (change === "a missing record") entries.splice(entries.indexOf(a), 1);
  const extra = { ...b, key: "c" };
  if (change === "an extra record")
    entries.splice(entries.indexOf(b) + 1, 0, extra);
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
  resealProposal(
    f,
    change === "a missing record" ? -1 : change === "an extra record" ? 1 : 0,
  );
}

for (const change of [
  "a missing release",
  "a missing record",
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
        let tampered = false;
        afterSync(f, 1, () => {
          changedPages(f, change, initialLease);
          tampered = true;
        });
        const result = await checkpoint(f);
        expect(result).toMatchObject(refused);
        expect(tampered).toBe(true);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
        f.restart();
        expect((await view(f)).image).toEqual(before.image);
      }),
    timeout,
  );
}

for (const changed of ["source", "cut"]) {
  test(
    `v3 checkpoint refuses a changed ${changed} before switching the root`,
    () =>
      withFixture(async (f) => {
        await populate(f);
        let source = active(f);
        const log = commits(f);
        afterSync(f, 1, () => {
          if (changed === "source") {
            const body = canonicalJson({
              ...(JSON.parse(root(f).body) as Json),
              incarnation: "competing-root",
            });
            f.db.run("UPDATE cloud_v3_root SET body=?, seal=? WHERE id=1", [
              body,
              digestBytes(body),
            ]);
            source = active(f);
          } else {
            expect(
              f.db.run("UPDATE cloud_v3_checkpoint SET cut=cut-1").changes,
            ).toBe(1);
          }
        });
        const result = await checkpoint(f);
        expect(result).toMatchObject(refused);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
      }),
    timeout,
  );
}

for (const point of ["before switch", "after switch", "during collection"]) {
  test(
    `v3 checkpoint recovers the complete image after a fault ${point}`,
    () =>
      withFixture(async (f) => {
        await populate(f);
        const before = await view(f);
        const source = active(f);
        const log = commits(f);
        if (point === "during collection") {
          const executeSql = f.storage.sql.exec.bind(f.storage.sql);
          f.storage.sql.exec = (statement, ...bindings) => {
            if (/^DELETE FROM cloud_v3_commits\b/i.test(statement)) {
              f.db.run("DELETE FROM cloud_v3_commits WHERE sequence=1");
              crash();
            }
            return executeSql(statement, ...bindings);
          };
        } else {
          afterSync(f, point === "before switch" ? 1 : 2, crash);
        }
        const result = await checkpoint(f);
        expect(result).toMatchObject(refused);
        expect(result.body).toMatchObject({
          error: { message: "Injected checkpoint fault" },
        });
        expect(commits(f)).toEqual(
          point === "during collection" ? log.slice(1) : log,
        );
        if (point === "before switch") expect(active(f)).toEqual(source);
        f.restart();
        expect(await view(f)).toMatchObject({
          generation: point === "before switch" ? 0 : 1,
          image: before.image,
        });
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
