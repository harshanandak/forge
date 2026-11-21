import type { Database } from "bun:sqlite";
import {
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";
import { scopeRequestId } from "../../cloud/src/issue-request-id.ts";
import { canonicalJson, digestBytes } from "../../src/core/config/pointer.ts";
import { fixture, probe } from "./v3-project.fixture.ts";

const timeout = 30_000;
const MiB = 1024 * 1024;
const ROSTER_PAGES = 640;
const DIRECTORY_PAGES = 32;
const DIRECTORY_BYTES = 4 * MiB;
const TAIL_ROWS = 1024;
const TAIL_BYTES = 16 * MiB;
const COLD_ROWS = 1750;
const COLD_BYTES = 22 * MiB;
const COLD_QUERY_ROWS = 4;
const T0 = Date.parse("2026-11-20T12:00:00.000Z");
const HOUR = 3_600_000;
const E1 = T0 + 2 * HOUR;
const E2 = T0 + 24 * HOUR;
const COVERED = 5000;
const WATERMARK = 9000;
const holder = {
  actor: { kind: "agent", id: "fixture" },
  session: { id: "fixture" },
};

beforeEach(() => setSystemTime(T0));
afterEach(() => setSystemTime());

type Fixture = ReturnType<typeof fixture>;
type Json = Record<string, unknown>;
type Slot = { readonly value: unknown } | null;
type Item = readonly [collection: string, key: string, slot: Slot];
interface Page {
  readonly id: string;
  readonly kind: string;
  readonly ordinal: number;
  readonly first: unknown;
  readonly last: unknown;
  readonly count: number;
  readonly bytes: number;
  readonly hash: string;
}
interface Stored extends Page {
  readonly body: string;
}
interface Frame {
  readonly time: number;
  readonly events: readonly unknown[];
  readonly lease?: { readonly subject: string };
  readonly outcome?: { readonly id: string };
  readonly witness?: { readonly id: string };
  readonly changes?: readonly {
    readonly key: string;
    readonly value?: unknown;
    readonly deleted?: true;
  }[];
}

const bytesOf = (text: string) => Buffer.byteLength(text);
const digestOf = (value: unknown) => digestBytes(canonicalJson(value));
const lease = (
  f: Fixture,
  route: string,
  owner: string,
  body: Json,
  expires = E1,
) =>
  f.send(
    `${probe}/${route}`,
    { subject: "work-1", holder, ...body },
    { "X-Forge-Owner": owner, "X-Forge-Owner-Expires": String(expires) },
  );
const claim = (f: Fixture, owner: string, expires = E1) =>
  lease(f, "claim", owner, { requestId: "acq-1", ttlMs: HOUR }, expires);
const commit = (f: Fixture, ...frames: Json[]) =>
  f.send(`${probe}/commits`, { frames });
const put = { operation: "fixture.put", time: T0, events: [] };
const image = (response: { body: unknown }) =>
  (response.body as { value?: { image?: Json } }).value?.image;
const unavailable = {
  status: 503,
  body: {
    ok: false,
    error: { code: "UNAVAILABLE", message: "Cloud v3 root is unavailable" },
  },
};

function page(
  kind: string,
  ordinal: number,
  body: string,
  count: number,
  first: unknown = null,
  last: unknown = null,
): Stored {
  return {
    id: `${kind}:${ordinal}`,
    kind,
    ordinal,
    first,
    last,
    count,
    bytes: bytesOf(body),
    hash: digestBytes(body),
    body,
  };
}

const directory = (entries: readonly Json[], ordinal: number) =>
  page(
    "directory",
    ordinal,
    canonicalJson(entries),
    entries.length,
    entries[0] ? [entries[0].collection, entries[0].key] : null,
    entries.at(-1) ? [entries.at(-1)!.collection, entries.at(-1)!.key] : null,
  );

const rootOf = (db: Database) =>
  db
    .query<{ body: string; seal: string }, []>(
      "SELECT body, seal FROM cloud_v3_root",
    )
    .get()!;

function writeRoot(db: Database, pages: readonly Page[], fields: Json) {
  const roster = pages.map(
    ({ id, kind, ordinal, first, last, count, bytes, hash }) => ({
      id,
      kind,
      ordinal,
      first,
      last,
      count,
      bytes,
      hash,
    }),
  );
  const total = (key: "count" | "bytes") => {
    const sums: Record<string, number> = {};
    for (const entry of roster)
      sums[entry.kind] = (sums[entry.kind] ?? 0) + entry[key];
    return sums;
  };
  const body = canonicalJson({
    ...(JSON.parse(rootOf(db).body) as Json),
    ...fields,
    counts: total("count"),
    bytes: total("bytes"),
    pages: roster,
  });
  db.run("UPDATE cloud_v3_root SET body=?, seal=?", [body, digestBytes(body)]);
}

function seal(
  db: Database,
  items: readonly Item[],
  coveredHead: number,
  eventWatermark: number,
  directoryPages = 1,
  snapshotPages = 1,
) {
  const sorted = [...items].sort(([a, k], [b, l]) =>
    a === b ? (k < l ? -1 : 1) : a < b ? -1 : 1,
  );
  const live = sorted.filter(([, , slot]) => slot !== null);
  const perSnapshot = Math.ceil(live.length / snapshotPages) || 1;
  const pointers = new Map<Item, Json>();
  const snapshots = Array.from({ length: snapshotPages }, (_, ordinal) => {
    const chunk = live.slice(
      ordinal * perSnapshot,
      (ordinal + 1) * perSnapshot,
    );
    let body = "";
    for (const item of chunk) {
      const text = canonicalJson(item[2]!.value);
      pointers.set(item, {
        page: `snapshot:${ordinal}`,
        offset: bytesOf(body),
        length: bytesOf(text),
        digest: digestBytes(text),
      });
      body += text;
    }
    return page("snapshot", ordinal, body, chunk.length);
  });
  const entries = sorted.map((item) => ({
    collection: item[0],
    key: item[1],
    ...(item[2] === null ? { deleted: true } : pointers.get(item)),
  }));
  const perDirectory = Math.ceil(entries.length / directoryPages) || 1;
  const pages = [
    ...Array.from({ length: directoryPages }, (_, ordinal) =>
      directory(
        entries.slice(ordinal * perDirectory, (ordinal + 1) * perDirectory),
        ordinal,
      ),
    ),
    ...snapshots,
    page(
      "transcript",
      0,
      "[]",
      coveredHead,
      coveredHead ? 1 : null,
      coveredHead || null,
    ),
  ];
  db.run("DELETE FROM cloud_v3_pages");
  const insert = db.prepare("INSERT INTO cloud_v3_pages VALUES (?, ?)");
  for (const { id, body } of pages) insert.run(id, body);
  writeRoot(db, pages, {
    generation: 1,
    parentDigest: rootOf(db).seal,
    coveredHead,
    eventWatermark,
  });
  db.run("DELETE FROM cloud_v3_commits WHERE sequence<=?", [coveredHead]);
  return pages;
}

function checkpoint(f: Fixture) {
  const frames = f.db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_commits ORDER BY sequence",
    )
    .all()
    .map(({ body }) => JSON.parse(body) as Frame);
  const items = new Map<string, Item>();
  const put = (collection: string, key: string, slot: Slot) =>
    items.set(`${collection}/${key}`, [collection, key, slot]);
  let events = 0;
  for (const frame of frames) {
    if (frame.lease) put("lease", frame.lease.subject, { value: frame.lease });
    if (frame.outcome)
      put("outcome", frame.outcome.id, {
        value: {
          time: frame.time,
          outcome: frame.outcome,
          ...(frame.lease && { lease: frame.lease }),
        },
      });
    if (frame.witness)
      put("witness", frame.witness.id, {
        value: { witness: frame.witness, lease: frame.lease },
      });
    for (const change of frame.changes ?? [])
      put(
        "record",
        change.key,
        change.deleted ? null : { value: change.value },
      );
    events += frame.events.length;
  }
  const pages = seal(f.db, [...items.values()], frames.length, events);
  f.restart();
  return pages;
}

function tail(
  db: Database,
  from: number,
  rows: number,
  rowBytes: (i: number) => number,
) {
  const insert = db.prepare("INSERT INTO cloud_v3_commits VALUES (?, ?)");
  for (let i = 0; i < rows; i++) {
    const sequence = from + i + 1;
    const frame = (pad: string) =>
      canonicalJson({
        events: [{ pad }],
        format: "forge-cloud-commit/3",
        operation: "fixture.put",
        sequence,
        time: T0,
      });
    insert.run(sequence, frame("x".repeat(rowBytes(i) - bytesOf(frame("")))));
  }
}

const widest = bytesOf(
  canonicalJson({
    collection: "record",
    digest: digestBytes(""),
    key: "r000000",
    length: 15,
    offset: 99_999,
    page: `snapshot:${ROSTER_PAGES}`,
  }),
);

interface Capacity {
  readonly roster?: number;
  readonly directoryPages?: number;
  readonly directoryBytes?: number;
  readonly tailRows?: number;
  readonly rowBytes?: (i: number) => number;
}

async function capacity(f: Fixture, shape: Capacity = {}) {
  const {
    roster = ROSTER_PAGES,
    directoryPages = DIRECTORY_PAGES,
    directoryBytes = DIRECTORY_BYTES,
    tailRows = TAIL_ROWS,
    rowBytes = () => TAIL_BYTES / TAIL_ROWS,
  } = shape;
  expect((await f.send(probe, {})).status).toBe(200);
  const perPage = Math.floor(
    (directoryBytes / directoryPages - 1) / (widest + 1),
  );
  const items = Array.from({ length: perPage * directoryPages }, (_, i) => {
    const key = `r${String(i).padStart(6, "0")}`;
    return ["record", key, { value: { v: key } }] as const;
  });
  const pages = seal(
    f.db,
    items,
    COVERED,
    WATERMARK,
    directoryPages,
    roster - directoryPages - 1,
  );
  tail(f.db, COVERED, tailRows, rowBytes);
  f.restart();
  f.reads.rows = 0;
  f.reads.bytes = 0;
  return {
    items,
    pages,
    directoryBytes: pages
      .filter(({ kind }) => kind === "directory")
      .reduce((sum, { bytes }) => sum + bytes, 0),
  };
}

test(
  "a cold routed read rebuilds a snapshot plus tail at the design limits within 1,750 rows and 22 MiB",
  async () => {
    const f = fixture();
    try {
      const { items, pages, directoryBytes } = await capacity(f);
      expect(pages).toHaveLength(ROSTER_PAGES);
      expect(directoryBytes).toBeLessThanOrEqual(DIRECTORY_BYTES);
      expect(directoryBytes).toBeGreaterThan(DIRECTORY_BYTES - 128 * 1024);
      const cold = await f.send(probe);
      const reads = { ...f.reads };
      expect(cold.status).toBe(200);
      const rebuilt = image(cold)!;
      expect(rebuilt).toMatchObject({
        head: COVERED + TAIL_ROWS,
        eventWatermark: WATERMARK + TAIL_ROWS,
        lease: {},
        outcome: {},
        witness: {},
      });
      const records = rebuilt.record as Record<string, unknown>;
      expect(Object.keys(records)).toHaveLength(items.length);
      expect(records[items.at(-1)![1]]).toBe(digestOf(items.at(-1)![2].value));
      expect(reads.rows).toBe(
        COLD_QUERY_ROWS + ROSTER_PAGES + DIRECTORY_PAGES + TAIL_ROWS,
      );
      expect(reads.rows).toBeLessThanOrEqual(COLD_ROWS);
      expect(reads.bytes).toBeGreaterThan(directoryBytes + TAIL_BYTES);
      expect(reads.bytes).toBeLessThanOrEqual(COLD_BYTES);
      const before = f.snapshot();
      expect(
        await commit(f, { operation: "fixture.put", time: T0, events: [] }),
      ).toMatchObject(unavailable);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

const overLimits: readonly [string, Capacity][] = [
  ["a 641-page roster", { roster: ROSTER_PAGES + 1, directoryBytes: MiB }],
  [
    "33 directory pages",
    { directoryPages: DIRECTORY_PAGES + 1, directoryBytes: MiB },
  ],
  ["directory pages over 4 MiB", { directoryBytes: DIRECTORY_BYTES + MiB }],
  ["1,025 tail rows", { tailRows: TAIL_ROWS + 1, rowBytes: () => 256 }],
  [
    "a tail one byte over 16 MiB",
    { rowBytes: (i) => TAIL_BYTES / TAIL_ROWS + (i === TAIL_ROWS - 1 ? 1 : 0) },
  ],
];

for (const [label, shape] of overLimits) {
  test(
    `a cold read of ${label} is refused within the read limits and serves nothing`,
    async () => {
      const f = fixture();
      try {
        await capacity(f, shape);
        const before = f.snapshot();
        const read = await f.send(probe);
        expect(f.reads.rows).toBeLessThanOrEqual(COLD_ROWS);
        expect(f.reads.bytes).toBeLessThanOrEqual(COLD_BYTES);
        expect(read).toMatchObject(unavailable);
        expect(read.body).not.toHaveProperty("value");
        expect(await claim(f, "owner-a")).toMatchObject(unavailable);
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "an append that would take the tail past 16 MiB is refused before any write, and one that fits is admitted",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      const full = TAIL_BYTES / TAIL_ROWS;
      tail(f.db, 0, TAIL_ROWS - 1, (i) =>
        i === TAIL_ROWS - 2 ? TAIL_BYTES - 4096 - (TAIL_ROWS - 2) * full : full,
      );
      f.restart();
      const frame = (pad: number) => ({
        ...put,
        events: [{ pad: "x".repeat(pad) }],
      });
      const before = f.snapshot();
      expect(await commit(f, frame(6000))).toMatchObject(unavailable);
      expect(f.snapshot()).toEqual(before);
      expect(await commit(f, frame(3000))).toMatchObject({
        status: 200,
        body: { value: { head: TAIL_ROWS } },
      });
      f.restart();
      expect(image(await f.send(probe))).toMatchObject({
        head: TAIL_ROWS,
        eventWatermark: TAIL_ROWS,
      });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

for (const at of ["tail", "directory"] as const) {
  test(
    `a key deleted in the ${at} stays deleted after a cold read`,
    async () => {
      const f = fixture();
      try {
        expect((await f.send(probe, {})).status).toBe(200);
        expect(
          await commit(f, {
            ...put,
            events: [{ key: "a" }, { key: "b" }],
            changes: [
              { key: "a", value: { n: 1 } },
              { key: "b", value: { n: 2 } },
            ],
          }),
        ).toMatchObject({ status: 200 });
        if (at === "tail") checkpoint(f);
        expect(
          await commit(f, {
            operation: "fixture.delete",
            time: T0 + 1,
            events: [{ key: "a" }],
            changes: [{ key: "a", deleted: true }],
          }),
        ).toMatchObject({ status: 200 });
        if (at === "directory") checkpoint(f);
        const warm = await f.send(probe);
        f.restart();
        const cold = await f.send(probe);
        expect(cold).toEqual(warm);
        expect(image(cold)).toEqual({
          head: 2,
          eventWatermark: 3,
          lease: {},
          outcome: {},
          witness: {},
          record: { a: null, b: digestOf({ n: 2 }) },
        });
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "each committed write, a recorded refusal included, publishes its frames to the cached image, the next read does no recovery, and every image equals a cold recovery",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      const writes: [() => Promise<{ status: number }>, number][] = [
        [() => commit(f, { ...put, changes: [{ key: "a", value: 1 }] }), 200],
        [() => claim(f, "owner-a"), 200],
        [() => claim(f, "owner-b"), 409],
        [() => claim(f, "owner-a"), 200],
        [() => commit(f, put), 200],
      ];
      for (const [write, status] of writes) {
        expect((await write()).status).toBe(status);
        f.reads.rows = 0;
        const warm = await f.send(probe);
        expect(f.reads.rows).toBe(0);
        f.restart();
        expect(await f.send(probe)).toEqual(warm);
      }
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a write refused because storage moved past the cached head marks the image stale, and the next read recovers the stored head",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      expect(await commit(f, put)).toMatchObject({ status: 200 });
      tail(f.db, 1, 1, () => 256);
      const stored = f.snapshot();
      expect(await commit(f, put)).toMatchObject(unavailable);
      expect(f.snapshot()).toEqual(stored);
      f.reads.rows = 0;
      const warm = await f.send(probe);
      expect(f.reads.rows).toBeGreaterThan(0);
      expect(image(warm)).toMatchObject({ head: 2, eventWatermark: 1 });
      f.restart();
      expect(await f.send(probe)).toEqual(warm);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a write that fails after staging publishes nothing, and the next read recovers from storage",
  async () => {
    let failing = false;
    let inserts = 0;
    const f = fixture((sql) => {
      if (failing && sql.startsWith("INSERT INTO cloud_v3_commits"))
        if (++inserts === 2) throw new Error("injected insert failure");
    });
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      expect(await commit(f, put)).toMatchObject({ status: 200 });
      const before = await f.send(probe);
      const stored = f.snapshot();
      failing = true;
      expect(await commit(f, put, put)).toMatchObject({
        status: 500,
        body: { ok: false, error: { code: "INTERNAL" } },
      });
      expect(inserts).toBe(2);
      failing = false;
      expect(f.snapshot()).toEqual(stored);
      f.reads.rows = 0;
      expect(await f.send(probe)).toEqual(before);
      expect(f.reads.rows).toBeGreaterThan(0);
      f.reads.rows = 0;
      expect(await f.send(probe)).toEqual(before);
      expect(f.reads.rows).toBe(0);
      expect(await commit(f, put)).toMatchObject({
        status: 200,
        body: { value: { head: 2 } },
      });
      const warm = await f.send(probe);
      f.restart();
      expect(await f.send(probe)).toEqual(warm);
    } finally {
      logged.mockRestore();
      f.db.close();
    }
  },
  timeout,
);

test(
  "a malformed synthetic frame is refused as input before the root is read, with or without a root",
  async () => {
    const f = fixture();
    try {
      const malformed = [
        { ...put, extra: 1 },
        { ...put, operation: "" },
        { ...put, events: {} },
        { ...put, changes: {} },
        { ...put, changes: [{ key: "", value: 1 }] },
        { ...put, changes: [{ key: "a" }] },
        { ...put, changes: [{ key: "a", deleted: false }] },
        { ...put, changes: [{ key: "a", value: 1, deleted: true }] },
      ];
      for (const provisioned of [false, true]) {
        if (provisioned) expect((await f.send(probe, {})).status).toBe(200);
        const before = f.snapshot();
        for (const frame of malformed)
          expect(await commit(f, put, frame)).toMatchObject({
            status: 400,
            body: { ok: false, error: { code: "INPUT_INVALID" } },
          });
        expect(f.snapshot()).toEqual(before);
      }
      f.restart();
      expect(image(await f.send(probe))).toMatchObject({ head: 0 });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

async function snapshotWithClaim(f: Fixture) {
  expect((await f.send(probe, {})).status).toBe(200);
  expect(
    await commit(f, {
      operation: "fixture.put",
      time: T0,
      events: [{ key: "a" }, { key: "b" }],
    }),
  ).toMatchObject({ status: 200 });
  expect(await claim(f, "owner-a")).toMatchObject({ status: 200 });
  const folded = image(await f.send(probe));
  checkpoint(f);
  expect(image(await f.send(probe))).toEqual(folded);
}

test(
  "a claim, renew, and release honor the lease and its generation floor on a checkpointed root",
  async () => {
    const f = fixture();
    try {
      await snapshotWithClaim(f);
      expect(await claim(f, "owner-b")).toMatchObject({
        status: 409,
        body: { error: { code: "LEASE_HELD" } },
      });
      setSystemTime(T0 + 1);
      expect(
        await lease(f, "renew", "owner-a", {
          requestId: "ren-1",
          generation: 1,
          ttlMs: HOUR,
        }),
      ).toMatchObject({
        status: 200,
        body: {
          value: {
            generation: 1,
            expiresAt: new Date(T0 + HOUR + 1).toISOString(),
          },
        },
      });
      expect(
        await lease(f, "release", "owner-a", {
          requestId: "rel-1",
          generation: 1,
        }),
      ).toMatchObject({
        status: 200,
        body: {
          value: { generation: 1, releasedAt: new Date(T0 + 1).toISOString() },
        },
      });
      f.restart();
      expect(
        await lease(f, "claim", "owner-b", { requestId: "acq-2", ttlMs: HOUR }),
      ).toMatchObject({ status: 200, body: { value: { generation: 2 } } });
      expect(image(await f.send(probe))).toMatchObject({
        head: 6,
        eventWatermark: 2,
      });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a receipt-only refusal survives eviction without advancing the event watermark",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      expect(await commit(f, { ...put, events: [{ key: "a" }] })).toMatchObject(
        { status: 200 },
      );
      expect(await claim(f, "owner-a")).toMatchObject({ status: 200 });
      const refusal = await claim(f, "owner-b");
      expect(refusal).toMatchObject({
        status: 409,
        body: { error: { code: "LEASE_HELD" } },
      });
      const before = f.snapshot();
      f.restart();
      expect(await claim(f, "owner-b")).toEqual(refusal);
      expect(image(await f.send(probe))).toMatchObject({
        head: 3,
        eventWatermark: 1,
      });
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a replay reads exactly the sealed outcome, lease, and any needed witness slices",
  async () => {
    const f = fixture();
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      for (let i = 0; i < 16; i++) {
        expect(
          await commit(f, {
            ...put,
            changes: [{ key: `padding-${i}`, value: "é".repeat(2048) }],
          }),
        ).toMatchObject({ status: 200 });
      }
      const acquired = await claim(f, "owner-a");
      expect(acquired).toMatchObject({ status: 200 });
      const renewedAt = T0 + HOUR / 2;
      setSystemTime(renewedAt);
      const renewed = await lease(
        f,
        "renew",
        "owner-a",
        { requestId: "ren-1", generation: 1, ttlMs: 23 * HOUR },
        E2,
      );
      expect(renewed).toMatchObject({ status: 200 });
      const phases = [
        { at: renewedAt, expected: renewed, rows: 2 },
        { at: E1 + 1, expected: acquired, rows: 3 },
      ];
      for (const { at, expected } of phases) {
        setSystemTime(at);
        f.restart();
        expect(await claim(f, "owner-a", E2)).toEqual(expected);
      }
      const pages = checkpoint(f);
      const entries = JSON.parse(pages[0]!.body) as {
        collection: string;
        key: string;
        length: number;
      }[];
      const original = scopeRequestId(
        "lease",
        ["owner", "owner-a", "owner-a"],
        "acq-1",
      );
      const before = f.snapshot();
      for (const { at, expected, rows } of phases) {
        setSystemTime(at);
        f.restart();
        expect((await f.send(probe)).status).toBe(200);
        f.reads.rows = 0;
        f.reads.bytes = 0;
        expect(await claim(f, "owner-a", E2)).toEqual(expected);
        const bytes = entries
          .filter(
            ({ collection, key }) =>
              collection === "lease" ||
              (key === original &&
                (collection === "outcome" ||
                  (rows === 3 && collection === "witness"))),
          )
          .reduce((sum, { length }) => sum + length, 0);
        expect(f.reads).toEqual({ rows, bytes });
        expect(f.snapshot()).toEqual(before);
      }
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a changed payload slice on a sealed page is unavailable without a write",
  async () => {
    const f = fixture();
    try {
      await snapshotWithClaim(f);
      expect(
        f.db.run(
          `UPDATE cloud_v3_pages SET body=replace(body, '"status":"ok"', '"status":"xx"') WHERE id='snapshot:0'`,
        ).changes,
      ).toBe(1);
      f.restart();
      expect((await f.send(probe)).status).toBe(200);
      const before = f.snapshot();
      expect(await claim(f, "owner-a")).toMatchObject(unavailable);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.db.close();
    }
  },
  timeout,
);

test(
  "a deeply nested tail row is unavailable and no operation can use it",
  async () => {
    const f = fixture();
    const logged = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await f.send(probe, {})).status).toBe(200);
      const nested = "[".repeat(10_000) + "0" + "]".repeat(10_000);
      const frame = `{"events":[${nested}],"format":"forge-cloud-commit/3","operation":"fixture.put","sequence":1,"time":${T0}}`;
      f.db.run("INSERT INTO cloud_v3_commits VALUES (1, ?)", [frame]);
      const before = f.snapshot();
      f.restart();
      expect(await f.send(probe)).toMatchObject(unavailable);
      expect(await claim(f, "owner-a")).toMatchObject(unavailable);
      expect(await commit(f, put)).toMatchObject(unavailable);
      expect(f.snapshot()).toEqual(before);
    } finally {
      logged.mockRestore();
      f.db.close();
    }
  },
  timeout,
);

function reseal(
  db: Database,
  edit: (entries: Json[]) => Json[],
  roster: (entry: Page) => Page = (entry) => entry,
) {
  const { pages } = JSON.parse(rootOf(db).body) as { pages: Page[] };
  const current = db
    .query<{ body: string }, []>(
      "SELECT body FROM cloud_v3_pages WHERE id='directory:0'",
    )
    .get()!.body;
  const edited = directory(edit(JSON.parse(current) as Json[]), 0);
  db.run("UPDATE cloud_v3_pages SET body=? WHERE id='directory:0'", [
    edited.body,
  ]);
  writeRoot(
    db,
    pages.map((entry) => (entry.id === edited.id ? roster(edited) : entry)),
    {},
  );
}

const first =
  (change: Json) =>
  ([head, ...rest]: Json[]) => [{ ...head, ...change }, ...rest];

const corruptions: readonly [string, (db: Database) => void][] = [
  [
    "a missing directory page",
    (db) => db.run("DELETE FROM cloud_v3_pages WHERE id='directory:0'"),
  ],
  [
    "a page outside the roster",
    (db) =>
      db.run(
        "INSERT INTO cloud_v3_pages SELECT 'snapshot:1', body FROM cloud_v3_pages WHERE id='snapshot:0'",
      ),
  ],
  [
    "a directory page changed in place",
    (db) =>
      db.run(
        "UPDATE cloud_v3_pages SET body=replace(body,'work-1','work-2') WHERE id='directory:0'",
      ),
  ],
  [
    "a resealed pointer past the end of its page",
    (db) => reseal(db, first({ offset: 1_000_000 })),
  ],
  [
    "a resealed pointer into a directory page",
    (db) => reseal(db, first({ page: "directory:0", offset: 0 })),
  ],
  [
    "a resealed pointer to a page outside the roster",
    (db) => reseal(db, first({ page: "snapshot:9" })),
  ],
  [
    "a resealed pointer whose digest is not a digest",
    (db) => reseal(db, first({ digest: "sha256:abc" })),
  ],
  [
    "resealed entries out of order",
    (db) => reseal(db, ([a, b, ...rest]) => [b!, a!, ...rest]),
  ],
  [
    "a resealed roster count that does not match its page",
    (db) =>
      reseal(
        db,
        (entries) => entries,
        (entry) => ({ ...entry, count: entry.count + 1 }),
      ),
  ],
];

for (const [label, corrupt] of corruptions) {
  test(
    `v3 recovery refuses ${label} and serves nothing from it`,
    async () => {
      const f = fixture();
      try {
        await snapshotWithClaim(f);
        const pristine = image(await f.send(probe));
        expect(pristine).toMatchObject({
          head: 2,
          eventWatermark: 2,
          record: {},
        });
        expect(Object.keys(pristine!.lease as Json)).toEqual(["work-1"]);
        corrupt(f.db);
        f.restart();
        const before = f.snapshot();
        const read = await f.send(probe);
        expect(read).toMatchObject(unavailable);
        expect(read.body).not.toHaveProperty("value");
        expect(await claim(f, "owner-a")).toMatchObject(unavailable);
        expect(await commit(f, put)).toMatchObject(unavailable);
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

function resealRoot(db: Database, edit: (root: Json) => Json) {
  const body = canonicalJson(edit(JSON.parse(rootOf(db).body) as Json));
  db.run("UPDATE cloud_v3_root SET body=?, seal=?", [body, digestBytes(body)]);
}

const set = (change: Json) => (root: Json) => ({ ...root, ...change });
const roster =
  (edit: (pages: Json[]) => Json[]) =>
  (root: Json): Json => ({ ...root, pages: edit(root.pages as Json[]) });

const rootFields: readonly [string, (root: Json) => Json, string?][] = [
  [
    "a format other than forge-cloud-root/3",
    set({ format: "forge-cloud-root/4" }),
  ],
  ["an unknown root key", set({ extra: 1 })],
  [
    "a snapshot page with a first key",
    roster(([d, s, t]) => [d!, { ...s, first: ["lease", "work-1"] }, t!]),
  ],
  [
    "a transcript page whose last sequence is not its count",
    roster(([d, s, t]) => [d!, s!, { ...t, last: 1 }]),
  ],
  [
    "a transcript page with no first sequence",
    roster(([d, s, t]) => [d!, s!, { ...t, first: null }]),
  ],
  ["a parent digest that is not a digest", set({ parentDigest: "sha256:abc" })],
  ["a transcript digest that is not a digest", set({ transcriptDigest: 7 })],
  ["a public digest that is not a digest", set({ publicDigest: "sha256:abc" })],
  ["a private digest that is not a digest", set({ privateDigest: 7 })],
  ["namespace watermarks that are null", set({ namespaceWatermarks: null })],
  ["an empty watermark name", set({ namespaceWatermarks: { "": 1 } })],
  [
    "a namespace watermark below zero",
    set({ namespaceWatermarks: { issue: -1 } }),
  ],
  ["a receipt cutoff that is not a count", set({ receiptCutoff: 1.5 })],
  [
    "active days that are not a count",
    set({ activeDays: 1.5, lastActiveDay: "2026-11-20" }),
  ],
  [
    "a last active day with no active days",
    set({ lastActiveDay: "2026-11-20" }),
  ],
  [
    "an impossible last active day",
    set({ activeDays: 1, lastActiveDay: "2026-13-45" }),
  ],
  ["a duplicate roster entry", roster(([d, ...rest]) => [d!, d!, ...rest])],
  ["roster entries out of order", roster(([d, s, t]) => [d!, t!, s!])],
  [
    "swapped page kinds",
    roster(([d, s, t]) => [
      { ...d, kind: "snapshot" },
      { ...s, kind: "directory" },
      t!,
    ]),
  ],
  [
    "a page hash that is not a digest",
    roster(([d, s, t]) => [d!, { ...s, hash: "sha256:abc" }, t!]),
  ],
  [
    "an interleaved roster",
    (root) => {
      const { body, ...late } = directory([], 1);
      const bytes = root.bytes as Json;
      return {
        ...roster(([d, s, t]) => [d!, s!, late, t!])(root),
        bytes: { ...bytes, directory: Number(bytes.directory) + bytesOf(body) },
      };
    },
    "INSERT INTO cloud_v3_pages VALUES ('directory:1', '[]')",
  ],
  [
    "an unknown page kind",
    roster(([d, s, t]) => [d!, { ...s, kind: "archive" }, t!]),
  ],
  [
    "a covered head that differs from the transcript count",
    set({ coveredHead: 1 }),
  ],
  [
    "per-kind counts that differ from the roster",
    (root) => ({
      ...root,
      counts: { ...(root.counts as Json), snapshot: 99 },
    }),
  ],
];

for (const [label, edit, sql] of rootFields) {
  test(
    `v3 recovery refuses a sealed root with ${label} and appends nothing`,
    async () => {
      const f = fixture();
      try {
        await snapshotWithClaim(f);
        expect((await f.send(probe)).status).toBe(200);
        resealRoot(f.db, edit);
        if (sql !== undefined) f.db.run(sql);
        f.restart();
        const before = f.snapshot();
        const read = await f.send(probe);
        expect(read).toMatchObject(unavailable);
        expect(read.body).not.toHaveProperty("value");
        expect(
          await commit(f, { operation: "fixture.put", time: T0, events: [] }),
        ).toMatchObject(unavailable);
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

test(
  "a sealed root with counted active days and a namespace watermark is served",
  async () => {
    const f = fixture();
    try {
      await snapshotWithClaim(f);
      const fields = {
        activeDays: 3,
        lastActiveDay: "2026-11-20",
        namespaceWatermarks: { issue: 4 },
        receiptCutoff: T0,
      };
      resealRoot(f.db, set(fields));
      f.restart();
      const read = await f.send(probe);
      expect(read).toMatchObject({ status: 200, body: { value: fields } });
      expect(image(read)).toMatchObject({ head: 2, eventWatermark: 2 });
    } finally {
      f.db.close();
    }
  },
  timeout,
);

const tails: readonly [string, string][] = [
  ["a gap in the tail", "DELETE FROM cloud_v3_commits WHERE sequence=2"],
  [
    "a tail frame with another commit format",
    "UPDATE cloud_v3_commits SET body=json_set(body,'$.format','forge-cloud-commit/2') WHERE sequence=2",
  ],
  [
    "a tail frame with the wrong sequence",
    "UPDATE cloud_v3_commits SET body=json_set(body,'$.sequence',5) WHERE sequence=2",
  ],
  [
    "a tail frame with an unknown key",
    "UPDATE cloud_v3_commits SET body=json_set(body,'$.zone',json('[]')) WHERE sequence=2",
  ],
  ...(
    [
      ["an empty operation", "$.operation", "''"],
      ["a negative time", "$.time", "-1"],
      ["events that are not a list", "$.events", "json('{}')"],
      ["an empty lease", "$.lease", "json('{}')"],
      ["a null lease", "$.lease", "json('null')"],
      ["a lease with a number subject", "$.lease.subject", "7"],
      ["an empty outcome", "$.outcome", "json('{}')"],
      ["an empty witness", "$.witness", "json('{}')"],
    ] as const
  ).map(([label, path, value]): [string, string] => [
    `a tail frame with ${label}`,
    `UPDATE cloud_v3_commits SET body=json_set(body,'${path}',${value}) WHERE sequence=2`,
  ]),
  [
    "a tail frame with a duplicate outcome key",
    `UPDATE cloud_v3_commits SET body=replace(body,'"outcome":','"outcome":{},"outcome":') WHERE sequence=2`,
  ],
  ...(
    [
      ["changes that are not a list", "{}"],
      ["a change with an empty key", '[{"key":"","value":1}]'],
      ["a change with neither value nor deletion", '[{"key":"a"}]'],
      [
        "a change with both value and deletion",
        '[{"deleted":true,"key":"a","value":1}]',
      ],
    ] as const
  ).map(([label, changes]): [string, string] => [
    `a tail frame with ${label}`,
    `UPDATE cloud_v3_commits SET body=replace(body,'{"events"','{"changes":${changes},"events"') WHERE sequence=2`,
  ]),
  [
    "a tail frame with a witness but no lease or outcome",
    "UPDATE cloud_v3_commits SET body=json_remove(body,'$.lease','$.outcome') WHERE sequence=2",
  ],
];

for (const [label, sql] of tails) {
  test(
    `v3 recovery on a genesis root refuses ${label}, and a claim runs that recovery before any write`,
    async () => {
      const f = fixture();
      try {
        expect((await f.send(probe, {})).status).toBe(200);
        expect(await commit(f, put)).toMatchObject({ status: 200 });
        expect(await claim(f, "owner-a")).toMatchObject({ status: 200 });
        expect(await commit(f, put)).toMatchObject({
          status: 200,
          body: { value: { head: 3 } },
        });
        expect(f.db.run(sql).changes).toBe(1);
        f.restart();
        const before = f.snapshot();
        const read = await f.send(probe);
        expect(read).toMatchObject(unavailable);
        expect(read.body).not.toHaveProperty("value");
        expect(await claim(f, "owner-a")).toMatchObject(unavailable);
        expect(await commit(f, put)).toMatchObject(unavailable);
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}
