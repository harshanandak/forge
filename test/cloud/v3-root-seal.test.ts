import { expect, test } from "bun:test";
import { sealKeys, verifyRoot } from "../../cloud/src/v3-seal.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import {
  copyTables,
  guardFixture,
  newKey,
  noWrites,
  probe,
  trustedSeal,
} from "./v3-project.fixture.ts";

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};
const note = { operation: "fixture.note", time: 1, events: [] };
const headers = () => ({
  "X-Forge-Owner": "laptop",
  "X-Forge-Owner-Expires": String(Date.now() + 3_600_000),
});
const lease = {
  subject: "work-1",
  holder: {
    actor: { kind: "agent", id: "fixture" },
    session: { id: "fixture" },
  },
  requestId: "acq-1",
  ttlMs: 3_600_000,
};
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor: { kind: "agent", id: "fixture" } },
};
const ENVELOPE = /^[0-9a-f]{16}\.[0-9a-f]{64}$/;

type Fixture = ReturnType<typeof guardFixture>;
const idOf = (key: string) => sealKeys(key)![0].id;
const rootRow = (f: Fixture) =>
  f.db
    .query<{ body: string; seal: string }, []>(
      "SELECT body, seal FROM cloud_v3_root",
    )
    .get()!;
const setRoot = (f: Fixture, body: string, seal: string) =>
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [body, seal]);
const parsed = (f: Fixture) =>
  JSON.parse(rootRow(f).body) as { generation: number; parentDigest: string };
const rows = (f: Fixture) =>
  f.db
    .query<{ sequence: number; body: string; mac: string }, []>(
      "SELECT sequence, body, mac FROM cloud_v3_commits ORDER BY sequence",
    )
    .all();
const append = (f: Fixture) => f.send(`${probe}/commits`, { frames: [note] });
const checkpoint = (f: Fixture) => f.send(`${probe}/checkpoint`, {});

async function history(f: Fixture, count = 2) {
  expect((await f.send(probe, {})).status).toBe(200);
  for (let i = 0; i < count; i++) expect((await append(f)).status).toBe(200);
}

async function checkpointed(f: Fixture) {
  await history(f);
  expect(await checkpoint(f)).toMatchObject({
    status: 200,
    body: { value: { coveredHead: 2, more: false } },
  });
  expect(rows(f)).toEqual([]);
}

async function refusedAfterRestart(f: Fixture) {
  f.restart();
  const effects = f.observeEffects();
  expect(await f.send(probe)).toMatchObject(refused);
  expect(effects()).toEqual(noWrites);
}

const edited = (f: Fixture) => {
  const root = JSON.parse(rootRow(f).body) as { eventWatermark: number };
  return canonicalJson({ ...root, eventWatermark: root.eventWatermark + 1 });
};

test(
  "v3 refuses a coherent root edit whose seal is recomputed as the plain digest",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await checkpointed(f);
    const body = edited(f);
    setRoot(f, body, digestBytes(body));
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 refuses a coherent root edit that keeps the original envelope",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await checkpointed(f);
    setRoot(f, edited(f), rootRow(f).seal);
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 refuses a parse-equivalent rewrite of the root bytes under the original envelope",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await checkpointed(f);
    const { body, seal } = rootRow(f);
    const reversed = Object.fromEntries(
      Object.entries(JSON.parse(body) as object).reverse(),
    );
    setRoot(f, JSON.stringify(reversed), seal);
    await refusedAfterRestart(f);
  },
  timeout,
);

for (const kept of ["the plain digest", "the old envelope"])
  test(
    `v3 refuses a substituted incarnation with rows signed for it and ${kept} as the root seal`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f);
      const { body, seal } = rootRow(f);
      const swapped = canonicalJson({
        ...JSON.parse(body),
        incarnation: crypto.randomUUID(),
      });
      setRoot(
        f,
        swapped,
        kept === "the old envelope" ? seal : digestBytes(swapped),
      );
      for (const row of rows(f))
        f.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=?", [
          f.sign(row.sequence, row.body),
          row.sequence,
        ]);
      await refusedAfterRestart(f);
    },
    timeout,
  );

test(
  "v3 refuses an old unkeyed root on every route and changes nothing",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 1);
    const { body } = rootRow(f);
    setRoot(f, body, digestBytes(body));
    const calls: [string, unknown?, Record<string, string>?][] = [
      [probe],
      [probe, {}],
      [`${probe}/commits`, { frames: [note] }],
      [`${probe}/claim`, lease, headers()],
      [`${probe}/renew`, { ...lease, generation: 1 }, headers()],
      [`${probe}/release`, { ...lease, generation: 1 }, headers()],
      [`${probe}/command`, create, headers()],
      [`${probe}/checkpoint`, {}],
      ["status"],
      ["restore", { page: 0, id: "directory:0", body: "[]", manifest: {} }],
    ];
    const effects = f.observeEffects();
    for (const [route, input, extra] of calls) {
      f.restart();
      expect(await f.send(route, input, extra)).toMatchObject(refused);
    }
    expect(effects()).toEqual(noWrites);
    expect(rootRow(f).seal).toBe(digestBytes(body));
  },
  timeout,
);

test(
  "v3 refuses a whole sealed project with an empty tail copied into another object",
  async () => {
    const key = newKey();
    const source = guardFixture(env, { key });
    const target = guardFixture(env, { key });
    using _source = source.db;
    using _target = target.db;
    await checkpointed(source);
    expect((await target.send(probe, {})).status).toBe(200);
    copyTables(source, target);
    await refusedAfterRestart(target);
  },
  timeout,
);

test(
  "v3 refuses a root whose seal is a valid commit row envelope of the same object",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 1);
    setRoot(f, rootRow(f).body, rows(f)[0]!.mac);
    await refusedAfterRestart(f);
  },
  timeout,
);

const shapes: [string, (seal: string) => string][] = [
  ["empty", () => ""],
  ["uppercase", (seal) => seal.toUpperCase()],
  ["two dots", (seal) => `${seal.slice(0, 40)}.${seal.slice(41)}`],
  ["a short tag", (seal) => seal.slice(0, -1)],
  ["a long tag", (seal) => `${seal}0`],
  ["a wrong tag", (seal) => `${seal.slice(0, 16)}.${"0".repeat(64)}`],
  ["an unknown key id", (seal) => `${"1".repeat(16)}${seal.slice(16)}`],
  ["a seal over the SQL bound", () => "f".repeat(1 << 20)],
];

for (const [label, shape] of shapes)
  test(
    `v3 refuses a root envelope that is ${label} without loading an oversized seal`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await checkpointed(f);
      const { body, seal } = rootRow(f);
      setRoot(f, body, shape(seal));
      f.restart();
      const before = f.reads.bytes;
      expect(await f.send(probe)).toMatchObject(refused);
      expect(f.reads.bytes - before).toBeLessThan(1 << 20);
    },
    timeout,
  );

test(
  "v3 signs every checkpoint root under the current key and keeps the parent digest a plain digest",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f);
    for (const tail of [0, 1, 0]) {
      for (let i = 0; i < tail; i++) expect((await append(f)).status).toBe(200);
      const before = rootRow(f).body;
      expect((await checkpoint(f)).status).toBe(200);
      const { body, seal } = rootRow(f);
      expect(seal).toMatch(ENVELOPE);
      expect(verifyRoot(f.seal(), body, seal)).toBe(true);
      expect(parsed(f).parentDigest).toBe(digestBytes(before));
      f.restart();
      expect((await f.send(probe)).status).toBe(200);
    }
  },
  timeout,
);

test(
  "v3 checkpoints a root signed under the previous key and reads without it once the tail is empty",
  async () => {
    const [first, second] = [newKey(), newKey()];
    const f = guardFixture(env, { key: first });
    using _db = f.db;
    await history(f);
    expect(rootRow(f).seal.startsWith(`${idOf(first)}.`)).toBe(true);
    f.env.V3_SEAL_KEY = second;
    f.env.V3_SEAL_KEY_PREVIOUS = first;
    f.restart();
    expect((await checkpoint(f)).status).toBe(200);
    expect(rootRow(f).seal.startsWith(`${idOf(second)}.`)).toBe(true);
    delete f.env.V3_SEAL_KEY_PREVIOUS;
    f.restart();
    expect((await f.send(probe)).status).toBe(200);
  },
  timeout,
);

test(
  "v3 refuses a root still signed under a key that was removed and does not re-sign it",
  async () => {
    const f = guardFixture(env, { key: newKey() });
    using _db = f.db;
    await history(f, 0);
    f.env.V3_SEAL_KEY = newKey();
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 does not switch the checkpoint root when a different valid envelope replaces the source envelope",
  async () => {
    const [first, second] = [newKey(), newKey()];
    const f = guardFixture(env, { key: first });
    using _db = f.db;
    await history(f);
    f.env.V3_SEAL_KEY = second;
    f.env.V3_SEAL_KEY_PREVIOUS = first;
    f.restart();
    let calls = 0;
    Object.assign(f.storage, {
      sync: () => {
        if (++calls === 1)
          f.db.run("UPDATE cloud_v3_root SET seal=?", [
            trustedSeal(f.db, rootRow(f).body),
          ]);
        return Promise.resolve();
      },
    });
    expect(await checkpoint(f)).toMatchObject(refused);
    expect(parsed(f).generation).toBe(0);
    expect(rootRow(f).seal.startsWith(`${idOf(second)}.`)).toBe(true);
  },
  timeout,
);

test(
  "v3 serves an authenticated warm image after the stored root is damaged and refuses the next cold recovery, a stated limit",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f);
    const { body } = rootRow(f);
    setRoot(f, body, "");
    expect((await f.send(probe)).status).toBe(200);
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 accepts a rollback of root, pages and rows to an older sealed state, a stated limit",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 1);
    const saved = {
      root: rootRow(f),
      rows: rows(f),
      pages: f.db.query("SELECT id, body FROM cloud_v3_pages").all() as {
        id: string;
        body: string;
      }[],
    };
    expect((await append(f)).status).toBe(200);
    expect((await checkpoint(f)).status).toBe(200);
    for (const table of ["pages", "commits"])
      f.db.run(`DELETE FROM cloud_v3_${table}`);
    setRoot(f, saved.root.body, saved.root.seal);
    for (const { id, body } of saved.pages)
      f.db.run("INSERT INTO cloud_v3_pages VALUES (?, ?)", [id, body]);
    for (const { sequence, body, mac } of saved.rows)
      f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?, ?)", [
        sequence,
        body,
        mac,
      ]);
    f.restart();
    expect(await f.send(probe)).toMatchObject({
      status: 200,
      body: { value: { image: { head: 1 } } },
    });
  },
  timeout,
);
