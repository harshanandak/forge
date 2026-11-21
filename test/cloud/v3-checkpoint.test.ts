import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { fixture, probe } from "./v3-project.fixture.ts";

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
const stagingTables = (f: Fixture) =>
  f.db
    .query(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name GLOB 'cloud_v3_checkpoint*'",
    )
    .all();
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
    await lease("claim", "owner-a", { requestId: "acq-1", ttlMs: HOUR }),
  ).toMatchObject({ status: 200 });
  expect(
    await lease("claim", "owner-b", { requestId: "acq-2", ttlMs: HOUR }),
  ).toMatchObject({ status: 409, body: { error: { code: "LEASE_HELD" } } });
  expect(
    await lease("release", "owner-a", { requestId: "rel-1", generation: 1 }),
  ).toMatchObject({ status: 200 });
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

test(
  "v3 checkpoint verifies staged digests and keeps the active root and log intact",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const before = await view(f);
      const source = active(f);
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
        const refusalSlot = (JSON.parse(directory) as DirectoryItem[]).find(
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
            entries.filter((item) => item[2] !== null).length,
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
      expect(active(f)).toEqual(source);
      expect(commits(f)).toEqual(log);
      expect(stagingTables(f)).toEqual([]);
      f.restart();
      expect(await view(f)).toEqual(before);
    }),
  timeout,
);

test(
  "v3 checkpoint keeps a later append visible during staging and after eviction",
  () =>
    withFixture(async (f) => {
      await populate(f);
      const source = active(f);
      const log = commits(f);
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
        expect(stagingTables(f)).toEqual([]);
        expect((await checkpoint(f)).status).toBe(200);
        expect(active(f)).toEqual(source);
        expect(commits(f)).toEqual(log);
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
