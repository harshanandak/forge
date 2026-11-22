import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { expect, setSystemTime, test } from "bun:test";
import { Project } from "../../cloud/src/project.ts";
import { TABLE_PROBE } from "../../cloud/src/store.ts";
import {
  ringOf,
  sealKeys,
  sealOf,
  signRow,
  verifyRow,
} from "../../cloud/src/v3-seal.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import {
  copyTables,
  guardFixture,
  newKey,
  noWrites,
  probe,
  type SealSetup,
  trustedSeal,
} from "./v3-project.fixture.ts";

if (!("timingSafeEqual" in crypto.subtle))
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    value: timingSafeEqual,
  });

const timeout = 30_000;
const env = { FORGE_CLOUD_PROJECT: "a", FORGE_CLOUD_ID_PREFIX: "forge" };
const refused = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
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
const hexId = "a".repeat(64);

type Fixture = ReturnType<typeof guardFixture>;
type Row = { sequence: number; body: string; mac: string };
const rows = (f: Fixture) =>
  f.db.query<Row, []>("SELECT sequence, body, mac FROM cloud_v3_commits").all();
const failure = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error;
  }
};

async function history(f: Fixture, count = 2) {
  expect((await f.send(probe, {})).status).toBe(200);
  for (let i = 0; i < count; i++)
    expect((await f.send(`${probe}/commits`, { frames: [note] })).status).toBe(
      200,
    );
}

async function refusedAfterRestart(f: Fixture) {
  f.restart();
  const effects = f.observeEffects();
  expect(await f.send(probe)).toMatchObject(refused);
  expect(effects()).toEqual(noWrites);
}

function watch(f: Fixture) {
  const statements: string[] = [];
  const original = f.storage.sql.exec.bind(f.storage.sql);
  f.storage.sql.exec = (statement, ...bindings) => {
    statements.push(statement);
    return original(statement, ...bindings);
  };
  return statements;
}

function bad(f: Fixture, { key, previous, id }: SealSetup) {
  const config: Record<string, unknown> = { ...f.env };
  if (key === null) delete config.V3_SEAL_KEY;
  else if (key !== undefined) config.V3_SEAL_KEY = key;
  if (previous !== undefined) config.V3_SEAL_KEY_PREVIOUS = previous;
  const context =
    id === undefined
      ? f.context
      : {
          storage: f.storage,
          testV3: true,
          ...(id === null ? {} : { id: { toString: () => id } }),
        };
  return async (route: string, body?: unknown) => {
    const response = await new Project(context, config).fetch(
      f.request(route, body),
    );
    return {
      status: response.status,
      body: await response.json(),
    };
  };
}

test(
  "v3 provisioning with no seal key is refused as unavailable and writes nothing",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    const context = {
      storage: f.storage,
      testV3: true,
      id: { toString: () => hexId },
    };
    const effects = f.observeEffects();
    const response = await new Project(context, env).fetch(
      f.request(probe, {}),
    );
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

test(
  "seal keys are base64url of 32 or more bytes with one consistent key ring",
  () => {
    const [a, b] = [newKey(), newKey()];
    for (const key of [
      undefined,
      "",
      "short",
      "!".repeat(43),
      randomBytes(31).toString("base64url"),
      `${a}=`,
      42,
    ])
      expect(sealKeys(key)).toBeUndefined();
    expect(sealKeys(a)).toHaveLength(1);
    expect(sealKeys(a, b)).toHaveLength(2);
    expect(sealKeys(a, a)).toHaveLength(1);
    for (const previous of ["", "short", 7])
      expect(sealKeys(a, previous)).toBeUndefined();
    expect(sealKeys(undefined, b)).toBeUndefined();
    const [first] = sealKeys(a)!;
    expect(first.id).toBe(
      createHash("sha256")
        .update(Buffer.from(a, "base64url"))
        .digest("hex")
        .slice(0, 16),
    );
    const bytes = Buffer.alloc(32, 1);
    expect(ringOf(first, { id: first.id, bytes })).toBeUndefined();
    expect(ringOf(first, { id: "f".repeat(16), bytes })).toHaveLength(2);
    const id = { toString: () => hexId };
    const missing = [
      [{}, id],
      [{ V3_SEAL_KEY: a }, undefined],
      [{ V3_SEAL_KEY: a }, { toString: () => "" }],
      [{ V3_SEAL_KEY: "short" }, id],
    ] as const;
    for (const [config, scope] of missing)
      expect(failure(() => sealOf(config, scope))).toMatchObject({
        error: { code: "UNAVAILABLE" },
      });
  },
  timeout,
);

test(
  "a row verifies only under its own scope, incarnation, sequence, body and a configured key",
  () => {
    const [key, other] = [newKey(), newKey()];
    const id = { toString: () => hexId };
    const seal = sealOf({ V3_SEAL_KEY: key }, id);
    const mac = signRow(seal, "inc", 1, "body");
    const check = (
      value: unknown,
      incarnation: unknown = "inc",
      sequence: unknown = 1,
      body: unknown = "body",
      sealed = seal,
    ) => verifyRow(sealed, incarnation, sequence, body, value);
    expect(mac).toMatch(/^[0-9a-f]{16}\.[0-9a-f]{64}$/);
    expect(check(mac)).toBe(true);
    expect(check(mac, "other")).toBe(false);
    expect(check(mac, "inc", 2)).toBe(false);
    expect(check(mac, "inc", "1")).toBe(false);
    expect(check(mac, "inc", 1, "bod")).toBe(false);
    expect(check(mac, "inc", 1, null)).toBe(false);
    const scoped = sealOf(
      { V3_SEAL_KEY: key },
      { toString: () => "b".repeat(64) },
    );
    expect(check(mac, "inc", 1, "body", scoped)).toBe(false);
    expect(
      check(mac, "inc", 1, "body", sealOf({ V3_SEAL_KEY: other }, id)),
    ).toBe(false);
    const ring = sealOf({ V3_SEAL_KEY: other, V3_SEAL_KEY_PREVIOUS: key }, id);
    expect(check(mac, "inc", 1, "body", ring)).toBe(true);
    expect(signRow(ring, "inc", 1, "body").slice(0, 16)).toBe(
      sealKeys(other)![0].id,
    );
    for (const value of [
      "",
      undefined,
      7,
      mac.toUpperCase(),
      `${mac}.00`,
      mac.slice(0, -1),
      `${mac}0`,
      mac.replace(".", ".."),
      `${"0".repeat(16)}${mac.slice(16)}`,
      `${mac.slice(0, 17)}${"0".repeat(64)}`,
    ])
      expect(check(value)).toBe(false);
  },
  timeout,
);

const routes: [string, unknown?][] = [
  [probe],
  [probe, {}],
  [`${probe}/commits`, {}],
  [`${probe}/claim`, {}],
  [`${probe}/renew`, {}],
  [`${probe}/release`, {}],
  [`${probe}/command`, {}],
  [`${probe}/checkpoint`, {}],
  ["restore", {}],
  ["status"],
];
const configs: [string, SealSetup][] = [
  ["no key", { key: null }],
  ["a key under 32 bytes", { key: randomBytes(31).toString("base64url") }],
  ["a key that is not base64url", { key: "!".repeat(43) }],
  ["a malformed previous key", { previous: "short" }],
  ["a previous key and no current key", { key: null, previous: newKey() }],
  ["an empty object id", { id: "" }],
  ["no object id", { id: null }],
];

for (const [label, setup] of configs)
  test(
    `v3 refuses every route with ${label} before any SQL beyond the table probe`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f, 1);
      const send = bad(f, setup);
      const statements = watch(f);
      const effects = f.observeEffects();
      for (const [route, body] of routes) {
        statements.length = 0;
        const response = await send(route, body);
        expect(response).toMatchObject(refused);
        if (setup.key)
          expect(JSON.stringify(response)).not.toContain(setup.key);
        expect(statements).toEqual(route === "status" ? [TABLE_PROBE] : []);
      }
      expect(effects()).toEqual(noWrites);
    },
    timeout,
  );

test(
  "v3 checks the seal again on a warm request",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 1);
    expect((await f.send(probe)).status).toBe(200);
    delete f.env.V3_SEAL_KEY;
    const effects = f.observeEffects();
    expect(await f.send(probe)).toMatchObject(refused);
    expect(await f.send(`${probe}/commits`, { frames: [note] })).toMatchObject(
      refused,
    );
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

for (const key of [null, "short"])
  test(
    `ordinary routes work with ${key === null ? "no" : "a malformed"} seal key and no object id`,
    async () => {
      const f = guardFixture(env, { key, id: null });
      using _db = f.db;
      expect(await f.send("status")).toMatchObject({
        status: 200,
        body: { ok: true, value: { initialized: false } },
      });
      f.restart(false);
      const device = await f.send("devices", {
        device: "laptop",
        ttlMs: 60_000,
      });
      expect(device.status).toBe(200);
      const { token } = (device.body as { value: { token: string } }).value;
      expect(
        await f.send("command", create, { authorization: `Bearer ${token}` }),
      ).toMatchObject({ status: 200, body: { ok: true, op: create.op } });
      expect(await f.send("status")).toMatchObject({
        status: 200,
        body: { ok: true, value: { initialized: true } },
      });
    },
    timeout,
  );

const macEdits: [string, (mac: string) => string][] = [
  ["empty", () => ""],
  ["missing its dot", (mac) => mac.replace(".", "")],
  ["upper case", (mac) => mac.toUpperCase()],
  ["split on two dots", (mac) => mac.replace(".", "..")],
  ["one hex digit short", (mac) => mac.slice(0, -1)],
  ["one hex digit long", (mac) => `${mac}0`],
  [
    "a wrong tag under a known key id",
    (mac) => `${mac.slice(0, 17)}${"0".repeat(64)}`,
  ],
  [
    "a well-formed unknown key id",
    (mac) => `${"0".repeat(16)}${mac.slice(16)}`,
  ],
];

for (const [label, edit] of macEdits)
  test(
    `v3 refuses a stored row whose mac is ${label}`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f);
      f.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=1", [
        edit(rows(f)[0]!.mac),
      ]);
      await refusedAfterRestart(f);
    },
    timeout,
  );

const bodyEdits: [string, (frame: Record<string, unknown>) => unknown][] = [
  ["a time edit", (frame) => canonicalJson({ ...frame, time: 2 })],
  [
    "an events edit",
    (frame) => canonicalJson({ ...frame, events: [{ x: 1 }] }),
  ],
  [
    "a byte edit that keeps the same canonical value",
    (frame) => `${canonicalJson(frame)} `,
  ],
];

for (const [label, edit] of bodyEdits)
  for (const sequence of [1, 2])
    test(
      `v3 refuses ${label} in stored row ${sequence} with its mac untouched`,
      async () => {
        const f = guardFixture(env);
        using _db = f.db;
        await history(f);
        const stored = rows(f)[sequence - 1]!;
        f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=?", [
          edit(JSON.parse(stored.body) as Record<string, unknown>) as string,
          sequence,
        ]);
        await refusedAfterRestart(f);
      },
      timeout,
    );

for (const [label, mac] of [
  ["copied", (stored: Row) => stored.mac],
  ["invented", () => `${"0".repeat(16)}.${"0".repeat(64)}`],
] as const)
  test(
    `v3 refuses a coherent row inserted at the next sequence with a ${label} mac`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f);
      const second = rows(f)[1]!;
      const body = canonicalJson({ ...JSON.parse(second.body), sequence: 3 });
      f.db.run("INSERT INTO cloud_v3_commits VALUES (3, ?, ?)", [
        body,
        mac(second),
      ]);
      await refusedAfterRestart(f);
    },
    timeout,
  );

test(
  "v3 refuses a second frame under an existing receipt id that carries the first frame's mac",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 0);
    const start = Date.now();
    try {
      for (const [at, lifetime] of [
        [start, 5_000],
        [start + 6_000, 3_600_000],
      ] as const) {
        setSystemTime(at);
        const headers = {
          "X-Forge-Owner": "laptop",
          "X-Forge-Owner-Expires": String(at + lifetime),
        };
        expect(await f.send(`${probe}/command`, create, headers)).toMatchObject(
          { status: 200 },
        );
      }
    } finally {
      setSystemTime();
    }
    expect(rows(f)).toHaveLength(2);
    f.db.run("UPDATE cloud_v3_commits SET mac=? WHERE sequence=2", [
      rows(f)[0]!.mac,
    ]);
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 refuses the rows of another object that shares the key and accepts them under the same object id",
  async () => {
    const key = newKey();
    const a = guardFixture(env, { key });
    const b = guardFixture(env, { key });
    const same = guardFixture(env, { key, id: a.context.id!.toString() });
    using _a = a.db;
    using _b = b.db;
    using _same = same.db;
    await history(a);
    await history(b, 0);
    await history(same, 0);
    for (const target of [b, same]) {
      copyTables(a, target);
      target.restart();
    }
    expect(await b.send(probe)).toMatchObject(refused);
    expect(await same.send(probe)).toMatchObject({
      status: 200,
      body: { value: { image: { head: 2 } } },
    });
  },
  timeout,
);

test(
  "v3 refuses the rows of another object even when its own signer re-signs the copied root",
  async () => {
    const key = newKey();
    const a = guardFixture(env, { key });
    const b = guardFixture(env, { key });
    using _a = a.db;
    using _b = b.db;
    await history(a);
    await history(b, 0);
    copyTables(a, b);
    const { body } = b.db
      .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
      .get()!;
    b.db.run("UPDATE cloud_v3_root SET seal=?", [trustedSeal(b.db, body)]);
    b.restart();
    expect(await b.send(probe)).toMatchObject(refused);
  },
  timeout,
);

test(
  "v3 signs with the current key, verifies the previous key and refuses rows once their key is removed",
  async () => {
    const [first, second, third] = [newKey(), newKey(), newKey()];
    const f = guardFixture(env, { key: first });
    using _db = f.db;
    await history(f, 1);
    f.env.V3_SEAL_KEY = second;
    f.env.V3_SEAL_KEY_PREVIOUS = first;
    f.restart();
    expect(await f.send(probe)).toMatchObject({ status: 200 });
    expect(await f.send(`${probe}/commits`, { frames: [note] })).toMatchObject({
      status: 200,
    });
    expect(rows(f).map(({ mac }) => mac.slice(0, 16))).toEqual([
      sealKeys(first)![0].id,
      sealKeys(second)![0].id,
    ]);
    f.restart();
    expect(await f.send(probe)).toMatchObject({ status: 200 });
    delete f.env.V3_SEAL_KEY_PREVIOUS;
    await refusedAfterRestart(f);
    f.env.V3_SEAL_KEY = third;
    await refusedAfterRestart(f);
  },
  timeout,
);

for (const populated of [false, true])
  test(
    `v3 refuses an old two-column commit table ${populated ? "with" : "without"} rows before any statement that names mac and changes nothing`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f, 1);
      const old = rows(f)[0]!.body;
      f.db.run("DROP TABLE cloud_v3_commits");
      f.db.run(
        "CREATE TABLE cloud_v3_commits (sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
      );
      if (populated)
        f.db.run("INSERT INTO cloud_v3_commits VALUES (1, ?)", [old]);
      f.db.run(
        "CREATE TABLE cloud_v3_retired_pages (id TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
      );
      f.restart();
      const statements = watch(f);
      const effects = f.observeEffects();
      for (const [route, body, headers] of [
        [probe],
        [`${probe}/commits`, { frames: [note] }],
        [`${probe}/command`, create, owner],
        [`${probe}/checkpoint`, {}],
      ] as const)
        expect(await f.send(route, body, headers)).toMatchObject(refused);
      expect(effects()).toEqual(noWrites);
      expect(
        statements.filter(
          (text) => /\bmac\b/.test(text) && !/pragma_table_info/.test(text),
        ),
      ).toEqual([]);
    },
    timeout,
  );

test(
  "v3 checkpoint refuses an edited tail row and leaves every table unchanged",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 3);
    f.db.run("UPDATE cloud_v3_commits SET body=? WHERE sequence=2", [
      canonicalJson({ ...JSON.parse(rows(f)[1]!.body), time: 2 }),
    ]);
    f.restart();
    const effects = f.observeEffects();
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject(refused);
    expect(effects()).toEqual(noWrites);
  },
  timeout,
);

for (const read of ["archive", "recovery"] as const)
  test(
    `v3 checkpoint refuses when only the ${read} read sees an edited row and switches no root`,
    async () => {
      const f = guardFixture(env);
      using _db = f.db;
      await history(f);
      f.restart();
      const original = f.storage.sql.exec.bind(f.storage.sql);
      f.storage.sql.exec = (statement, ...bindings) => {
        const result = original(statement, ...bindings);
        const staged = statement.includes("(SELECT sequence, body, mac FROM");
        const target =
          read === "recovery"
            ? staged
            : !staged &&
              statement.includes("FROM cloud_v3_commits WHERE sequence>?");
        return target
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
    },
    timeout,
  );

test(
  "v3 does not detect deleted newest rows, a stated limit of the row seal",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f, 3);
    f.db.run("DELETE FROM cloud_v3_commits WHERE sequence=3");
    f.restart();
    expect(await f.send(probe)).toMatchObject({
      status: 200,
      body: { value: { image: { head: 2 } } },
    });
  },
  timeout,
);

test(
  "v3 refuses the tail after the root incarnation changes",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f);
    const { body } = f.db
      .query<{ body: string }, []>("SELECT body FROM cloud_v3_root")
      .get()!;
    const edited = canonicalJson({
      ...JSON.parse(body),
      incarnation: crypto.randomUUID(),
    });
    f.db.run("UPDATE cloud_v3_root SET body=?, seal=?", [
      edited,
      trustedSeal(f.db, edited),
    ]);
    await refusedAfterRestart(f);
  },
  timeout,
);

test(
  "v3 ignores a damaged row at or below the covered head of an ordinary root",
  async () => {
    const f = guardFixture(env);
    using _db = f.db;
    await history(f);
    expect(await f.send(`${probe}/checkpoint`, {})).toMatchObject({
      status: 200,
      body: { value: { coveredHead: 2 } },
    });
    f.db.run("INSERT INTO cloud_v3_commits VALUES (1, 'junk', '')");
    f.restart();
    expect(await f.send(probe)).toMatchObject({
      status: 200,
      body: { value: { image: { head: 2 } } },
    });
    expect(await f.send(`${probe}/commits`, { frames: [note] })).toMatchObject({
      status: 200,
      body: { value: { head: 3 } },
    });
  },
  timeout,
);
