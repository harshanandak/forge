import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { createStateClient } from "../../../src/assembly/state-client.ts";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
import type { StateRecord } from "../../../src/generated/types.ts";
import type { SqlDatabase, SqlValue } from "../../../src/ports/store.ts";

const namespace = "forge/test";
const actor = { kind: "agent" as const, id: "list-prefix" };

async function fixture() {
  const opened = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!opened.ok) throw new Error(opened.unavailable.reason);
  const real = opened.handle.value;
  const counted = {
    decoded: 0,
    rows: 0,
    sql: "",
    params: [] as readonly SqlValue[],
  };
  const db: SqlDatabase = {
    exec: (sql) => real.exec(sql),
    run: (sql, params) => real.run(sql, params),
    get: (sql, params) => real.get(sql, params),
    transaction: (body) => real.transaction(body),
    all(sql, params = []) {
      const rows = real.all(sql, params);
      counted.sql = sql;
      counted.params = params;
      counted.rows = rows.length;
      // StateOwner decodes JSON by reading row.body; count those reads, not elapsed time.
      return rows.map((row) => ({
        ...row,
        get body() {
          counted.decoded++;
          return row.body!;
        },
      }));
    },
  };
  const owner = new StateOwner(db, { now: () => 1000 });
  try {
    owner.initialize();
    const special = [
      "target/",
      "target/%",
      "target/%child",
      "target/_",
      "target/_child",
      "target/A",
      "target/a",
      "target/\u{10FFFF}",
      "target/\u{10FFFF}child",
      "target/\uFFFF",
      "target/\uFFFFchild",
      "target/\u{10000}",
      "\u{10FFFF}",
      "\u{10FFFF}child",
      "\u{10FFFF}\u{10FFFF}",
      "\u{10FFFF}\u{10FFFF}child",
      "target0/nearby",
      "Target/case",
    ];
    for (const [ns, size] of [
      [namespace, 600],
      ["forge/other", 200],
      ["forge/third", 200],
    ] as const) {
      owner.putMany(
        ns,
        Array.from({ length: size }, (_, index) => ({
          key:
            special[index] ??
            `${index % 2 === 0 ? "target/" : "other/"}${String(index).padStart(4, "0")}`,
          value: { index, ns, text: "unchanged % _" },
          expectRevision: 0,
        })),
        actor,
      );
    }
    expect(real.get("SELECT count(*) AS total FROM state_records")?.total).toBe(
      1000n,
    );
    // Independent reference: fetch in the original SQLite order, then apply JS startsWith.
    const records = real
      .all("SELECT body FROM state_records WHERE namespace=? ORDER BY key", [
        namespace,
      ])
      .map((row) => JSON.parse(String(row.body)) as StateRecord);
    const client = createStateClient({
      owner,
      namespace,
      context: { variant: "stateless" },
      write: false,
      requestId: "list-prefix",
    });
    return {
      owner,
      client,
      real,
      counted,
      records,
      close: () => opened.handle.close(),
    };
  } catch (error) {
    await opened.handle.close();
    throw error;
  }
}

test("RED: a prefix range decodes matching maximal-code-point suffixes instead of excluding them", async () => {
  const { owner, counted, records, close } = await fixture();
  try {
    const prefix = "target/";
    const expected = records.filter((record) => record.key.startsWith(prefix));
    expect(expected.map((record) => record.key)).toContain(
      `${prefix}\u{10FFFF}`,
    );
    expect(expected.map((record) => record.key)).toContain(
      `${prefix}\u{10FFFF}child`,
    );
    counted.decoded = 0;
    const actual = owner.list(namespace, prefix);
    // main's prefix + U+10FFFF bound excludes both maximal suffixes: 301 decoded, not 303.
    expect(counted.decoded).toBe(303);
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
  } finally {
    await close();
  }
}, 30_000);

test("prefix selection decodes only matches, preserves binary order and treats % and _ literally", async () => {
  const { owner, client, real, counted, records, close } = await fixture();
  try {
    for (const prefix of [
      "",
      "target/",
      "target/%",
      "target/_",
      "target/A",
      "Target/",
      "target/\uFFFF",
      "target/\u{10000}",
      "target/\u{10FFFF}",
      "\u{10FFFF}",
      "\u{10FFFF}\u{10FFFF}",
      "missing/",
    ]) {
      const expected = records.filter((record) =>
        record.key.startsWith(prefix),
      );
      for (const read of [
        () => owner.list(namespace, prefix),
        () => owner.client(namespace, actor).list(prefix),
        () => client.list(prefix),
      ]) {
        counted.decoded = 0;
        const actual = read();
        expect(counted.decoded).toBe(expected.length);
        expect(counted.rows).toBe(expected.length);
        expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        const plan = real
          .all(`EXPLAIN QUERY PLAN ${counted.sql}`, counted.params)
          .map((row) => String(row.detail))
          .join(" ");
        expect(plan).toContain(
          "SEARCH state_records USING INDEX sqlite_autoindex_state_records_1",
        );
        expect(plan).not.toContain("SCAN");
        expect(plan).not.toContain("TEMP B-TREE");
      }
    }
  } finally {
    await close();
  }
}, 30_000);

test("already working on main: listRange decodes at most its limit before JS truncation", async () => {
  const { owner, client, counted, records, close } = await fixture();
  try {
    for (const descending of [false, true]) {
      for (const limit of [1, 7, 1000]) {
        const range = { from: "target/", to: "target0", limit, descending };
        const matching = records.filter((record) =>
          record.key.startsWith("target/"),
        );
        const expected = (descending ? matching.toReversed() : matching).slice(
          0,
          limit,
        );
        for (const read of [
          () => owner.listRange(namespace, range),
          () => owner.client(namespace, actor).listRange(range),
          () => client.listRange(range),
        ]) {
          counted.decoded = 0;
          const actual = read();
          expect(counted.decoded).toBe(expected.length);
          expect(counted.decoded).toBeLessThanOrEqual(limit);
          expect(counted.rows).toBe(expected.length);
          expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
        }
      }
    }
  } finally {
    await close();
  }
}, 30_000);

function expectInvalidText(action: () => unknown, position: RegExp): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ForgeFailure);
  if (!(failure instanceof ForgeFailure))
    throw new Error("Expected INPUT_INVALID");
  expect(failure.error.code).toBe("INPUT_INVALID");
  expect(failure.error.retry).toBe("never");
  expect(failure.error.message).toMatch(position);
  expect(failure.error.message.isWellFormed()).toBe(true);
}

test("put refuses unpaired-surrogate keys before writing records or events", async () => {
  const { owner, real, close } = await fixture();
  try {
    const before = real.all(
      "SELECT * FROM state_records ORDER BY namespace,key",
    );
    const events = owner.events(namespace);
    for (const key of ["target/\ud800a", "target/\ud801a", "target/\udc00a"]) {
      expectInvalidText(
        () =>
          owner.put(namespace, key, "refused", actor, { expectRevision: 0 }),
        /key/i,
      );
    }
    expect(
      real.all("SELECT * FROM state_records ORDER BY namespace,key"),
    ).toEqual(before);
    expect(owner.events(namespace)).toEqual(events);
  } finally {
    await close();
  }
}, 30_000);

test("putMany refuses the whole batch when any key has an unpaired surrogate", async () => {
  const { owner, real, close } = await fixture();
  try {
    const before = real.all(
      "SELECT * FROM state_records ORDER BY namespace,key",
    );
    const events = owner.events(namespace);
    expectInvalidText(
      () =>
        owner.putMany(
          namespace,
          [
            {
              key: "batch/valid",
              value: "must not be written",
              expectRevision: 0,
            },
            { key: "target/\ud800a", value: "refused", expectRevision: 0 },
          ],
          actor,
        ),
      /key/i,
    );
    expect(
      real.all("SELECT * FROM state_records ORDER BY namespace,key"),
    ).toEqual(before);
    expect(owner.get(namespace, "batch/valid")).toBeUndefined();
    expect(owner.events(namespace)).toEqual(events);
  } finally {
    await close();
  }
}, 30_000);

test("list refuses unpaired-surrogate prefixes before querying through every client", async () => {
  const { owner, client, counted, close } = await fixture();
  try {
    for (const prefix of ["target/\ud800", "target/\ud801", "target/\udc00"]) {
      for (const read of [
        () => owner.list(namespace, prefix),
        () => owner.client(namespace, actor).list(prefix),
        () => client.list(prefix),
      ]) {
        counted.sql = "";
        counted.decoded = 0;
        expectInvalidText(read, /prefix/i);
        expect(counted.sql).toBe("");
        expect(counted.decoded).toBe(0);
      }
    }
  } finally {
    await close();
  }
}, 30_000);

test("well-formed astral keys still put, get and list exactly", async () => {
  const { owner, close } = await fixture();
  try {
    const key = "target/\u{1F600}";
    const record = owner.put(namespace, key, "astral", actor, {
      expectRevision: 0,
    });
    const child = owner.putMany(
      namespace,
      [{ key: `${key}/child`, value: "astral child", expectRevision: 0 }],
      actor,
    )[0]!;
    owner.put(namespace, "target/\u{1F601}", "nearby", actor, {
      expectRevision: 0,
    });
    expect(owner.get(namespace, key)).toEqual(record);
    expect(owner.get(namespace, child.key)).toEqual(child);
    expect(owner.list(namespace, key)).toEqual([record, child]);
  } finally {
    await close();
  }
}, 30_000);

test("get keeps reading existing malformed keys as on main", async () => {
  const { owner, real, close } = await fixture();
  try {
    const key = "legacy/\ud800a";
    expect(owner.get(namespace, key)).toBeUndefined();
    const record: StateRecord = {
      namespace,
      key,
      revision: 1,
      value: "legacy",
      updatedAt: new Date(1000).toISOString(),
      updatedBy: actor,
    };
    // Seed the row as the old writer stored it, bypassing the new write refusal.
    real.run(
      "INSERT INTO state_records(namespace,key,revision,body) VALUES (?,?,?,?)",
      [namespace, key, record.revision, JSON.stringify(record)],
    );
    expect(owner.get(namespace, key)).toEqual(record);
    expect(owner.get(namespace, "legacy/\ufffda")).toEqual(record);
  } finally {
    await close();
  }
}, 30_000);

test("acquire refuses a new malformed subject without writing any lease or event", async () => {
  const { owner, real, close } = await fixture();
  try {
    const holder = { actor, session: { id: "wellformed-keys" } };
    const events = owner.events(namespace);
    expectInvalidText(
      () =>
        owner.acquire(namespace, "lease/\ud800a", holder, 1000, "new-lease"),
      /subject/i,
    );
    expect(real.all("SELECT * FROM state_leases")).toEqual([]);
    expect(real.all("SELECT * FROM state_requests")).toEqual([]);
    expect(owner.events(namespace)).toEqual(events);
  } finally {
    await close();
  }
}, 30_000);

test("existing malformed lease subjects remain readable, acquirable and renewable", async () => {
  const { owner, real, close } = await fixture();
  try {
    const subject = "lease/\ud800a";
    const holder = { actor, session: { id: "legacy-lease" } };
    const legacy = {
      subject,
      holder,
      generation: 1,
      expiresAt: new Date(500).toISOString(),
    };
    real.run(
      "INSERT INTO state_leases(namespace,subject,generation,body) VALUES (?,?,?,?)",
      [namespace, subject, legacy.generation, JSON.stringify(legacy)],
    );
    expect(owner.lease(namespace, subject)).toEqual(legacy);
    const acquired = owner.acquire(
      namespace,
      subject,
      holder,
      1000,
      "legacy-lease",
    );
    expect(acquired.subject).toBe(subject);
    expect(acquired.generation).toBe(2);
    const fence = { subject, holder, generation: acquired.generation };
    expect(owner.renew(namespace, fence, 2000).subject).toBe(subject);
    expect(owner.release(namespace, fence).subject).toBe(subject);
    expect(owner.events(namespace, subject)).toHaveLength(3);
    expect(owner.history(namespace, { key: subject, limit: 10 })).toHaveLength(
      3,
    );
  } finally {
    await close();
  }
}, 30_000);
