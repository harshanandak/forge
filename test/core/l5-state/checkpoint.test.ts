import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { createSqliteStore } from "../../../src/adapters/store-sqlite/index.ts";
import { StateOwner } from "../../../src/core/state/index.ts";
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
      (rows: unknown[][]) =>
        rows.unshift(["forge/test", "z", ...rows[0]!.slice(2)]),
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
async function open() {
  const result = await createSqliteStore(tmpdir()).open({
    path: ":memory:",
    readOnly: false,
  });
  if (!result.ok) throw new Error(result.unavailable.reason);
  const db = result.handle.value;
  const owner = new StateOwner(db, { now: () => 1000 });
  owner.initialize();
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
test("the previous migration set refuses a checkpoint-aware store without writes", async () => {
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
