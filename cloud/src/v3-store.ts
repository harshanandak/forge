import { transitionLaneControl } from "../../src/blocks/work/lane-control.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import {
  checkLeaseRecord,
  checkLeaseSubject,
  leaseExpiry,
} from "../../src/core/state/index.ts";
import type { ForgeError, LeaseRecord } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { expiredReplay, RETENTION_MS } from "./issue-receipts.ts";
import type { ReceiptScope } from "./issue-request-id.ts";
import {
  type LeaseCommand,
  leaseFingerprint,
  NAMESPACE,
  recordable,
  replayLease,
  requestConflict,
} from "./lease-command.ts";
import { checkTtl } from "./lease-ttl.ts";
import type { AdmitLeaseRequest } from "./project.ts";
import {
  authorityFault,
  isDigest,
  isNat,
  sealedAuthorityValid,
} from "./v3-authority.ts";
import type { roster as checkpointRoster } from "./v3-checkpoint.ts";
import { recordNumber, verifyRecordFrame } from "./v3-record-transitions.ts";
import { TABLE_PROBE } from "./store.ts";

export { withinDepth };
export const ROOT = "cloud_v3_root";
export const PAGES = "cloud_v3_pages";
export const PAGE_BYTES = 256 * 1024;
export const PAGE_SCHEMA =
  "(id TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID";
export const COMMITS = "cloud_v3_commits";
const COMMIT_FORMAT = "forge-cloud-commit/3";
const MiB = 1024 * 1024;
const MANIFEST_BYTES = 128 * 1024;
const ROSTER_PAGES = 640;
const DIRECTORY_PAGES = 32;
const DIRECTORY_BYTES = 4 * MiB;
export const TAIL_ROWS = 1024;
const TAIL_BYTES = 16 * MiB;
const MAX_JSON_DEPTH = 64;
const RESTORE_LEASES = 16;
const ROOT_FORMAT = "forge-cloud-root/3";
const KINDS = ["directory", "snapshot", "transcript"];
export const COLLECTIONS = ["lease", "outcome", "record", "witness"] as const;
const SYNTHETIC_KEYS = ["changes", "events", "operation", "time"];
const FRAME_KEYS =
  "changes,events,format,lease,operation,outcome,sequence,time,witness".split(
    ",",
  );
const empty = "[]";
const emptyBytes = Buffer.byteLength(empty);
const emptyDigest = digestBytes(empty);
const roster = ["directory", "transcript"].map((kind) => ({
  id: `${kind}:0`,
  kind,
  ordinal: 0,
  first: null,
  last: null,
  count: 0,
  bytes: emptyBytes,
  hash: emptyDigest,
}));
const pages = roster.map(({ id }) => ({ id, body: empty }));
const schema = {
  [ROOT]:
    "(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, seal TEXT NOT NULL)",
  [PAGES]: PAGE_SCHEMA,
  [COMMITS]:
    "(sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
};
const tables = Object.keys(schema);
const legacyTables =
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND (name GLOB 'state_*' OR name GLOB 'domain_cloud_*') LIMIT 1";

const hasTable = (db: SqlDatabase, name: string): boolean =>
  db.get(TABLE_PROBE, [name]) !== undefined;

export const hasV3Root = (db: SqlDatabase): boolean => hasTable(db, ROOT);

export const hasPriorV3RestoreState = (db: SqlDatabase): boolean =>
  db.get(legacyTables) !== undefined ||
  tables.some((table) => hasTable(db, table));

function genesis(incarnation: string, restoreEpoch: string) {
  return {
    format: ROOT_FORMAT,
    incarnation,
    restoreEpoch,
    generation: 0,
    parentDigest: null,
    coveredHead: 0,
    eventWatermark: 0,
    namespaceWatermarks: {},
    activeDays: 0,
    lastActiveDay: null,
    receiptCutoff: 0,
    counts: { directory: 0, transcript: 0 },
    bytes: { directory: emptyBytes, transcript: emptyBytes },
    transcriptDigest: emptyDigest,
    publicDigest: emptyDigest,
    privateDigest: emptyDigest,
    pages: roster,
  };
}

type Collection = (typeof COLLECTIONS)[number];
interface Page {
  readonly id: string;
  readonly kind: string;
  readonly first: unknown;
  readonly last: unknown;
  readonly count: number;
  readonly bytes: number;
  readonly hash: string;
}
interface Pointer {
  readonly page: string;
  readonly offset: number;
  readonly length: number;
  readonly digest: string;
}
type Slot = (
  { readonly value: unknown } | Pointer | { readonly deleted: true }
) & { readonly revision?: number };
interface Values {
  readonly lease: LeaseRecord;
  readonly outcome: {
    readonly time: number;
    readonly outcome: NonNullable<Frame["outcome"]>;
    readonly lease?: LeaseRecord;
  };
  readonly witness: {
    readonly witness: NonNullable<Frame["witness"]>;
    readonly lease: LeaseRecord;
  };
  readonly record: unknown;
}
export interface V3Image {
  readonly root: Readonly<Record<string, unknown>> & {
    readonly activationDigest?: string;
    readonly coveredHead: number;
    readonly pages: readonly Page[];
  };
  readonly entries: Readonly<Record<Collection, Map<string, Slot>>>;
  recordFloor: number;
  head: number;
  eventWatermark: number;
  tailBytes: number;
  stale: boolean;
  readonly staged: [sequence: number, body: string][];
}

export const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });
const unavailable = () => fail("UNAVAILABLE", "Cloud v3 root is unavailable");
const stopped = () => fail("INPUT_CONFLICT", "The restored project is stopped");
const nat = (value: unknown): number => {
  if (!isNat(value)) throw unavailable();
  return value;
};
function withinDepth(value: unknown, remaining = MAX_JSON_DEPTH): boolean {
  if (value === null || typeof value !== "object") return true;
  if (remaining === 0) return false;
  const children: readonly unknown[] = Array.isArray(value)
    ? value
    : Object.values(value);
  return children.every((child) => withinDepth(child, remaining - 1));
}

function readStored<T>(read: () => T): T {
  try {
    return read();
  } catch {
    throw unavailable();
  }
}

const parse = (text: string, depth = MAX_JSON_DEPTH): unknown =>
  readStored(() => {
    const value: unknown = JSON.parse(text);
    if (!withinDepth(value, depth)) throw unavailable();
    return value;
  });

const storedCanonical = (value: unknown) =>
  readStored(() => canonicalJson(value));

const utcDay = (value: unknown) => {
  const time =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? Date.parse(`${value}T00:00:00.000Z`)
      : Number.NaN;
  return (
    Number.isFinite(time) &&
    new Date(time).toISOString().startsWith(String(value))
  );
};

function sealedFields(root: Record<string, unknown>) {
  const { namespaceWatermarks: marks, activeDays, lastActiveDay } = root;
  return (
    root.format === ROOT_FORMAT &&
    [
      root.parentDigest,
      root.transcriptDigest,
      root.publicDigest,
      root.privateDigest,
    ].every(isDigest) &&
    isObject(marks) &&
    Object.entries(marks).every(([name, mark]) => name !== "" && isNat(mark)) &&
    isNat(root.receiptCutoff) &&
    isNat(activeDays) &&
    (activeDays === 0 ? lastActiveDay === null : utcDay(lastActiveDay))
  );
}

export function readV3Root(
  db: SqlDatabase,
): V3Image["root"] & { generation: number; eventWatermark: number } {
  if (!tables.every((table) => hasTable(db, table))) throw unavailable();
  const row = db.get(
    `SELECT body, seal FROM ${ROOT} WHERE id=1 AND length(CAST(body AS BLOB))<=${MANIFEST_BYTES}`,
  );
  if (typeof row?.body !== "string" || row.seal !== digestBytes(row.body))
    throw unavailable();
  const root = parse(row.body);
  if (
    !isObject(root) ||
    typeof root.incarnation !== "string" ||
    root.incarnation.length === 0 ||
    typeof root.restoreEpoch !== "string" ||
    root.restoreEpoch.length === 0 ||
    !Array.isArray(root.pages) ||
    root.pages.length > ROSTER_PAGES
  )
    throw unavailable();
  const base = genesis(root.incarnation, root.restoreEpoch);
  const counts: Record<string, number> = {};
  const bytes: Record<string, number> = {};
  let rank = 0;
  let next = 0;
  let sequence = 0;
  const listed = root.pages.map((page): Page & { ordinal: number } => {
    const kind =
      isObject(page) && typeof page.kind === "string"
        ? KINDS.indexOf(page.kind)
        : -1;
    if (!isObject(page) || kind < rank || !isDigest(page.hash))
      throw unavailable();
    if (kind > rank) [rank, next] = [kind, 0];
    const ordinal = nat(page.ordinal);
    if (ordinal !== next++) throw unavailable();
    const name = KINDS[kind]!;
    const count = nat(page.count);
    const ends =
      name === "transcript" && count > 0
        ? [sequence + 1, (sequence += count)]
        : [null, null];
    if (
      name !== "directory" &&
      (page.first !== ends[0] || page.last !== ends[1])
    )
      throw unavailable();
    counts[name] = (counts[name] ?? 0) + nat(page.count);
    bytes[name] = (bytes[name] ?? 0) + nat(page.bytes);
    return {
      id: `${name}:${ordinal}`,
      kind: name,
      ordinal,
      first: page.first,
      last: page.last,
      count: nat(page.count),
      bytes: nat(page.bytes),
      hash: page.hash,
    };
  });
  const [generation, coveredHead, eventWatermark] = [
    root.generation,
    root.coveredHead,
    root.eventWatermark,
  ].map(nat) as [number, number, number];
  const { activationDigest, ...ordinary } = root;
  if (
    activationDigest !== undefined &&
    (!isDigest(activationDigest) ||
      generation !== 1 ||
      root.parentDigest !== digestValue(base))
  )
    throw unavailable();
  const manifest = { ...root, counts, bytes, pages: listed };
  if (
    Object.keys(ordinary).length !== Object.keys(base).length ||
    !Object.keys(base).every((key) => Object.hasOwn(ordinary, key)) ||
    storedCanonical(manifest) !== row.body ||
    (generation === 0 && row.body !== storedCanonical(base)) ||
    (generation > 0 && !sealedFields(root)) ||
    coveredHead !== (counts.transcript ?? 0) ||
    listed.filter(({ kind }) => kind === "directory").length >
      DIRECTORY_PAGES ||
    (bytes.directory ?? 0) > DIRECTORY_BYTES
  )
    throw unavailable();
  return { ...manifest, generation, coveredHead, eventWatermark };
}

function directoryEntry(entry: unknown, byId: ReadonlyMap<string, Page>) {
  const collection = isObject(entry)
    ? COLLECTIONS.find((name) => name === entry.collection)
    : undefined;
  if (
    !isObject(entry) ||
    collection === undefined ||
    typeof entry.key !== "string" ||
    entry.key.length === 0
  )
    throw unavailable();
  const { key } = entry;
  const revision = collection === "record" ? nat(entry.revision) : undefined;
  if (revision !== undefined && (!revision || !recordNumber(key)))
    throw unavailable();
  const metadata = revision === undefined ? {} : { revision };
  if (collection === "record" && entry.deleted === true)
    return { collection, key, ...metadata, deleted: true as const };
  const target =
    typeof entry.page === "string" ? byId.get(entry.page) : undefined;
  const offset = nat(entry.offset);
  const length = nat(entry.length);
  if (
    target === undefined ||
    target.kind === "directory" ||
    length === 0 ||
    offset + length > target.bytes ||
    !isDigest(entry.digest)
  )
    throw unavailable();
  return {
    collection,
    key,
    ...metadata,
    page: target.id,
    offset,
    length,
    digest: entry.digest,
  };
}

interface Verification {
  admit: AdmitLeaseRequest;
  pages: ReadonlyMap<string, Buffer>;
  sealed: (image: V3Image) => void;
}

function recoveryImage(root: V3Image["root"], eventWatermark: number): V3Image {
  return {
    root,
    entries: {
      lease: new Map(),
      outcome: new Map(),
      record: new Map(),
      witness: new Map(),
    },
    recordFloor: 0,
    head: root.coveredHead,
    eventWatermark,
    tailBytes: 0,
    stale: false,
    staged: [],
  };
}

function activationFrame(root: V3Image["root"], time: number) {
  const { incarnation, restoreEpoch, coveredHead } = root;
  const now = new Date(time).toJSON();
  const stop = transitionLaneControl(
    { version: 1, incarnation, epoch: 0, resumeAllEpoch: 0, stopAll: null },
    undefined,
    { action: "stop", scope: { all: true } },
    { project: incarnation, policyIdentity: "restore.activate", now },
  );
  if (!stop.ok) throw unavailable();
  return canonicalJson({
    format: COMMIT_FORMAT,
    operation: "restore.activate",
    restoreEpoch,
    sequence: coveredHead + 1,
    time,
    control: stop.result.candidate.global,
    events: [{ type: "lane.stop", actor: "restore", scope: "all", at: now }],
  });
}

function applyActivation(db: SqlDatabase, image: V3Image) {
  const { root } = image;
  const [row, extra] = db.all(
    `SELECT sequence, CASE WHEN length(CAST(body AS BLOB))<=${PAGE_BYTES} THEN body END AS body FROM ${COMMITS} ORDER BY sequence LIMIT 2`,
  );
  if (
    extra ||
    row?.sequence !== image.head + 1 ||
    typeof row.body !== "string" ||
    digestBytes(row.body) !== root.activationDigest ||
    image.entries.lease.size > RESTORE_LEASES
  )
    throw unavailable();
  const frame = parse(row.body);
  const time = nat(isObject(frame) ? frame.time : undefined);
  if (activationFrame(root, time) !== row.body) throw unavailable();
  for (const subject of image.entries.lease.keys()) {
    const lease = readV3Value(db, image, "lease", subject);
    if (!lease) throw unavailable();
    if (lease.releasedAt === undefined)
      image.entries.lease.set(subject, {
        value: { ...lease, releasedAt: new Date(time).toISOString() },
      });
  }
  image.head++;
  image.eventWatermark++;
  image.tailBytes = Buffer.byteLength(row.body);
  return image;
}

export function recoverV3(
  db: SqlDatabase,
  verification: PortableVerification,
): V3Image;
export function recoverV3(
  db: SqlDatabase,
  verification?: Verification,
  options?: { through: number },
): V3Image;
export function recoverV3(
  db: SqlDatabase,
  verification?: Verification | PortableVerification,
  { through }: { through?: number } = {},
): V3Image {
  if (verification && "portableTranscript" in verification)
    return recoverPortableV3(db, verification);
  const root = readV3Root(db);
  const byId = new Map(root.pages.map((page) => [page.id, page]));
  const headers = db.all(
    `SELECT id, length(CAST(body AS BLOB)) AS bytes FROM ${PAGES} LIMIT ${ROSTER_PAGES + 1}`,
  );
  if (
    headers.length !== byId.size ||
    headers.some(({ id, bytes }) => byId.get(String(id))?.bytes !== bytes)
  )
    throw unavailable();
  const image = recoveryImage(root, root.eventWatermark);
  const bodies = new Map(
    db
      .all(
        `SELECT id, body FROM ${PAGES} WHERE id>='directory:' AND id<'directory;' LIMIT ${DIRECTORY_PAGES + 1}`,
      )
      .map(({ id, body }) => [id, body]),
  );
  let prior = ["", ""];
  for (const page of root.pages) {
    if (page.kind !== "directory") continue;
    const body = bodies.get(page.id);
    if (typeof body !== "string" || digestBytes(body) !== page.hash)
      throw unavailable();
    const list = parse(body);
    if (!Array.isArray(list)) throw unavailable();
    const entries = list.map((entry) => directoryEntry(entry, byId));
    const ends = [entries[0], entries.at(-1)].map((entry) =>
      entry === undefined ? null : [entry.collection, entry.key],
    );
    if (
      storedCanonical(entries) !== body ||
      entries.length !== page.count ||
      storedCanonical(ends) !== storedCanonical([page.first, page.last])
    )
      throw unavailable();
    for (const { collection, key, ...slot } of entries) {
      if (
        collection < prior[0]! ||
        (collection === prior[0] && key <= prior[1]!)
      )
        throw unavailable();
      prior = [collection, key];
      image.entries[collection].set(key, slot);
      if (collection === "record")
        image.recordFloor = Math.max(image.recordFloor, recordNumber(key));
    }
  }
  if (root.activationDigest !== undefined) {
    if (through !== undefined || verification) throw unavailable();
    return applyActivation(db, image);
  }
  verification?.sealed(image);
  const upper = through === undefined ? "" : " AND sequence<=?";
  const rows = db.all(
    `SELECT sequence, CASE WHEN sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence)<=${TAIL_BYTES} THEN body END AS body FROM (SELECT sequence, body FROM ${COMMITS} WHERE sequence>?${upper} ORDER BY sequence LIMIT ${TAIL_ROWS + 1}) ORDER BY sequence`,
    through === undefined ? [root.coveredHead] : [root.coveredHead, through],
  );
  if (rows.length > TAIL_ROWS) throw unavailable();
  const verify =
    verification &&
    ((frame: Frame) => verifyLeaseFrame(db, image, frame, verification));
  for (const { sequence, body } of rows) foldRow(image, sequence, body, verify);
  return image;
}

interface PortableVerification {
  admit: AdmitLeaseRequest;
  portableTranscript: string;
}

function recoverPortableV3(
  db: SqlDatabase,
  { admit, portableTranscript }: PortableVerification,
): V3Image {
  if (Buffer.byteLength(portableTranscript) > PAGE_BYTES) throw unavailable();
  const frames = parse(portableTranscript, MAX_JSON_DEPTH + 1);
  if (!Array.isArray(frames) || storedCanonical(frames) !== portableTranscript)
    throw unavailable();
  const image = recoveryImage(genesis("portable", "portable"), 0);
  const verification = { admit, pages: new Map<string, Buffer>() };
  const verify = (frame: Frame) =>
    verifyLeaseFrame(db, image, frame, verification);
  const marker = {
    format: COMMIT_FORMAT,
    operation: "fixture.note",
    time: 0,
    events: [],
  };
  for (const [index, raw] of frames.entries()) {
    const frame: unknown = raw;
    if (!isObject(frame) || frame.operation === marker.operation)
      throw unavailable();
    const body =
      Object.keys(frame).join() === "sequence"
        ? { ...marker, ...frame }
        : frame;
    foldRow(image, index + 1, storedCanonical(body), verify, true);
  }
  return image;
}

function foldRow(
  image: V3Image,
  sequence: unknown,
  body: unknown,
  verify?: (frame: Frame) => Frame,
  portable = false,
) {
  const frame = typeof body === "string" ? parse(body) : undefined;
  if (
    sequence !== image.head + 1 ||
    storedCanonical(frame) !== body ||
    !validShape(frame) ||
    authorityFault(frame, portable) !== undefined ||
    frame.format !== COMMIT_FORMAT ||
    frame.sequence !== sequence
  )
    throw unavailable();
  const { record } = image.entries;
  const read = (key: string) => record.get(key);
  const records = verifyRecordFrame(
    frame,
    image.recordFloor,
    read,
    unavailable,
  );
  apply(image, verify ? verify(frame) : frame, nat(sequence));
  image.recordFloor = records.floor;
  for (const { key, value } of records.changes) record.set(key, value);
  image.tailBytes += Buffer.byteLength(String(body));
}

export function publishV3(image: V3Image) {
  for (const [sequence, body] of image.staged) foldRow(image, sequence, body);
  image.staged.length = 0;
  image.stale = false;
}

export function provisionV3(db: SqlDatabase, legacyMarker: boolean) {
  return db.transaction(() => {
    if (legacyMarker || db.get(legacyTables))
      throw fail("INPUT_CONFLICT", "Cloud v3 requires a fresh project");
    if (!tables.some((table) => hasTable(db, table))) {
      for (const [table, definition] of Object.entries(schema))
        db.exec(`CREATE TABLE ${table} ${definition}`);
      for (const page of pages)
        db.run(`INSERT INTO ${PAGES} VALUES (?, ?)`, [page.id, page.body]);
      const body = canonicalJson(
        genesis(crypto.randomUUID(), crypto.randomUUID()),
      );
      db.run(`INSERT INTO ${ROOT} VALUES (1, ?, ?)`, [body, digestBytes(body)]);
    }
    return recoverV3(db);
  });
}

export function activateV3(
  db: SqlDatabase,
  imported: V3Image,
  projection: ReturnType<typeof checkpointRoster>,
  published: ReadonlyMap<string, string>,
  publicDigest: string,
) {
  if (imported.entries.lease.size > RESTORE_LEASES)
    throw fail("RESTORE_TOO_LARGE", "Too many imported leases for activation");
  const base = genesis(crypto.randomUUID(), crypto.randomUUID());
  const root = {
    ...base,
    ...projection,
    publicDigest,
    generation: 1,
    parentDigest: digestValue(base),
    coveredHead: imported.head,
    eventWatermark: imported.eventWatermark,
    transcriptDigest: digestBytes(published.get("transcript:0")!),
  };
  const activation = activationFrame(root, Date.now());
  const body = canonicalJson({
    ...root,
    activationDigest: digestBytes(activation),
  });
  for (const [table, definition] of Object.entries(schema))
    db.exec(`CREATE TABLE ${table} ${definition}`);
  for (const [id, page] of published)
    db.run(`INSERT INTO ${PAGES} VALUES (?, ?)`, [id, page]);
  db.run(`INSERT INTO ${ROOT} VALUES (1, ?, ?)`, [body, digestBytes(body)]);
  db.run(`INSERT INTO ${COMMITS} VALUES (?, ?)`, [
    imported.head + 1,
    activation,
  ]);
}

export const entryDigest = (digest: string | null, revision?: number) =>
  revision === undefined ? digest : digestValue([revision, digest]);

export function viewV3(image: V3Image) {
  const digest = (slot: Slot) =>
    "deleted" in slot
      ? entryDigest(null, slot.revision)
      : entryDigest(
          "value" in slot ? digestValue(slot.value) : slot.digest,
          slot.revision,
        );
  return {
    ...image.root,
    image: {
      head: image.head,
      eventWatermark: image.eventWatermark,
      ...Object.fromEntries(
        COLLECTIONS.map((name) => [
          name,
          Object.fromEntries(
            [...image.entries[name]].map(([key, slot]) => [key, digest(slot)]),
          ),
        ]),
      ),
    },
  };
}

export function readV3Value<C extends Collection>(
  db: SqlDatabase,
  image: V3Image,
  collection: C,
  key: string,
  pages?: ReadonlyMap<string, Buffer>,
): Values[C] | undefined {
  const slot = image.entries[collection].get(key);
  if (!slot || "deleted" in slot) return undefined;
  if ("value" in slot) return slot.value as Values[C];
  const bytes = pages
    ? pages.get(slot.page)?.subarray(slot.offset, slot.offset + slot.length)
    : db.get(
        `SELECT substr(CAST(body AS BLOB), ?, ?) AS value FROM ${PAGES} WHERE id=?`,
        [slot.offset + 1, slot.length, slot.page],
      )?.value;
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength !== slot.length ||
    digestBytes(bytes) !== slot.digest
  )
    throw unavailable();
  const text = readStored(() =>
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
  );
  const value = parse(text);
  if (
    storedCanonical(value) !== text ||
    (collection !== "record" && !sealedAuthorityValid(collection, key, value))
  )
    throw unavailable();
  return value as Values[C];
}

export function appendV3Frames(
  db: SqlDatabase,
  frames: unknown,
  image: () => V3Image,
) {
  if (!Array.isArray(frames) || frames.length === 0)
    throw fail("INPUT_INVALID", "Invalid v3 frame batch");
  const batch: readonly unknown[] = frames;
  if (
    batch.some(
      (frame) =>
        !isObject(frame) ||
        Object.keys(frame).some((key) => !SYNTHETIC_KEYS.includes(key)) ||
        !validAppendFrame(frame),
    )
  )
    throw fail("INPUT_INVALID", "Invalid v3 frame");
  return append(db, image(), batch);
}

function append(db: SqlDatabase, image: V3Image, batch: readonly unknown[]) {
  if (!batch.every(validAppendFrame))
    throw fail("INPUT_INVALID", "Invalid v3 frame");
  return db.transaction(() => {
    const { activationDigest, coveredHead } = readV3Root(db);
    if (activationDigest) throw stopped();
    const last = db.get(
      `SELECT sequence FROM ${COMMITS} ORDER BY sequence DESC LIMIT 1`,
    );
    const head = Math.max(coveredHead, Number(last?.sequence ?? 0));
    const bodies = batch.map((frame, i) =>
      canonicalJson({
        ...(frame as Frame),
        format: COMMIT_FORMAT,
        sequence: head + i + 1,
      }),
    );
    const bytes = bodies.reduce(
      (sum, body) => sum + Buffer.byteLength(body),
      image.tailBytes,
    );
    if (head !== image.head) {
      image.stale = true;
      throw unavailable();
    }
    if (head - coveredHead + batch.length > TAIL_ROWS || bytes > TAIL_BYTES)
      throw unavailable();
    const pending = new Map<string, Slot>();
    let floor = image.recordFloor;
    const read = (key: string) =>
      pending.get(key) ?? image.entries.record.get(key);
    const refuse = () => fail("INPUT_INVALID", "Invalid v3 record transition");
    for (const body of bodies) {
      const frame = JSON.parse(body) as Frame & Record<string, unknown>;
      const fault = authorityFault(frame);
      if (fault !== undefined)
        throw new Error(`Refusing a v3 frame with an invalid ${fault}`);
      const records = verifyRecordFrame(frame, floor, read, refuse);
      floor = records.floor;
      for (const { key, value } of records.changes) pending.set(key, value);
    }
    image.stale = true;
    for (const [i, body] of bodies.entries()) {
      db.run(`INSERT INTO ${COMMITS} VALUES (?, ?)`, [head + i + 1, body]);
      image.staged.push([head + i + 1, body]);
    }
    return { head: head + batch.length };
  });
}

export interface Frame {
  readonly operation: string;
  readonly time: number;
  readonly events: readonly unknown[];
  readonly changes?: readonly unknown[];
  readonly lease?: LeaseRecord;
  readonly outcome?: {
    readonly id: string;
    readonly scope: ReceiptScope & { readonly family: "lease" };
    readonly fingerprint: string;
    readonly status: string;
    readonly result?: ForgeError;
    readonly resultDigest?: string;
    readonly retryUntil: number;
  };
  readonly witness?: {
    readonly namespace: string;
    readonly id: string;
    readonly subject: string;
    readonly generation: number;
    readonly digest: string;
  };
}

const validChange = (change: unknown) =>
  isObject(change) &&
  typeof change.key === "string" &&
  change.key.length > 0 &&
  Object.keys(change).sort().join() === "key,value";

function validShape(frame: unknown): frame is Frame & Record<string, unknown> {
  return (
    isObject(frame) &&
    Object.keys(frame).every((key) => FRAME_KEYS.includes(key)) &&
    typeof frame.operation === "string" &&
    frame.operation.length > 0 &&
    typeof frame.time === "number" &&
    Number.isSafeInteger(frame.time) &&
    frame.time >= 0 &&
    Array.isArray(frame.events) &&
    (frame.changes === undefined ||
      (Array.isArray(frame.changes) && frame.changes.every(validChange)))
  );
}

const validAppendFrame = (frame: unknown) =>
  validShape(frame) && withinDepth(frame);

function apply(image: V3Image, frame: Frame, sequence: number) {
  const { time, lease, outcome, witness } = frame;
  if (lease) image.entries.lease.set(lease.subject, { value: lease });
  if (outcome)
    image.entries.outcome.set(outcome.id, {
      value: { time, outcome, ...(lease && { lease }) },
    });
  if (witness)
    image.entries.witness.set(witness.id, { value: { witness, lease } });
  image.head = sequence;
  image.eventWatermark += frame.events.length;
}

function transition(
  { route, subject, holder, ttlMs, generation }: LeaseCommand,
  current: LeaseRecord | undefined,
  now: number,
): LeaseRecord {
  const decision = decideLease(current, {
    mode: route === "claim" ? "acquire" : "held",
    subject,
    holder,
    generation: generation ?? 0,
    nowMs: now,
  });
  if (!decision.ok) throw new ForgeFailure(decision.error);
  const expiresAt = () => leaseExpiry(now, Number(ttlMs));
  if (route === "claim")
    return {
      subject,
      holder,
      generation: decision.generation,
      expiresAt: expiresAt(),
    };
  return route === "renew"
    ? { ...current!, holder, expiresAt: expiresAt() }
    : { ...current!, holder, releasedAt: new Date(now).toISOString() };
}

function admitLease(
  command: LeaseCommand,
  expiresAt: number,
  now: number,
  read: () => LeaseRecord | undefined,
) {
  const { route, subject, ttlMs } = command;
  if (route !== "release") checkTtl(ttlMs, expiresAt, now);
  const current = read();
  checkLeaseSubject(subject, route === "claim" ? "acquire" : "held", current);
  return current;
}

function compactLeaseJson(input: object): string {
  const tokens = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g;
  return JSON.stringify(input).replace(tokens, (token) => {
    if (token.startsWith('"')) return token;
    const scientific = Number(token).toExponential().replace("+", "");
    const [mantissa = "", power] = scientific.split("e");
    const decimals = mantissa.split(".")[1]?.length ?? 0;
    const integer = `${mantissa.replace(".", "")}e${Number(power) - decimals}`;
    return [token, scientific, integer].sort((a, b) => a.length - b.length)[0]!;
  });
}

function verifyLeaseFrame(
  db: SqlDatabase,
  image: V3Image,
  frame: Frame,
  { pages, admit }: Pick<Verification, "pages" | "admit">,
): Frame {
  const { outcome, time } = frame;
  if (!outcome) return frame;
  const input = parse(outcome.fingerprint);
  if (
    frame.events.length !== 0 ||
    frame.changes !== undefined ||
    !isObject(input) ||
    !/^l2:[a-f0-9]{64}$/.test(outcome.id)
  )
    throw unavailable();
  const holder = isObject(input.holder) ? input.holder : {};
  const { device, ...session } = isObject(holder.session) ? holder.session : {};
  let command: LeaseCommand;
  try {
    command = admit(
      String(input.route) as LeaseCommand["route"],
      compactLeaseJson({
        requestId: "a",
        subject: input.subject,
        holder: { ...holder, session },
        ttlMs: input.ttlMs ?? undefined,
        generation: input.generation ?? undefined,
      }),
      device,
      null,
      undefined,
      outcome.retryUntil,
      time,
    );
  } catch {
    throw unavailable();
  }
  if (
    leaseFingerprint(command) !== outcome.fingerprint ||
    (readV3Value(db, image, "outcome", outcome.id, pages)?.outcome.retryUntil ??
      0) > time
  )
    throw unavailable();
  let lease: LeaseRecord;
  try {
    const current = admitLease(command, outcome.retryUntil, time, () =>
      readV3Value(db, image, "lease", command.subject, pages),
    );
    if (command.route === "claim" && image.entries.witness.has(outcome.id))
      throw unavailable();
    lease = transition(command, current, time);
    checkLeaseRecord(lease);
  } catch (error) {
    const { resultDigest, ...receipt } = outcome;
    if (
      !recordable(error) ||
      outcome.status !== error.error.code ||
      (resultDigest === undefined
        ? storedCanonical(outcome.result) !== storedCanonical(error.error)
        : resultDigest !== digestValue(error.error))
    )
      throw unavailable();
    return { ...frame, outcome: { ...receipt, result: error.error } };
  }
  if (
    outcome.status !== "ok" ||
    storedCanonical(frame.lease) !== storedCanonical(lease)
  )
    throw unavailable();
  return { ...frame, lease };
}

export function leaseV3(
  db: SqlDatabase,
  image: V3Image,
  command: LeaseCommand,
  expiresAt: number,
  now = Date.now(),
): LeaseRecord {
  const { route, subject, holder, requestId } = command;
  const result = db.transaction(
    (): { lease: LeaseRecord } | { refusal: ForgeFailure } => {
      const fingerprint = leaseFingerprint(command);
      const read = () => readV3Value(db, image, "lease", subject);
      const prior =
        image.root.activationDigest === undefined
          ? readV3Value(db, image, "outcome", requestId)
          : undefined;
      if (prior !== undefined && prior.outcome.retryUntil > now) {
        if (now >= prior.time + RETENTION_MS)
          expiredReplay(prior.outcome.status !== "ok");
        if (prior.outcome.fingerprint !== fingerprint) throw requestConflict();
        return {
          lease: replayLease(
            command,
            prior.outcome.status,
            prior.outcome.result ?? prior.lease,
            read,
            now,
          ),
        };
      }
      const frame = { operation: `lease.${route}`, time: now, events: [] };
      const outcome = {
        id: requestId,
        scope: { family: "lease", ...command.scope },
        fingerprint,
        retryUntil: expiresAt,
      };
      const refuse = (error: unknown) => {
        if (!recordable(error)) throw error;
        const status = error.error.code;
        const refused = { ...outcome, status, result: error.error };
        append(db, image, [{ ...frame, outcome: refused }]);
        return { refusal: error };
      };
      let current: LeaseRecord | undefined;
      try {
        current = admitLease(command, expiresAt, now, read);
      } catch (error) {
        return refuse(error);
      }
      const witnessed =
        route === "claim"
          ? readV3Value(db, image, "witness", requestId)
          : undefined;
      if (witnessed !== undefined) {
        const held = decideLease(current, {
          mode: "held",
          subject,
          holder,
          generation: witnessed.witness.generation,
          nowMs: now,
        });
        if (!held.ok) throw new ForgeFailure(held.error);
        if (witnessed.witness.digest !== digestBytes(fingerprint))
          throw requestConflict();
        return { lease: witnessed.lease };
      }
      if (image.root.activationDigest) throw stopped();
      let lease: LeaseRecord;
      try {
        lease = transition(command, current, now);
        checkLeaseRecord(lease);
      } catch (error) {
        return refuse(error);
      }
      append(db, image, [
        {
          ...frame,
          lease,
          outcome: { ...outcome, status: "ok" },
          ...(route === "claim" && {
            witness: {
              namespace: NAMESPACE,
              id: requestId,
              subject,
              generation: lease.generation,
              digest: digestBytes(fingerprint),
            },
          }),
        },
      ]);
      return { lease };
    },
  );
  publishV3(image);
  if ("refusal" in result) throw result.refusal;
  return result.lease;
}
