import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import {
  StateOwner,
  verifyEventDerivedState,
} from "../../../src/core/state/index.ts";
import {
  checkpointTables,
  decodeCheckpoint,
  encodeCheckpoint,
  checkpointDigest,
  type Checkpoint,
} from "../../../src/core/state/checkpoint.ts";
import {
  migrate,
  stateMigrations,
  NewerStoreError,
} from "../../../src/core/state/migrations.ts";
import { instrument, reads } from "./numbered-fixture.ts";

const hash = `sha256:${"a".repeat(64)}`;
const lease = JSON.stringify({
  expiresAt: "1970-01-01T00:00:01.000Z",
  generation: 2,
  holder: {
    actor: { id: "builder", kind: "agent" },
    session: { id: "session" },
  },
  subject: "subject",
});
const value = (): Checkpoint => ({
  header: [1, "lineage", 2, 20, 1, 20],
  live: [["forge/test", "a", 3, 2, hash]],
  deleted: [["forge/test", "deleted", 4, 3]],
  leases: [["forge/test", "subject", 6, 2, lease]],
  reservations: [
    ["forge/test", "item-", 8, 1],
    ["forge/test", "item-", 9, 2],
  ],
  floors: [["forge/test", "item-", 10, 2]],
  receipts: [["forge/test", "request", 11, hash, hash]],
  denied: [["forge/test", "legacy", 12]],
});

test("checkpoint encoding is canonical, lossless and has a SHA-256 digest", () => {
  const input = value();
  const before = structuredClone(input);
  const encoded = encodeCheckpoint(input);
  expect(decodeCheckpoint(encoded)).toEqual(input);
  expect(encodeCheckpoint(decodeCheckpoint(encoded))).toBe(encoded);
  expect(checkpointDigest(input)).toBe(
    `sha256:${createHash("sha256").update(encoded).digest("hex")}`,
  );
  expect(checkpointDigest(decodeCheckpoint(encoded))).toBe(
    checkpointDigest(input),
  );
  expect(
    encodeCheckpoint(
      Object.fromEntries(
        Object.entries(input).reverse(),
      ) as unknown as Checkpoint,
    ),
  ).toBe(encoded);
  expect(input).toEqual(before);
}, 30000);

type Mutable = Record<string, unknown>;
for (const [name, input] of [
  [
    "empty allocation prefixes",
    {
      ...value(),
      reservations: [["forge/test", "", 8, 1]],
      floors: [["forge/test", "", 10, 1]],
    },
  ],
  ["zero floor", { ...value(), floors: [["forge/test", "item-", 10, 0]] }],
  [
    "UTF-8 primary key order",
    {
      ...value(),
      live: [
        ["forge/test", "\ue000", 3, 2, hash],
        ["forge/test", "\u{10000}", 4, 1, hash],
      ],
    },
  ],
  [
    "numeric reservation order",
    {
      ...value(),
      reservations: [
        ["forge/test", "item-", 8, 2],
        ["forge/test", "item-", 9, 10],
      ],
    },
  ],
  [
    "released lease",
    {
      ...value(),
      leases: [
        [
          "forge/test",
          "subject",
          6,
          2,
          lease.replace(
            '"subject"',
            '"releasedAt":"1970-01-01T00:00:00.000Z","subject"',
          ),
        ],
      ],
    },
  ],
] as const)
  test(`checkpoint accepts ${name}`, () => {
    const decoded = decodeCheckpoint(JSON.stringify(input));
    expect(decoded).toEqual(input);
    expect(decodeCheckpoint(encodeCheckpoint(decoded))).toEqual(input);
  }, 30000);
const malformed: [string, (input: Mutable) => void][] = [
  [
    "unknown field",
    (v) => {
      v.extra = true;
    },
  ],
  [
    "unknown version",
    (v) => {
      (v.header as unknown[])[0] = 0;
    },
  ],
  [
    "newer version",
    (v) => {
      (v.header as unknown[])[0] = 2;
    },
  ],
  [
    "missing kind",
    (v) => {
      delete v.denied;
    },
  ],
  [
    "extra header field",
    (v) => {
      (v.header as unknown[]).push(1);
    },
  ],
  [
    "archive beyond covered",
    (v) => {
      (v.header as unknown[])[5] = 21;
    },
  ],
  [
    "empty lineage",
    (v) => {
      (v.header as unknown[])[1] = "";
    },
  ],
  [
    "live and deleted key",
    (v) => {
      v.deleted = [["forge/test", "a", 4, 3]];
    },
  ],
  [
    "bad lease",
    (v) => {
      (v.leases as unknown[][])[0]![4] = "{}";
    },
  ],
  [
    "lease generation mismatch",
    (v) => {
      (v.leases as unknown[][])[0]![3] = 3;
    },
  ],
  [
    "lease subject mismatch",
    (v) => {
      (v.leases as unknown[][])[0]![1] = "other";
    },
  ],
  [
    "lease unknown field",
    (v) => {
      (v.leases as unknown[][])[0]![4] = lease.replace(
        '"generation":2',
        '"extra":1,"generation":2',
      );
    },
  ],
  [
    "bad digest",
    (v) => {
      (v.live as unknown[][])[0]![4] = "a";
    },
  ],
];
for (const kind of [
  "live",
  "deleted",
  "leases",
  "reservations",
  "floors",
  "receipts",
  "denied",
])
  for (const [name, change] of [
    ["duplicate", (rows: unknown[][]) => rows.push([...rows[0]!])],
    [
      "out of order",
      (rows: unknown[][]) => rows.unshift(["forge/zz", ...rows[0]!.slice(1)]),
    ],
    [
      "entry past C",
      (rows: unknown[][]) => {
        rows[0]![2] = 21;
      },
    ],
    [
      "zero sequence",
      (rows: unknown[][]) => {
        rows[0]![2] = 0;
      },
    ],
    ["extra column", (rows: unknown[][]) => rows[0]!.push("extra")],
    [
      "invalid namespace",
      (rows: unknown[][]) => {
        rows[0]![0] = "invalid";
      },
    ],
  ] as const)
    malformed.push([
      `${kind}: ${name}`,
      (v) => {
        change(v[kind] as unknown[][]);
      },
    ]);
for (const kind of ["live", "deleted", "leases"])
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
    malformed.push([
      `${kind}: invalid revision/generation ${bad}`,
      (v) => {
        (v[kind] as unknown[][])[0]![3] = bad;
      },
    ]);
for (const kind of ["live", "deleted", "leases", "receipts", "denied"])
  malformed.push([
    `${kind}: empty identity`,
    (v) => {
      (v[kind] as unknown[][])[0]![1] = "";
    },
  ]);
for (const index of [2, 4])
  for (const bad of [0, -1])
    malformed.push([
      `header positive integer ${index}: ${bad}`,
      (v) => {
        (v.header as unknown[])[index] = bad;
      },
    ]);
for (const [name, change] of malformed)
  test(`checkpoint refuses ${name}`, () => {
    const input = structuredClone(value()) as unknown as Mutable;
    change(input);
    const encoded = JSON.stringify(input);
    expect(() => decodeCheckpoint(encoded)).toThrow(
      name === "newer version" ? /newer Forge/i : /checkpoint/i,
    );
    expect(JSON.stringify(input)).toBe(encoded);
  }, 30000);
for (const encoded of ["null", "[]", "{", '{"header":[],"header":[]}'])
  test(`checkpoint refuses malformed JSON ${encoded}`, () => {
    expect(() => decodeCheckpoint(encoded)).toThrow();
  }, 30000);

const rows: Record<string, readonly (string | number)[]> = {
  state_checkpoint_header: [1, 1, "lineage", 1, 20, 1, 20],
  state_checkpoint_live: value().live[0]!,
  state_checkpoint_deleted: value().deleted[0]!,
  state_checkpoint_leases: value().leases[0]!,
  state_checkpoint_reservations: value().reservations[0]!,
  state_checkpoint_floors: value().floors[0]!,
  state_checkpoint_receipts: value().receipts[0]!,
  state_checkpoint_denied: value().denied[0]!,
};
async function open(beforeCheckpoint = false) {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  if (beforeCheckpoint)
    migrate(
      db,
      stateMigrations.filter((entry) => entry.id !== "004_state_checkpoint"),
    );
  else owner.initialize();
  return { db, owner, close: () => result.handle.close() };
}
for (const table of ["empty", ...Object.keys(rows)])
  test(`checkpoint image restore: ${table}`, async () => {
    const source = await open(),
      target = await open();
    try {
      expect(Object.keys(checkpointTables)).toEqual(Object.keys(rows));
      source.owner.put(
        "forge/test",
        "a",
        1,
        { kind: "agent", id: "builder" },
        { expectRevision: 0 },
      );
      if (table !== "empty") {
        const row = rows[table]!;
        source.db.run(
          `INSERT INTO ${table} VALUES (${row.map(() => "?").join(",")})`,
          row,
        );
      }
      const snapshot = source.owner.export();
      const before = target.owner.export();
      if (table === "empty") {
        target.owner.restore(snapshot);
        expect(target.owner.get("forge/test", "a")).toEqual(
          source.owner.get("forge/test", "a"),
        );
        expect(target.owner.events("forge/test")).toEqual(snapshot.events);
      } else {
        expect(() => target.owner.restore(snapshot)).toThrow(/newer Forge/i);
        expect(target.owner.export()).toEqual(before);
      }
      expect(source.owner.export()).toEqual(snapshot);
      const client = source.owner.client("forge/test", {
        kind: "agent",
        id: "builder",
      });
      expect(Object.keys(client).some((key) => /checkpoint/i.test(key))).toBe(
        false,
      );
    } finally {
      await source.close();
      await target.close();
    }
  }, 30000);
test("the previous initializer rejects migration 004 without writes", async () => {
  const source = await open();
  try {
    expect(stateMigrations.at(-1)?.id).toBe("004_state_checkpoint");
    const before = source.db.get("SELECT total_changes() AS n");
    expect(() => migrate(source.db, stateMigrations.slice(0, -1))).toThrow(
      NewerStoreError,
    );
    expect(source.db.get("SELECT total_changes() AS n")).toEqual(before);
  } finally {
    await source.close();
  }
}, 30000);

function canonicalDigest(input: unknown): string {
  const encoded = JSON.stringify(input, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );
  return `sha256:${createHash("sha256").update(encoded).digest("hex")}`;
}

type Store = Awaited<ReturnType<typeof open>>;
const actor = { kind: "agent", id: "builder" } as const;
const ns = "forge/test";
const write = (store: Store, key: string, revision = 0, requestId?: string) =>
  store.owner.put(ns, key, revision + 1, actor, {
    expectRevision: revision,
    ...(requestId === undefined ? {} : { requestId }),
  });
function publishFixture(store: Store, checkpoint: Checkpoint): void {
  const checked = decodeCheckpoint(encodeCheckpoint(checkpoint));
  for (const kind of Object.keys(checked) as (keyof Checkpoint)[]) {
    const table =
      kind === "header"
        ? "state_checkpoint_header"
        : `state_checkpoint_${kind}`;
    const tuples = kind === "header" ? [[1, ...checked.header]] : checked[kind];
    for (const tuple of tuples)
      store.db.run(
        `INSERT INTO ${table} VALUES (${tuple.map(() => "?").join(",")})`,
        tuple,
      );
  }
}
function prefix(store: Store): Checkpoint {
  const a = write(store, "a");
  write(store, "gone");
  store.owner.delete(ns, "gone", actor, { expectRevision: 1 });
  const retained = write(store, "retained", 0, "covered-request");
  const receipt = store.db.get(
    "SELECT fingerprint,result FROM state_requests",
  )!;
  return {
    header: [1, "lineage", 1, 4, 1, 4],
    live: [
      [ns, "a", 1, 1, canonicalDigest(a)],
      [ns, "retained", 4, 1, canonicalDigest(retained)],
    ],
    deleted: [[ns, "gone", 3, 2]],
    receipts: [
      [
        ns,
        "covered-request",
        4,
        canonicalDigest(JSON.parse(String(receipt.fingerprint))),
        canonicalDigest(JSON.parse(String(receipt.result))),
      ],
    ],
    leases: [],
    reservations: [],
    floors: [],
    denied: [],
  };
}
function tail(store: Store): void {
  write(store, "a", 1);
  write(store, "new", 0, "tail-request");
  store.owner.delete(ns, "retained", actor, { expectRevision: 1 });
  write(store, "gone");
}
const cases: readonly (readonly [
  string,
  boolean,
  (store: Store) => void,
  RegExp | undefined,
])[] = [
  ["empty tail and exact retained receipt", false, () => {}, undefined],
  [
    "writes updates deletes and revision 3 recreation",
    true,
    () => {},
    undefined,
  ],
  [
    "record digest mismatch",
    false,
    (s) => {
      const record = s.owner.get(ns, "a")!;
      s.db.run("UPDATE state_records SET body=? WHERE key='a'", [
        JSON.stringify({ ...record, value: 999 }),
      ]);
    },
    /state_records/,
  ],
  [
    "extra live row",
    false,
    (s) => {
      const record = { ...s.owner.get(ns, "a")!, key: "extra" };
      s.db.run("INSERT INTO state_records VALUES (?,?,?,?)", [
        ns,
        "extra",
        1,
        JSON.stringify(record),
      ]);
    },
    /state_records/,
  ],
  [
    "missing checkpoint live row",
    false,
    (s) => {
      s.db.run("DELETE FROM state_records WHERE key='a'");
    },
    /state_records/,
  ],
  [
    "missing checkpoint live row after tail",
    true,
    (s) => {
      s.db.run("DELETE FROM state_records WHERE key='a'");
    },
    /state_records/,
  ],
  [
    "recreation at revision 1",
    true,
    (s) => {
      const event = s.db.get("SELECT body FROM state_events WHERE key='gone'")!;
      const record = s.owner.get(ns, "gone")!;
      s.db.run("UPDATE state_events SET body=? WHERE key='gone'", [
        JSON.stringify({ ...JSON.parse(String(event.body)), revision: 1 }),
      ]);
      s.db.run("UPDATE state_records SET revision=1,body=? WHERE key='gone'", [
        JSON.stringify({ ...record, revision: 1 }),
      ]);
    },
    /state_records/,
  ],
  ...(["fingerprint", "result"] as const).map(
    (column) =>
      [
        `changed retained receipt ${column}`,
        false,
        (s: Store) => {
          s.db.run(
            `UPDATE state_requests SET ${column}='{}' WHERE request_id='covered-request'`,
          );
        },
        /state_requests/,
      ] as const,
  ),
  [
    "missing retained receipt",
    false,
    (s) => {
      s.db.run("DELETE FROM state_requests WHERE request_id='covered-request'");
    },
    /state_requests/,
  ],
  [
    "missing tail receipt",
    true,
    (s) => {
      s.db.run("DELETE FROM state_requests WHERE request_id='tail-request'");
    },
    /state_requests/,
  ],
  [
    "invalid tail receipt",
    true,
    (s) => {
      s.db.run(
        "UPDATE state_requests SET result='{}' WHERE request_id='tail-request'",
      );
    },
    /state_requests/,
  ],
  [
    "extra receipt",
    false,
    (s) => {
      s.db.run(
        "INSERT INTO state_requests SELECT namespace,'extra-request',fingerprint,result FROM state_requests",
      );
    },
    /state_requests/,
  ],
  [
    "reused covered request identity",
    true,
    (s) => {
      const row = s.db.get("SELECT body FROM state_events WHERE key='new'")!;
      s.db.run("UPDATE state_events SET body=? WHERE key='new'", [
        JSON.stringify({
          ...JSON.parse(String(row.body)),
          requestId: "covered-request",
        }),
      ]);
    },
    /state_requests/,
  ],
  [
    "tail starts after C plus 1",
    true,
    (s) => {
      s.db.run("DELETE FROM state_events WHERE sequence=5");
    },
    /state_events/,
  ],
];
for (const [name, withTail, change, error] of cases)
  for (const pageSize of [1, 100])
    test(`checkpoint replay: ${name}, page ${pageSize}`, async () => {
      const store = await open();
      try {
        const checkpoint = prefix(store);
        if (withTail) tail(store);
        publishFixture(store, checkpoint);
        store.db.run("DELETE FROM state_events WHERE sequence<=4");
        change(store);
        const before = store.owner.export();
        const changes = store.db.get("SELECT total_changes() AS n");
        const verify = () =>
          verifyEventDerivedState(store.db, withTail ? 8 : 4, pageSize);
        if (error) expect(verify).toThrow(error);
        else {
          expect(verify()).toBeUndefined();
          if (withTail) expect(store.owner.get(ns, "gone")?.revision).toBe(3);
        }
        expect(store.owner.export()).toEqual(before);
        expect(store.db.get("SELECT total_changes() AS n")).toEqual(changes);
      } finally {
        await store.close();
      }
    }, 30000);

for (const kind of ["leases", "floors", "reservations", "denied"] as const)
  test(`checkpoint replay refuses unsupported ${kind}`, async () => {
    const store = await open();
    try {
      const checkpoint = { ...prefix(store), [kind]: value()[kind] };
      publishFixture(store, { ...checkpoint, header: value().header });
      store.db.run("DELETE FROM state_events");
      const before = store.owner.export();
      expect(() => verifyEventDerivedState(store.db, 20)).toThrow(
        new RegExp(kind),
      );
      expect(store.owner.export()).toEqual(before);
    } finally {
      await store.close();
    }
  }, 30000);

for (const [name, revision, refused] of [
  ["matching revision", 1, false],
  ["wrong checkpoint revision with matching digest", 2, true],
] as const)
  test(`checkpoint replay: ${name}, C=2 and empty tail`, async () => {
    const store = await open();
    try {
      const record = write(store, "a");
      publishFixture(store, {
        header: [1, "lineage", 1, 2, 1, 2],
        live: [[ns, "a", 2, revision, canonicalDigest(record)]],
        deleted: [],
        receipts: [],
        leases: [],
        floors: [],
        reservations: [],
        denied: [],
      });
      store.db.run("DELETE FROM state_events");
      const before = store.owner.export();
      const verify = () => verifyEventDerivedState(store.db, 2, 1);
      if (refused) expect(verify).toThrow(/state_records/);
      else expect(verify()).toBeUndefined();
      expect(store.owner.export()).toEqual(before);
    } finally {
      await store.close();
    }
  }, 30000);

for (const prune of [false, true])
  test(`checkpoint replay ignores covered events: ${prune}`, async () => {
    const store = await open();
    try {
      const checkpoint = prefix(store);
      tail(store);
      if (prune) {
        publishFixture(store, checkpoint);
        store.db.run("UPDATE state_events SET body='{}' WHERE sequence<=4");
      }
      const before = store.owner.export();
      expect(verifyEventDerivedState(store.db, 8, 1)).toBeUndefined();
      expect(store.owner.export()).toEqual(before);
    } finally {
      await store.close();
    }
  }, 30000);

for (const [count, pageSize, bound] of [
  [0, 1, 5],
  [40, 1, 165],
  [40, 2, 85],
  [40, 16, 13],
] as const)
  test(`pre-004 replay query count: ${count} records, page ${pageSize}`, async () => {
    const store = await open(true),
      target = await open();
    try {
      for (let index = 0; index < count; index++)
        write(store, `key-${index}`, 0, `put-${index}`);
      const applied = store.db.all("SELECT id FROM state_migrations");
      const checkpointCapable = applied.some(
        (entry) => entry.id === "004_state_checkpoint",
      );
      expect(checkpointCapable).toBe(false);
      const snapshot = store.owner.export();
      const probe = instrument(store.db);
      expect(
        verifyEventDerivedState(
          probe.db,
          count,
          pageSize,
          undefined,
          checkpointCapable,
        ),
      ).toBeUndefined();
      expect(reads(probe.log).length).toBeLessThanOrEqual(bound);
      expect(probe.log[0]?.sql).toBe(
        "SELECT namespace,request_id,fingerprint,result FROM state_requests ORDER BY namespace,request_id LIMIT ?",
      );
      target.owner.restore(snapshot, undefined, pageSize);
      expect(target.owner.list(ns)).toHaveLength(count);
      expect(store.owner.export()).toEqual(snapshot);
    } finally {
      await store.close();
      await target.close();
    }
  }, 30000);
