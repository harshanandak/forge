import { timingSafeEqual } from "node:crypto";
import { expect, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
import { REPORT_UNTIL } from "../../cloud/src/report-app.ts";
import { sealKeys, verifyRoot } from "../../cloud/src/v3-seal.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import {
  guardFixture,
  newKey,
  noWrites,
  probe,
  type SealSetup,
  trustedManifest,
  trustedSeal,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const firstPage = { page: 0, id: "directory:0", body: "[]", manifest: {} };
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
};
const stopped = {
  status: 200,
  body: { ok: true, value: { initialized: true, stopped: true } },
};
const note = { operation: "fixture.note", time: 1, events: [] };
const owner = {
  "X-Forge-Owner": "laptop",
  "X-Forge-Owner-Expires": String(Date.now() + 3_600_000),
};
const create = {
  op: "issue.create",
  requestId: "create",
  input: { title: "Before" },
  context: { actor: { kind: "agent", id: "fixture" } },
};

type Fixture = ReturnType<typeof guardFixture>;
type Row = { sequence: number; body: string; mac: string };
const rows = (f: Fixture) =>
  f.db
    .query<Row, []>(
      "SELECT sequence, body, mac FROM cloud_v3_commits ORDER BY sequence",
    )
    .all();
const rootBody = (f: Fixture) =>
  f.db.query<{ body: string }, []>("SELECT body FROM cloud_v3_root").get()!
    .body;
const append = (f: Fixture, frame: unknown) =>
  f.send(`${probe}/commits`, { frames: [frame] });

function watch(f: Fixture) {
  const statements: string[] = [];
  const original = f.storage.sql.exec.bind(f.storage.sql);
  f.storage.sql.exec = (statement, ...bindings) => {
    statements.push(statement);
    return original(statement, ...bindings);
  };
  return statements;
}

const namesMac = (statements: readonly string[]) =>
  statements.filter(
    (text) => /\bmac\b/.test(text) && !/pragma_table_info/.test(text),
  );

const gated = [["status"], [probe], ["restore", firstPage]] as const;

async function history(f: Fixture, count = 2) {
  expect((await f.send(probe, {})).status).toBe(200);
  for (let i = 0; i < count; i++)
    expect((await append(f, note)).status).toBe(200);
}

async function refusedAfterRestart(f: Fixture) {
  f.restart();
  const effects = f.observeEffects();
  expect(await f.send(probe)).toMatchObject(refused);
  expect(effects()).toEqual(noWrites);
}

async function withActivated(run: (target: Fixture) => Promise<void>) {
  const source = guardFixture(env);
  const target = guardFixture(env);
  using _source = source.db;
  using _target = target.db;
  await history(source, 1);
  expect((await source.send(`${probe}/checkpoint`, {})).status).toBe(200);
  const pages = source.db
    .query<{ id: string; body: string }, []>(
      "SELECT id, body FROM cloud_v3_pages ORDER BY id",
    )
    .all()
    .map((page) =>
      page.id === "transcript:0"
        ? { ...page, body: canonicalJson([{ sequence: 1 }]) }
        : page,
    );
  const root = JSON.parse(rootBody(source)) as Record<string, unknown>;
  const manifest = trustedManifest(target.seal(), {
    format: "forge-cloud-portable/4",
    head: 1,
    eventWatermark: root.eventWatermark as number,
    recordFloor: 0,
    publicDigest: root.publicDigest as string,
    pages: pages.map(({ id, body }) => ({
      id,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    })),
    source: String(source.context.id),
  });
  const pin = digestBytes(canonicalJson(manifest));
  for (const [page, member] of pages.entries())
    expect(
      await target.send(
        "restore",
        { page, ...member, ...(page === 0 && { manifest }) },
        page === 0 ? { "X-Forge-Manifest-Digest": pin } : {},
      ),
    ).toMatchObject({
      status: 200,
      body: { ok: true, value: { page, verified: page === 2 } },
    });
  expect(await target.send("status")).toMatchObject(stopped);
  await run(target);
}

for (const populated of [false, true])
  test(
    `v3 restore into an old two-column commit table ${populated ? "with" : "without"} rows and no root is unavailable and changes nothing`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      f.db.run(
        "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
      );
      if (populated) f.db.run("INSERT INTO cloud_v3_commits VALUES (1, '{}')");
      const statements = watch(f);
      const effects = f.observeEffects();
      expect(await f.send("restore", firstPage)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(namesMac(statements)).toEqual([]);
    },
    timeout,
  );

test(
  "v3 restore into a current three-column commit table with no root still answers target not empty",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    f.db.run(
      "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL, mac TEXT NOT NULL)",
    );
    const effects = f.observeEffects();
    expect(await f.send("restore", firstPage)).toMatchObject({
      status: 409,
      body: { ok: false, error: { code: "RESTORE_TARGET_NOT_EMPTY" } },
    });
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

async function ordinary(setup: SealSetup) {
  const f = guardFixture(env, setup);
  using _db = f.db;
  const { testV3: _testV3, ...context } = f.context;
  const project = new Project(context, f.env);
  const statements = watch(f);
  const report = new Request("https://fixture.example/__forge/report?issue=x", {
    headers: { [REPORT_UNTIL]: String(Date.now() + 60_000) },
  });
  const device = { device: "laptop", ttlMs: 60_000 };
  const requests = [
    f.request("loginstart", {}),
    f.request("loginpoll", {}),
    f.request("state/read", {}),
    f.request("revoke", { id: "unknown" }),
    f.request("restore", {}),
    report,
    f.request("status"),
    f.request("dump"),
    f.request("upgrade"),
    f.request("devices", device),
    f.request("revoke", { id: "unknown" }),
    f.request("status"),
    f.request("loginstart", {}),
    f.request("holder"),
    f.request("upgrade", {}),
    ...["command", "claim", "renew", "release", "state/commit"].map((route) =>
      f.request(route, {}),
    ),
    new Request("https://fixture.example/device"),
    ...["/device", "/device/approve", "/device/deny"].map(
      (path) =>
        new Request(`https://fixture.example${path}`, {
          method: "POST",
          body: "{}",
        }),
    ),
    new Request(
      "https://fixture.example/callback?state=forge-device.unknown&code=fixture",
    ),
  ];
  const results: unknown[] = [];
  for (const request of requests) {
    const response = await project.fetch(request);
    const code = await response.json().then(
      (body) => (body as { error?: { code?: string } }).error?.code,
      () => "",
    );
    results.push([response.status, code]);
  }
  return { results, statements };
}

test(
  "ordinary routes answer the same with a missing or malformed seal key as with a valid one",
  async () => {
    const valid = await ordinary({});
    for (const setup of [
      { key: null, id: null },
      { key: "short", id: null },
      { key: null },
      { key: "short" },
    ])
      expect(await ordinary(setup)).toEqual(valid);
  },
  timeout,
);

test(
  "v3 checks the seal again on a warm request to an activated project",
  () =>
    withActivated(async (f) => {
      delete f.env.V3_SEAL_KEY;
      const effects = f.observeEffects();
      for (const [route, body] of gated)
        expect(await f.send(route, body)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
    }),
  timeout,
);

test(
  "v3 refuses an old two-column commit table on an activated root for recovery and restore",
  () =>
    withActivated(async (f) => {
      const [row] = rows(f);
      f.db.run("DROP TABLE cloud_v3_commits");
      f.db.run(
        "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
      );
      f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?)", [
        row!.sequence,
        row!.body,
      ]);
      f.restart();
      const statements = watch(f);
      const effects = f.observeEffects();
      for (const [route, body] of gated)
        expect(await f.send(route, body)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(namesMac(statements)).toEqual([]);
    }),
  timeout,
);

for (const [at, where] of [
  [1, "at or below the covered head of an activated root, end to end"],
  [
    3,
    "after the authentic activation row, so only the extra-row check can refuse",
  ],
] as const)
  test(
    `v3 refuses a second commit row ${where}`,
    () =>
      withActivated(async (f) => {
        f.restart();
        expect(await f.send("status")).toMatchObject(stopped);
        f.db.run("INSERT INTO cloud_v3_commits VALUES (?, 'junk', '')", [at]);
        f.restart();
        const effects = f.observeEffects();
        for (const route of ["status", probe])
          expect(await f.send(route)).toMatchObject(refused);
        expect(effects()).toEqual(noWrites);
      }),
    timeout,
  );

const sealOfRoot = (f: Fixture) =>
  f.db.query<{ body: string; seal: string }, []>(
    "SELECT body, seal FROM cloud_v3_root",
  );

test(
  "v3 signs an activated root under the current key and refuses a changed activation digest that keeps the envelope",
  () =>
    withActivated(async (f) => {
      const { body, seal } = sealOfRoot(f).get()!;
      expect(verifyRoot(f.seal(), body, seal)).toBe(true);
      const changed = canonicalJson({
        ...JSON.parse(body),
        activationDigest: digestBytes("another activation"),
      });
      f.db.run("UPDATE cloud_v3_root SET body=?", [changed]);
      f.restart();
      const effects = f.observeEffects();
      for (const [route, input] of gated)
        expect(await f.send(route, input)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(sealOfRoot(f).get()!.seal).toBe(seal);
    }),
  timeout,
);

test(
  "v3 reads a stopped activated root under a previous key and refuses it once that key is removed, never re-signing it",
  () =>
    withActivated(async (f) => {
      const { seal } = sealOfRoot(f).get()!;
      const first = f.env.V3_SEAL_KEY as string;
      f.env.V3_SEAL_KEY = newKey();
      f.env.V3_SEAL_KEY_PREVIOUS = first;
      f.restart();
      expect(await f.send("status")).toMatchObject(stopped);
      delete f.env.V3_SEAL_KEY_PREVIOUS;
      f.restart();
      expect(await f.send("status")).toMatchObject(refused);
      expect(sealOfRoot(f).get()!.seal).toBe(seal);
    }),
  timeout,
);

const put = (revision: number, value: string) => ({
  operation: "fixture.put",
  time: 1,
  events: [{ key: "r1", revision, value }],
  changes: [{ key: "r1", value: { revision, value } }],
});

test(
  "v3 refuses an edited earlier fixture-record row (a stand-in for a typed update) that a later unchanged row depends on, with its original mac",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 0);
    expect((await append(f, put(1, "first"))).status).toBe(200);
    expect((await append(f, put(2, "next"))).status).toBe(200);
    f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=1", [
      canonicalJson({
        ...JSON.parse(rows(f)[0]!.body),
        ...put(1, "edited"),
      }),
    ]);
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 refuses a stored ok outcome edited into a coherent refusal with its original mac and replays nothing",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 0);
    expect((await f.send(`${probe}/command`, create, owner)).status).toBe(200);
    const frame = JSON.parse(rows(f)[0]!.body) as Record<string, unknown> & {
      outcome: object;
    };
    const result = { code: "INPUT_INVALID", message: "Edited", retry: "never" };
    delete frame.changes;
    f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=1", [
      canonicalJson({
        ...frame,
        events: [],
        outcome: { ...frame.outcome, status: "INPUT_INVALID", result },
      }),
    ]);
    f.restart();
    const effects = f.observeEffects();
    expect(await f.send(`${probe}/command`, create, owner)).toMatchObject(
      refused,
    );
    expect(await f.send(probe)).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

async function substituted(f: Fixture, seal: (body: string) => string) {
  await history(f);
  const edited = canonicalJson({
    ...JSON.parse(rootBody(f)),
    incarnation: crypto.randomUUID(),
  });
  f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [edited, seal(edited)]);
  for (const { sequence, body } of rows(f))
    f.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=?", [
      f.sign(sequence, body),
      sequence,
    ]);
  f.restart();
  return f.send(probe);
}

test(
  "v3 refuses rows signed under a substituted root incarnation when the root seal is the plain digest",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    expect(await substituted(f, digestBytes)).toMatchObject(refused);
  },
  timeout,
);

test(
  "v3 accepts rows signed under a substituted root incarnation when a trusted signer signs the root, a trusted-signer control",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    expect(
      await substituted(f, (body) => trustedSeal(f.db, body)),
    ).toMatchObject({
      status: 200,
      body: { value: { image: { head: 2 } } },
    });
  },
  timeout,
);

test(
  "v3 checkpoint verifies rows signed under the previous key and signs new rows with the current key",
  async () => {
    const [first, second] = [newKey(), newKey()];
    const f = guardFixture(env, { key: first });
    using _db = f.db;
    await history(f);
    f.env.V3_SEAL_KEY = second;
    f.env.V3_SEAL_KEY_PREVIOUS = first;
    f.restart();
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject({
      status: 200,
      body: { value: { coveredHead: 2 } },
    });
    const archived = f.db
      .query<{ body: string }, []>(
        "SELECT body FROM cloud_v3_pages WHERE id='transcript:0'",
      )
      .get()!.body;
    expect(JSON.parse(archived)).toHaveLength(2);
    expect((await append(f, note)).status).toBe(200);
    expect(rows(f).map(({ mac }) => mac.slice(0, 16))).toEqual([
      sealKeys(second)![0].id,
    ]);
  },
  timeout,
);

test(
  "v3 checkpoint succeeds and switches the root once a recovery-only edited row is gone",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f);
    f.restart();
    const original = f.storage.sql.exec.bind(f.storage.sql);
    f.storage.sql.exec = (statement, ...bindings) => {
      const result = original(statement, ...bindings);
      return statement.includes("(SELECT sequence, body, mac FROM")
        ? {
            toArray: () =>
              result.toArray().map((row) => ({
                ...row,
                body: canonicalJson({
                  ...JSON.parse(String(row.body)),
                  time: 2,
                }),
              })),
          }
        : result;
    };
    const effects = f.observeEffects();
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
    f.storage.sql.exec = original;
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject({
      status: 200,
      body: { value: { coveredHead: 2 } },
    });
    expect(JSON.parse(rootBody(f))).toMatchObject({
      generation: 1,
      coveredHead: 2,
    });
  },
  timeout,
);

test(
  "v3 seal serves the already verified cached image on a warm read after the commit table is swapped for an old one, and refuses the next write (stated limit: a warm read does not re-read storage)",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 1);
    const warm = await f.send(probe);
    expect(warm.status).toBe(200);
    const [row] = rows(f);
    f.db.run("DROP TABLE cloud_v3_commits");
    f.db.run(
      "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
    );
    f.db.run("INSERT INTO cloud_v3_commits VALUES (?, ?)", [
      row!.sequence,
      row!.body,
    ]);
    const statements = watch(f);
    const effects = f.observeEffects();
    expect(await f.send(probe)).toEqual(warm);
    expect(effects()).toEqual(noWrites);
    expect(await append(f, note)).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
    expect(namesMac(statements)).toEqual([]);
    f.restart();
    expect(await f.send(probe)).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);
