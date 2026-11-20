import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { GENESIS_LEASE_ONLY } from "../../cloud/src/v3-store.ts";
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
const E1 = T0 + 2 * 3_600_000;
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
const claim = (f: Fixture, owner: string) =>
  f.send(
    `${probe}/claim`,
    { subject: "work-1", requestId: "acq-1", holder, ttlMs: 3_600_000 },
    { "X-Forge-Owner": owner, "X-Forge-Owner-Expires": String(E1) },
  );
const commit = (f: Fixture, ...frames: Json[]) =>
  f.send(`${probe}/commits`, { frames });
const image = (response: { body: unknown }) =>
  (response.body as { value?: { image?: Json } }).value?.image;
const unavailable = {
  status: 503,
  body: { ok: false, error: { code: "UNAVAILABLE" } },
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
    page("transcript", 0, "[]", coveredHead),
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
  seal(f.db, [...items.values()], frames.length, events);
  f.restart();
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
  checkpoint(f);
}

test(
  "lease commands on a checkpointed root are refused before any write while they still scan commits",
  async () => {
    const f = fixture();
    try {
      await snapshotWithClaim(f);
      const held = image(await f.send(probe))!;
      expect(Object.keys(held.lease as Json)).toEqual(["work-1"]);
      const before = f.snapshot();
      const lease = (route: string, owner: string, body: Json) =>
        f.send(
          `${probe}/${route}`,
          { subject: "work-1", holder, ...body },
          { "X-Forge-Owner": owner, "X-Forge-Owner-Expires": String(E1) },
        );
      const responses = [
        await lease("claim", "owner-b", {
          requestId: "acq-2",
          ttlMs: 3_600_000,
        }),
        await lease("renew", "owner-a", {
          requestId: "ren-1",
          generation: 1,
          ttlMs: 3_600_000,
        }),
        await lease("release", "owner-a", {
          requestId: "rel-1",
          generation: 1,
        }),
      ];
      for (const response of responses)
        expect(response).toMatchObject({
          ...unavailable,
          body: { error: { message: GENESIS_LEASE_ONLY } },
        });
      expect(f.snapshot()).toEqual(before);
      expect(image(await f.send(probe))).toEqual(held);
    } finally {
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
        expect(f.snapshot()).toEqual(before);
      } finally {
        f.db.close();
      }
    },
    timeout,
  );
}

function resealRoot(db: Database, change: Json) {
  const body = canonicalJson({
    ...(JSON.parse(rootOf(db).body) as Json),
    ...change,
  });
  db.run("UPDATE cloud_v3_root SET body=?, seal=?", [body, digestBytes(body)]);
}

const rootFields: readonly [string, Json][] = [
  ["a format other than forge-cloud-root/3", { format: "forge-cloud-root/4" }],
  ["an unknown root key", { extra: 1 }],
  ["a parent digest that is not a digest", { parentDigest: "sha256:abc" }],
  ["a transcript digest that is not a digest", { transcriptDigest: 7 }],
  ["a namespace watermark below zero", { namespaceWatermarks: { issue: -1 } }],
  ["a receipt cutoff that is not a count", { receiptCutoff: 1.5 }],
  ["a last active day with no active days", { lastActiveDay: "2026-11-20" }],
  [
    "an impossible last active day",
    { activeDays: 1, lastActiveDay: "2026-13-45" },
  ],
];

for (const [label, change] of rootFields) {
  test(
    `v3 recovery refuses a sealed root with ${label} and appends nothing`,
    async () => {
      const f = fixture();
      try {
        await snapshotWithClaim(f);
        expect((await f.send(probe)).status).toBe(200);
        resealRoot(f.db, change);
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
      resealRoot(f.db, fields);
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
