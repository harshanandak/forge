import {
  type LaneControlGlobal,
  type LaneControlIssue,
  readLaneControl,
  transitionLaneControl,
} from "../../src/blocks/work/lane-control.ts";
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
import type { LeaseRecord } from "../../src/generated/types.ts";
import * as validators from "../../src/generated/validators.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { checkedValue, configured, holds, shownId } from "./issue-read.ts";
import { expiredReplay, RETENTION_MS } from "./issue-receipts.ts";
import {
  type ReceiptScope,
  receiptScope,
  scopeRequestId,
} from "./issue-request-id.ts";
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
  keysOf,
  promoteOutcome,
  sealedAuthorityValid,
} from "./v3-authority.ts";
import type { roster as checkpointRoster } from "./v3-checkpoint.ts";
import {
  recordNumber,
  resultMatches,
  verifyRecordFrame,
} from "./v3-record-transitions.ts";
import { recordAlias, refusalOf } from "./v3-refusals.ts";
import { TABLE_PROBE } from "./store.ts";
import {
  BOUNDED_MAC,
  bounded,
  isVerifiedManifest,
  type Seal,
  signRoot,
  signRow,
  type TokenFields,
  verifyRoot,
  verifyRow,
  type VerifiedManifest,
} from "./v3-seal.ts";

export { unavailable, withinDepth };
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
const RAW_TAIL_BYTES = MiB;
const MAX_JSON_DEPTH = 64;
const RESTORE_LEASES = 16;
const ACTIVATION_BYTES = 2048;
const ROOT_FORMAT = "forge-cloud-root/4";
const KINDS = ["directory", "snapshot", "transcript"];
export const COLLECTIONS = [
  "control",
  "lease",
  "outcome",
  "record",
  "witness",
] as const;
const SYNTHETIC_KEYS = ["changes", "events", "operation", "time"];
const FRAME_KEYS =
  "basis,changes,events,format,lease,operation,outcome,sequence,time,witness".split(
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
    "(sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL, mac TEXT NOT NULL)",
};
const tables = Object.keys(schema);
const oldCommits = `SELECT 1 FROM (SELECT count(*) AS n, sum(name='mac') AS m FROM pragma_table_info('${COMMITS}')) WHERE n>0 AND m=0`;
const legacyTables =
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND (name GLOB 'state_*' OR name GLOB 'domain_cloud_*') LIMIT 1";

const hasTable = (db: SqlDatabase, name: string): boolean =>
  db.get(TABLE_PROBE, [name]) !== undefined;

export const hasV3Root = (db: SqlDatabase): boolean => hasTable(db, ROOT);

export const V3_TOKENS = "cloud_v3_tokens";
export const V3_APPROVALS = "cloud_v3_approvals";
export const V3_APPROVAL_BROWSER = "cloud_v3_approval_browser";
const priorV3Tables = [...tables, V3_TOKENS, V3_APPROVALS, V3_APPROVAL_BROWSER];

export const hasPriorV3RestoreState = (db: SqlDatabase): boolean =>
  db.get(legacyTables) !== undefined ||
  priorV3Tables.some((table) => hasTable(db, table));

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

function generationTwoProof(root: V3Image["root"], activationDigest: string) {
  const base = genesis(root.incarnation as string, root.restoreEpoch as string);
  const parent = {
    ...root,
    generation: 1,
    parentDigest: digestValue(base),
    activationDigest,
  };
  return digestValue(parent) === root.parentDigest;
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
type Usage = { transcript: number; snapshot: number; directory: number };
type Measure = Usage & { rows: number; raw: number; leases: number };
type LeaseBudget = { lease: LeaseRecord; cost: Measure };
type SlotWrite = [collection: Collection, key: string, slot: Slot | undefined];

interface Values {
  readonly control: LaneControlGlobal | LaneControlIssue;
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
    readonly bytes: Readonly<Record<string, number>>;
    readonly coveredHead: number;
    readonly pages: readonly Page[];
  };
  readonly entries: Readonly<Record<Collection, Map<string, Slot>>>;
  aliases?: Map<string, number>;
  aliasByKey?: Map<string, string>;
  readonly usage: Usage;
  fold?: {
    context: "portable" | "rooted";
    segmentIncarnation?: string;
    segmentEpoch?: string;
    incarnations: Set<string>;
    restoreEpochs: Set<string>;
    approvalIds: Set<string>;
    pending?: { sequence: number; time: number; digest: string };
  };
  recordFloor: number;
  head: number;
  eventWatermark: number;
  tailBytes: number;
  stale: boolean;
  readonly staged: [sequence: number, body: string][];
  readonly load: (collection: "record" | "lease", key: string) => unknown;
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

export function rejectOldCommits(db: SqlDatabase): void {
  if (db.get(oldCommits)) throw unavailable();
}

type StoredRoot = V3Image["root"] & {
  generation: number;
  eventWatermark: number;
};

export const readV3Root = (db: SqlDatabase, seal: Seal): StoredRoot =>
  readSealedRoot(db, seal).root;

export function readSealedRoot(
  db: SqlDatabase,
  seal: Seal,
): { root: StoredRoot; envelope: string } {
  if (!tables.every((table) => hasTable(db, table))) throw unavailable();
  rejectOldCommits(db);
  const row = db.get(
    `SELECT body, ${bounded("seal")} FROM ${ROOT} WHERE id=1 AND length(CAST(body AS BLOB))<=${MANIFEST_BYTES}`,
  );
  if (
    typeof row?.body !== "string" ||
    typeof row.seal !== "string" ||
    !verifyRoot(seal, row.body, row.seal)
  )
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
  return {
    root: { ...manifest, generation, coveredHead, eventWatermark },
    envelope: row.seal,
  };
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

export type Discovery = { current: boolean };

interface Verification {
  admit: AdmitLeaseRequest;
  pages?: ReadonlyMap<string, Buffer>;
  sealed: (image: V3Image, discovery: Discovery) => void;
}

function recoveryImage(
  db: SqlDatabase,
  root: V3Image["root"],
  eventWatermark: number,
  pages?: Verification["pages"],
): V3Image {
  const image: V3Image = {
    root,
    entries: {
      control: new Map(),
      lease: new Map(),
      outcome: new Map(),
      record: new Map(),
      witness: new Map(),
    },
    usage: {
      transcript: root.bytes.transcript ?? emptyBytes,
      snapshot: 0,
      directory: emptyBytes,
    },
    fold: {
      context: "portable",
      incarnations: new Set(),
      restoreEpochs: new Set(),
      approvalIds: new Set(),
    },
    recordFloor: 0,
    head: root.coveredHead,
    eventWatermark,
    tailBytes: 0,
    stale: false,
    staged: [],
    load: (collection, key) => readV3Value(db, image, collection, key, pages),
  };
  return image;
}

function activationBytes(
  incarnation: string,
  restoreEpoch: string,
  coveredHead: number,
  time: number,
) {
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

function applyActivation(db: SqlDatabase, seal: Seal, image: V3Image) {
  const { root } = image;
  const [row, extra] = db.all(
    `SELECT sequence, ${BOUNDED_MAC}, CASE WHEN length(CAST(body AS BLOB))<=${PAGE_BYTES} THEN body END AS body FROM ${COMMITS} ORDER BY sequence LIMIT 2`,
  );
  if (
    extra ||
    row?.sequence !== image.head + 1 ||
    typeof row.body !== "string" ||
    digestBytes(row.body) !== root.activationDigest ||
    !verifyRow(seal, root.incarnation, row.sequence, row.body, row.mac)
  )
    throw unavailable();
  const identity = foldActivation(db, image, row.body);
  image.tailBytes = Buffer.byteLength(row.body);
  return identity;
}

function foldActivation(db: SqlDatabase, image: V3Image, body: string) {
  if (Buffer.byteLength(body) > ACTIVATION_BYTES) throw unavailable();
  const frame = parse(body);
  if (!isObject(frame) || !isObject(frame.control)) throw unavailable();
  const { control, events, operation, restoreEpoch } = frame;
  const { incarnation } = control;
  const sequence = nat(frame.sequence);
  const time = nat(frame.time);
  const fold = image.fold!;
  if (
    frame.format !== COMMIT_FORMAT ||
    operation !== "restore.activate" ||
    sequence === 0 ||
    sequence !== image.head + 1 ||
    typeof incarnation !== "string" ||
    typeof restoreEpoch !== "string" ||
    !readLaneControl({ ...control, incarnation: restoreEpoch }, undefined).ok ||
    !Array.isArray(events) ||
    activationBytes(incarnation, restoreEpoch, sequence - 1, time) !== body ||
    !sealedAuthorityValid("control", "global", control) ||
    image.entries.lease.size > RESTORE_LEASES ||
    fold.incarnations.has(incarnation) ||
    fold.restoreEpochs.has(restoreEpoch)
  )
    throw unavailable();
  const leases = [...image.entries.lease.keys()].map((subject) => {
    const lease = readV3Value(db, image, "lease", subject);
    if (!lease) throw unavailable();
    return [subject, lease] as const;
  });
  const writes: SlotWrite[] = [];
  for (const [subject, lease] of leases) {
    if (lease.releasedAt === undefined)
      writes.push([
        "lease",
        subject,
        {
          value: { ...lease, releasedAt: new Date(time).toISOString() },
        },
      ]);
  }
  for (const key of image.entries.control.keys())
    if (key !== "global") writes.push(["control", key, undefined]);
  writes.push(["control", "global", { value: control }]);
  countFrame(image.usage, body, writes, (collection, key) =>
    image.entries[collection].get(key),
  );
  fold.incarnations.add(incarnation);
  fold.restoreEpochs.add(restoreEpoch);
  fold.segmentIncarnation = incarnation;
  fold.segmentEpoch = restoreEpoch;
  fold.pending = { sequence, time, digest: digestBytes(body) };
  apply(image, { events }, sequence, writes);
  return { incarnation, restoreEpoch };
}

function restoreTime(value: unknown): value is number {
  return isNat(value) && /^\d{4}-/.test(new Date(value).toJSON() ?? "");
}

function foldPromote(
  image: V3Image,
  body: string,
  frame: Record<string, unknown>,
  mode: FoldMode,
) {
  const fold = image.fold!;
  const { pending } = fold;
  const { activationDigest, approval, operation, sequence, time } = frame;
  if (
    !pending ||
    sequence !== pending.sequence + 1 ||
    Buffer.byteLength(body) > 4096 ||
    keysOf(frame) !==
      "activationDigest,approval,events,format,operation,outcome,sequence,time" ||
    activationDigest !== pending.digest ||
    !restoreTime(time) ||
    !isObject(approval) ||
    keysOf(approval) !== "approvedAt,approver,expiresAt,id,operationDigest"
  )
    throw unavailable();
  const { id, operationDigest, approver, approvedAt, expiresAt } = approval;
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      id,
    ) ||
    operationDigest !== digestValue([operation, activationDigest]) ||
    !isDigest(approver) ||
    !restoreTime(approvedAt) ||
    !restoreTime(expiresAt) ||
    approvedAt < pending.time ||
    approvedAt > time ||
    time >= expiresAt ||
    expiresAt - approvedAt > 600_000 ||
    fold.approvalIds.has(id)
  )
    throw unavailable();
  const events = [
    { type: operation, actor: "owner", at: new Date(time).toISOString() },
  ];
  const archived = mode !== "live";
  const outcome = promoteOutcome(frame.outcome, time, sequence, archived);
  if (
    !outcome ||
    image.entries.outcome.has(outcome.id) ||
    storedCanonical(frame.events) !== canonicalJson(events)
  )
    throw unavailable();
  const writes: SlotWrite[] = [
    ["outcome", outcome.id, { value: { outcome, time } }],
  ];
  const transcript = archived ? body : canonicalJson(archive(body));
  countFrame(image.usage, transcript, writes, () => undefined);
  fold.approvalIds.add(id);
  delete fold.pending;
  apply(image, { events }, sequence, writes);
}

export function recoverV3(
  db: SqlDatabase,
  seal: Seal,
  verification: PortableVerification,
): V3Image;
export function recoverV3(
  db: SqlDatabase,
  seal: Seal,
  verification: Verification & { readonly portableTranscript?: never },
  options?: { through: number },
): V3Image;
export function recoverV3(
  db: SqlDatabase,
  seal: Seal,
  verification: Verification | PortableVerification,
  { through }: { through?: number } = {},
): V3Image {
  if ("portableTranscript" in verification)
    return recoverPortableV3(db, verification);
  const root = readV3Root(db, seal);
  const byId = new Map(root.pages.map((page) => [page.id, page]));
  const headers = db.all(
    `SELECT id, length(CAST(body AS BLOB)) AS bytes FROM ${PAGES} LIMIT ${ROSTER_PAGES + 1}`,
  );
  if (
    headers.length !== byId.size ||
    headers.some(({ id, bytes }) => byId.get(String(id))?.bytes !== bytes)
  )
    throw unavailable();
  const image = recoveryImage(
    db,
    root,
    root.eventWatermark,
    verification.pages,
  );
  image.fold!.context = "rooted";
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
      countSlot(image.usage, collection, key, slot, 1);
      if (collection === "record")
        image.recordFloor = Math.max(image.recordFloor, recordNumber(key));
    }
  }
  if (root.activationDigest !== undefined) {
    if (through !== undefined) throw unavailable();
    verification.sealed(image, { current: true });
    const { incarnation, restoreEpoch } = applyActivation(db, seal, image);
    if (incarnation !== root.incarnation || restoreEpoch !== root.restoreEpoch)
      throw unavailable();
    return image;
  }
  const upper = through === undefined ? "" : " AND sequence<=?";
  const rows = db.all(
    `SELECT sequence, ${BOUNDED_MAC}, CASE WHEN sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence)<=${TAIL_BYTES} THEN body END AS body FROM (SELECT sequence, body, mac FROM ${COMMITS} WHERE sequence>?${upper} ORDER BY sequence LIMIT ${TAIL_ROWS + 1}) ORDER BY sequence`,
    through === undefined ? [root.coveredHead] : [root.coveredHead, through],
  );
  if (rows.length > TAIL_ROWS) throw unavailable();
  for (const { sequence, body, mac } of rows)
    if (!verifyRow(seal, root.incarnation, sequence, body, mac))
      throw unavailable();
  const first =
    root.generation === 2 && rows[0] ? parse(String(rows[0].body)) : undefined;
  verification.sealed(image, {
    current: isObject(first) && first.operation === "restore.activate",
  });
  const verify = (row: Frame) => verifyLeaseFrame(db, image, row, verification);
  for (const { sequence, body } of rows)
    foldRow(image, sequence, body, verify, db);
  const { pending, segmentIncarnation, segmentEpoch } = image.fold!;
  if (
    pending ||
    (segmentEpoch !== undefined &&
      (segmentIncarnation !== root.incarnation ||
        segmentEpoch !== root.restoreEpoch))
  )
    throw unavailable();
  return image;
}

interface PortableVerification {
  admit: AdmitLeaseRequest;
  manifest: VerifiedManifest;
  portableTranscript: string;
}

function recoverPortableV3(
  db: SqlDatabase,
  { admit, manifest, portableTranscript }: PortableVerification,
): V3Image {
  const bytes = Buffer.byteLength(portableTranscript);
  if (
    bytes > PAGE_BYTES ||
    !isVerifiedManifest(manifest) ||
    bytes !== manifest.transcript.bytes ||
    digestBytes(portableTranscript) !== manifest.transcript.hash
  )
    throw unavailable();
  const frames = parse(portableTranscript, MAX_JSON_DEPTH + 1);
  if (!Array.isArray(frames) || storedCanonical(frames) !== portableTranscript)
    throw unavailable();
  return foldTranscript(db, frames, "portable", admit);
}

type FoldMode = "live" | "archived" | "portable";

export function foldTranscript(
  db: SqlDatabase,
  frames: readonly unknown[],
  mode: Exclude<FoldMode, "live">,
  admit: AdmitLeaseRequest,
  context?: { root: V3Image["root"]; boundary?: number },
): V3Image {
  const image = recoveryImage(db, genesis("portable", "portable"), 0);
  const fold = image.fold!;
  const boundary = context?.boundary ?? 0;
  if (context) {
    fold.context = "rooted";
    if (!boundary) {
      fold.segmentIncarnation = context.root.incarnation as string;
      fold.incarnations.add(fold.segmentIncarnation);
    }
  }
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
    const rowMode = index + 1 < boundary ? "portable" : mode;
    const portable = rowMode === "portable";
    if (!isObject(frame) || (portable && frame.operation === marker.operation))
      throw unavailable();
    const body =
      portable && Object.keys(frame).join() === "sequence"
        ? { ...marker, ...frame }
        : frame;
    const text = storedCanonical(body);
    foldRow(image, index + 1, text, verify, db, rowMode);
  }
  if (fold.pending) throw unavailable();
  return image;
}

function foldRow(
  image: V3Image,
  sequence: unknown,
  body: unknown,
  verify?: (frame: Frame) => Frame,
  db?: SqlDatabase,
  mode: FoldMode = "live",
) {
  const frame = typeof body === "string" ? parse(body) : undefined;
  if (
    sequence !== image.head + 1 ||
    typeof body !== "string" ||
    !isObject(frame) ||
    storedCanonical(frame) !== body ||
    frame.format !== COMMIT_FORMAT ||
    frame.sequence !== sequence
  )
    throw unavailable();
  if (image.fold?.pending || restoreFrame(frame)) {
    const { root } = image;
    if (!db) throw unavailable();
    if (frame.operation === "restore.promote")
      foldPromote(image, body, frame, mode);
    else if (
      !image.fold?.pending &&
      frame.operation === "restore.activate" &&
      (mode !== "live" ||
        (root.generation === 2 &&
          sequence === root.coveredHead + 1 &&
          generationTwoProof(root, digestBytes(body))))
    )
      foldActivation(db, image, body);
    else throw unavailable();
    image.tailBytes += Buffer.byteLength(body);
    return;
  }
  if (
    !validShape(frame) ||
    authorityFault(frame, mode !== "live") !== undefined
  )
    throw unavailable();
  const { record } = image.entries;
  const read = (key: string) => record.get(key);
  const records = verifyRecordFrame(
    frame,
    image.recordFloor,
    read,
    unavailable,
    image.load,
  );
  let done: Frame = verify ? verify(frame) : frame;
  if (frame.basis !== undefined) {
    const error = refusalOf(image, frame, claimEffect);
    if (error === undefined) throw unavailable();
    const { resultDigest: _digest, ...receipt } = frame.outcome!;
    done = { ...done, outcome: { ...receipt, result: error } };
  }
  if (
    records.result !== undefined &&
    done.outcome?.resultDigest !== undefined
  ) {
    const { resultDigest: _digest, ...receipt } = done.outcome;
    done = { ...done, outcome: { ...receipt, result: records.result } };
  }
  const canonical =
    done === frame ? done : (parse(storedCanonical(done)) as Frame);
  const writes = ordinaryWrites(canonical, records.changes);
  let archived = String(body);
  if (mode === "live") archived = canonicalJson(archive(archived));
  else if (mode === "portable" && frame.operation === "fixture.note")
    archived = canonicalJson({ sequence });
  countFrame(image.usage, archived, writes, (collection, key) =>
    image.entries[collection].get(key),
  );
  apply(image, canonical, nat(sequence), writes);
  image.recordFloor = records.floor;
  image.tailBytes += Buffer.byteLength(String(body));
}

export function publishV3(image: V3Image) {
  for (const [sequence, body] of image.staged) foldRow(image, sequence, body);
  image.staged.length = 0;
  image.stale = false;
}

export function provisionV3(
  db: SqlDatabase,
  seal: Seal,
  legacyMarker: boolean,
  verification: Verification & { readonly portableTranscript?: never },
) {
  return db.transaction(() => {
    if (legacyMarker || db.get(legacyTables))
      throw fail("INPUT_CONFLICT", "Cloud v3 requires a fresh project");
    if (!priorV3Tables.some((table) => hasTable(db, table))) {
      for (const [table, definition] of Object.entries(schema))
        db.exec(`CREATE TABLE ${table} ${definition}`);
      for (const page of pages)
        db.run(`INSERT INTO ${PAGES} VALUES (?, ?)`, [page.id, page.body]);
      const body = canonicalJson(
        genesis(crypto.randomUUID(), crypto.randomUUID()),
      );
      db.run(`INSERT INTO ${ROOT} VALUES (1, ?, ?)`, [
        body,
        signRoot(seal, body),
      ]);
    }
    return recoverV3(db, seal, verification);
  });
}

export function activateV3(
  db: SqlDatabase,
  seal: Seal,
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
  const activation = activationBytes(
    root.incarnation,
    root.restoreEpoch,
    root.coveredHead,
    Date.now(),
  );
  const body = canonicalJson({
    ...root,
    activationDigest: digestBytes(activation),
  });
  for (const [table, definition] of Object.entries(schema))
    db.exec(`CREATE TABLE ${table} ${definition}`);
  for (const [id, page] of published)
    db.run(`INSERT INTO ${PAGES} VALUES (?, ?)`, [id, page]);
  db.run(`INSERT INTO ${ROOT} VALUES (1, ?, ?)`, [body, signRoot(seal, body)]);
  const sequence = imported.head + 1;
  db.run(`INSERT INTO ${COMMITS} VALUES (?, ?, ?)`, [
    sequence,
    activation,
    signRow(seal, root.incarnation, sequence, activation),
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
  if ("value" in slot) {
    if (
      collection === "control" &&
      !sealedAuthorityValid(collection, key, slot.value)
    )
      throw unavailable();
    return slot.value as Values[C];
  }
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

export function readV3GlobalControl(
  db: SqlDatabase,
  image: V3Image,
): LaneControlGlobal {
  const value = readV3Value(db, image, "control", "global");
  if (value !== undefined) return value as LaneControlGlobal;
  const initial = {
    version: 1,
    incarnation: image.root.incarnation,
    epoch: 0,
    resumeAllEpoch: 0,
    stopAll: null,
  } as const;
  if (!sealedAuthorityValid("control", "global", initial)) throw unavailable();
  return initial as LaneControlGlobal;
}

export function appendV3Frames(
  db: SqlDatabase,
  seal: Seal,
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
  return append(db, seal, image(), batch);
}

export { append };

function append(
  db: SqlDatabase,
  seal: Seal,
  image: V3Image,
  batch: readonly unknown[],
) {
  if (!batch.every(validAppendFrame))
    throw fail("INPUT_INVALID", "Invalid v3 frame");
  return db.transaction(() => {
    const { activationDigest, coveredHead, incarnation } = readV3Root(db, seal);
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
    if (head !== image.head) {
      image.stale = true;
      throw unavailable();
    }
    if (bodies.some((body) => Buffer.byteLength(body) > PAGE_BYTES))
      throw fail(
        "STORAGE_LIMIT_EXCEEDED",
        "This write is too large to keep in the project's history",
      );
    const pending = new Map<string, Slot>();
    let floor = image.recordFloor;
    const read = (key: string) =>
      pending.get(key) ?? image.entries.record.get(key);
    const refuse = () => fail("INPUT_INVALID", "Invalid v3 record transition");
    const prepared = bodies.map((body, i) => {
      const frame = JSON.parse(body) as Frame & Record<string, unknown>;
      const fault = authorityFault(frame);
      if (fault !== undefined)
        throw new Error(`Refusing a v3 frame with an invalid ${fault}`);
      if (
        frame.basis !== undefined &&
        (i > 0 || refusalOf(image, frame, claimEffect) === undefined)
      )
        throw new Error("Refusing a v3 frame with an invalid refusal");
      if (frame.operation === "issue.claim") verifyClaimFrame(image, frame);
      const records = verifyRecordFrame(frame, floor, read, refuse, image.load);
      floor = records.floor;
      for (const { key, value } of records.changes) pending.set(key, value);
      return { body, frame, writes: ordinaryWrites(frame, records.changes) };
    });
    admitFrames(db, image, prepared);
    image.stale = true;
    for (const [i, body] of bodies.entries()) {
      const sequence = head + i + 1;
      db.run(`INSERT INTO ${COMMITS} VALUES (?, ?, ?)`, [
        sequence,
        body,
        signRow(seal, incarnation, sequence, body),
      ]);
      image.staged.push([sequence, body]);
    }
    return { head: head + batch.length };
  });
}

export interface Frame {
  readonly operation: string;
  readonly time: number;
  readonly basis?: unknown;
  readonly events: readonly unknown[];
  readonly changes?: readonly unknown[];
  readonly lease?: LeaseRecord;
  readonly outcome?: {
    readonly id: string;
    readonly scope: ReceiptScope & { readonly family: "lease" | "command" };
    readonly fingerprint: string;
    readonly status: string;
    readonly result?: unknown;
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

const restoreFrame = (frame: unknown) =>
  isObject(frame) &&
  typeof frame.operation === "string" &&
  frame.operation.startsWith("restore.");

const validAppendFrame = (frame: unknown) =>
  !restoreFrame(frame) && validShape(frame) && withinDepth(frame);

export function archive(body: string): unknown {
  const frame = JSON.parse(body) as Record<string, unknown>;
  if (isObject(frame.outcome) && "result" in frame.outcome) {
    const { result, ...receipt } = frame.outcome;
    frame.outcome = { ...receipt, resultDigest: digestValue(result) };
  }
  return frame;
}

function countSlot(
  usage: Usage,
  collection: Collection,
  key: string,
  slot: Slot | undefined,
  sign: number,
) {
  if (slot === undefined) return;
  const revision =
    slot.revision === undefined ? {} : { revision: slot.revision };
  const entry =
    "deleted" in slot
      ? { collection, key, ...revision, deleted: true }
      : {
          collection,
          key,
          ...revision,
          page: "snapshot:0",
          offset: 999999,
          length: 999999,
          digest: "sha256:" + "0".repeat(64),
        };
  usage.directory += sign * (Buffer.byteLength(canonicalJson(entry)) + 1);
  if ("value" in slot)
    usage.snapshot += sign * Buffer.byteLength(canonicalJson(slot.value));
  else if ("length" in slot) usage.snapshot += sign * slot.length;
}

function countFrame(
  usage: Usage,
  archived: string,
  writes: readonly SlotWrite[],
  readSlot: (collection: Collection, key: string) => Slot | undefined,
) {
  usage.transcript +=
    Buffer.byteLength(archived) + Number(usage.transcript !== emptyBytes);
  for (const [collection, key, slot] of writes) {
    countSlot(usage, collection, key, readSlot(collection, key), -1);
    countSlot(usage, collection, key, slot, 1);
  }
}

function ordinaryWrites(
  frame: Frame,
  changes: ReturnType<typeof verifyRecordFrame>["changes"],
) {
  const { time, lease, outcome, witness } = frame;
  const writes: SlotWrite[] = [];
  if (lease) writes.push(["lease", lease.subject, { value: lease }]);
  if (outcome)
    writes.push([
      "outcome",
      outcome.id,
      {
        value: { ...(lease && { lease }), outcome, time },
      },
    ]);
  if (witness)
    writes.push(["witness", witness.id, { value: { lease, witness } }]);
  for (const { key, value } of changes) writes.push(["record", key, value]);
  return writes;
}

const budget = (
  transcript: number,
  snapshot: number,
  directory: number,
  rows: number,
  raw: number,
): Measure => ({ transcript, snapshot, directory, rows, raw, leases: 0 });
const limits = {
  ...budget(PAGE_BYTES, PAGE_BYTES, PAGE_BYTES, TAIL_ROWS, RAW_TAIL_BYTES),
  leases: RESTORE_LEASES,
};
const hard = { ...limits, raw: TAIL_BYTES, leases: Infinity };
const dimensions = Object.keys(limits) as (keyof Measure)[];
const stopReserve = budget(4096, 4096, 512, 1, 4096);
const activationControl = { transcript: 0, snapshot: 0, directory: 0 };
countSlot(activationControl, "control", "global", { value: null }, 1);
const activationReserve = budget(
  ACTIVATION_BYTES + 1,
  2736,
  activationControl.directory,
  1,
  ACTIVATION_BYTES,
);
const remainingReserve = budget(7168, 4096, 1024, 2, 7168);

export function releaseBudget(lease: LeaseRecord): Measure {
  const { subject, holder, generation } = lease;
  const time = 8.64e15;
  const hex = "0".repeat(64);
  const scope = { version: 2 as const, principal: "sha256:" + hex };
  const frame = {
    operation: "lease.release",
    format: COMMIT_FORMAT,
    sequence: Number.MAX_SAFE_INTEGER,
    time,
    events: [],
    lease: { ...lease, releasedAt: new Date(time).toISOString() },
    outcome: {
      id: "l2:" + hex,
      scope: { family: "lease" as const, ...scope },
      fingerprint: canonicalJson({
        scope,
        route: "release",
        subject,
        holder,
        generation,
        ttlMs: null,
      }),
      retryUntil: time,
      status: "ok",
    },
  };
  const body = canonicalJson(frame);
  const cost = budget(0, 0, 0, 1, Buffer.byteLength(body));
  countFrame(cost, body, ordinaryWrites(frame, []), (collection) =>
    collection === "lease" ? { value: lease } : undefined,
  );
  return cost;
}

function reserveOf(
  budgets: Iterable<LeaseBudget>,
  time: number,
  phase: "ordinary" | "activated" = "ordinary",
): Measure {
  const reserve = { ...remainingReserve };
  if (phase === "ordinary") {
    for (const key of dimensions)
      reserve[key] += stopReserve[key] + activationReserve[key];
    for (const { lease, cost } of budgets)
      if (Date.parse(lease.expiresAt) > time)
        for (const key of dimensions) reserve[key] += cost[key];
  }
  return reserve;
}

export function admits(
  before: Measure,
  after: Measure,
  reserveBefore: Measure,
  reserveAfter: Measure,
): boolean {
  return dimensions.every((key) => {
    const total = after[key] + reserveAfter[key];
    return (
      total <= limits[key] ||
      (after[key] <= hard[key] && total <= before[key] + reserveBefore[key])
    );
  });
}

function admitFrames(
  db: SqlDatabase,
  image: V3Image,
  prepared: readonly { body: string; frame: Frame; writes: SlotWrite[] }[],
) {
  const before: Measure = {
    ...image.usage,
    rows: image.head - image.root.coveredHead,
    raw: image.tailBytes,
    leases: image.entries.lease.size,
  };
  const after = { ...before };
  const initial = new Map<string, LeaseBudget>();
  for (const subject of image.entries.lease.keys()) {
    const lease = readV3Value(db, image, "lease", subject);
    if (lease && lease.releasedAt === undefined)
      initial.set(subject, { lease, cost: releaseBudget(lease) });
  }
  const budgets = new Map(initial);
  const slots = new Map<string, Slot | undefined>();
  const readSlot = (collection: Collection, key: string) => {
    const id = collection + ":" + key;
    return slots.has(id) ? slots.get(id) : image.entries[collection].get(key);
  };
  for (const { body, frame, writes } of prepared) {
    const { time, lease } = frame;
    countFrame(after, canonicalJson(archive(body)), writes, readSlot);
    after.rows++;
    after.raw += Buffer.byteLength(body);
    let retained: LeaseBudget | undefined;
    if (lease) {
      after.leases += Number(readSlot("lease", lease.subject) === undefined);
      if (lease.releasedAt === undefined)
        budgets.set(lease.subject, { lease, cost: releaseBudget(lease) });
      else {
        budgets.delete(lease.subject);
        const original = initial.get(lease.subject);
        if (
          original &&
          canonicalJson(original.lease.holder) !== canonicalJson(lease.holder)
        )
          retained = original;
      }
    }
    for (const [collection, key, slot] of writes)
      slots.set(collection + ":" + key, slot);
    const reserveBefore = reserveOf(initial.values(), time);
    const reserveAfter = reserveOf(
      retained ? [...budgets.values(), retained] : budgets.values(),
      time,
    );
    if (!admits(before, after, reserveBefore, reserveAfter))
      throw fail(
        "STORAGE_LIMIT_EXCEEDED",
        "This project's history is full. Ordinary writes are refused to keep room to release leases, stop lanes and restore.",
      );
  }
}

function apply(
  image: V3Image,
  frame: Pick<Frame, "events">,
  sequence: number,
  writes: readonly SlotWrite[],
) {
  for (const [collection, key, slot] of writes) {
    if (slot === undefined) image.entries[collection].delete(key);
    else image.entries[collection].set(key, slot);
    if (collection !== "record") continue;
    const counts = image.aliases;
    const byKey = image.aliasByKey;
    if (!counts || !byKey) continue;
    if (slot === undefined || (!("value" in slot) && !("deleted" in slot))) {
      delete image.aliases;
      delete image.aliasByKey;
      continue;
    }
    const old = byKey.get(key);
    if (old !== undefined) {
      const count = counts.get(old)! - 1;
      if (count) counts.set(old, count);
      else counts.delete(old);
    }
    const alias = "value" in slot ? recordAlias(key, slot.value) : undefined;
    if (alias === undefined) byKey.delete(key);
    else {
      byKey.set(key, alias);
      counts.set(alias, (counts.get(alias) ?? 0) + 1);
    }
  }
  image.head = sequence;
  image.eventWatermark += frame.events.length;
}

function transition(
  command: Omit<LeaseCommand, "scope" | "rawId" | "requestId">,
  current: LeaseRecord | undefined,
  now: number,
): LeaseRecord {
  const { route, subject, holder, ttlMs, generation } = command;
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

export function revokeV3Leases(
  db: SqlDatabase,
  seal: Seal,
  image: V3Image,
  token: TokenFields,
  now: number,
) {
  const { id, device, session, revokedAt } = token;
  const principal = ["owner", device, device] as const;
  const scope = receiptScope(principal);
  const frame = { operation: "lease.release", time: now, events: [] };
  const family = "lease" as const;
  const outcome = { scope: { family, ...scope }, status: "ok" };
  const batch: Frame[] = [];
  const released: string[] = [];
  for (const subject of [...image.entries.lease.keys()].sort()) {
    const rawId = `revoke/${id}/${subject}`;
    const requestId = scopeRequestId(family, principal, rawId);
    if (revokedAt !== null) {
      if (image.entries.outcome.has(requestId)) released.push(subject);
      continue;
    }
    const prior = readV3Value(db, image, "lease", subject);
    if (!prior || prior.releasedAt !== undefined) continue;
    const held = prior.holder.session;
    const retryUntil = Date.parse(prior.expiresAt);
    if (held.device !== device || held.id !== session || !(retryUntil > now))
      continue;
    const input = { ...prior, rawId, requestId, scope };
    const command = { ...input, route: "release" as const, ttlMs: null };
    const lease = transition(command, prior, now);
    checkLeaseRecord(lease);
    const fingerprint = leaseFingerprint(command);
    const receipt = { ...outcome, id: requestId, fingerprint, retryUntil };
    batch.push({ ...frame, lease, outcome: receipt });
    released.push(subject);
  }
  if (batch.length) append(db, seal, image, batch);
  return released;
}

type IssueClaim = Pick<LeaseCommand, "subject" | "holder"> & {
  prefix: string;
  ttlMs: number;
};

export function claimEffect(
  image: V3Image,
  claim: IssueClaim,
  time: number,
  expiresAt: number,
) {
  const { subject, prefix, holder, ttlMs } = claim;
  configured(prefix);
  const id = subject.slice(6);
  const read = (id: string) => {
    const key = /^work-\d+$/.test(id) ? `r${id.slice(5)}` : "";
    const value = image.load("record", key);
    return {
      value,
      revision:
        value === undefined ? 0 : image.entries.record.get(key)!.revision!,
    };
  };
  const record = read(id);
  if (record.value === undefined)
    throw fail("NOT_FOUND", `Issue ${shownId(id, prefix)} was not found`);
  const issue = checkedValue(
    { ...record, namespace: NAMESPACE, key: subject },
    id,
  );
  if (issue.status !== "open")
    throw fail("INPUT_CONFLICT", "Closed issues cannot be claimed");
  const current = image.load("lease", subject) as Frame["lease"];
  const dependencies = issue.dependsOn.map((id) => ({ id, ...read(id) }));
  const unfinished = dependencies.filter(
    ({ value }) => !isObject(value) || value.status !== "closed",
  );
  if (unfinished.length && !holds(current && { ...current }, time)) {
    const blockers = unfinished.map(({ id, value }) => {
      const lease = image.load("lease", `issue:${id}`) as Frame["lease"];
      const holder =
        lease?.releasedAt === undefined ? lease?.holder : undefined;
      const shown = { id: shownId(id, prefix) };
      const edge = holder
        ? { ...shown, holder, holderUnverified: true }
        : shown;
      const state = value === undefined ? "(missing)" : "(open)";
      return {
        edge,
        text: [shown.id, state, holder ? JSON.stringify(holder) : ""].join(" "),
      };
    });
    throw new ForgeFailure({
      code: "CLAIM_BLOCKED",
      message: blockers.map(({ text }) => text).join(", "),
      retry: "never",
      observed: { blockers: blockers.map(({ edge }) => edge) },
    });
  }
  checkTtl(ttlMs, expiresAt, time);
  const lease = transition(
    { route: "claim", subject, holder, ttlMs, generation: null },
    current,
    time,
  );
  checkLeaseRecord(lease);
  const readSet = [{ id, ...record }, ...dependencies].map(
    ({ id, revision }) => ({
      key: `issue:${id}`,
      expectRevision: revision,
    }),
  );
  const { generation, expiresAt: expiry } = lease;
  return {
    lease,
    events: [{ subject, prefix, holder, ttlMs, readSet }],
    result: { id: shownId(id, prefix), generation, expiresAt: expiry },
  };
}

function verifyClaimFrame(image: V3Image, frame: Frame): Frame {
  const outcome = frame.outcome!;
  if (outcome.status !== "ok") {
    if (frame.events.length !== 0) throw unavailable();
    return frame;
  }
  const claim = frame.events[0] as IssueClaim;
  if (image.entries.witness.has(outcome.id)) throw unavailable();
  try {
    const { lease, events, result } = claimEffect(
      image,
      claim,
      frame.time,
      outcome.retryUntil,
    );
    const { resultDigest: _digest, ...receipt } = outcome;
    if (
      canonicalJson(frame.lease) !== canonicalJson(lease) ||
      canonicalJson(frame.events) !== canonicalJson(events) ||
      !resultMatches(outcome, result) ||
      !validators.validateLeaseGrant(result).ok
    )
      throw unavailable();
    return { ...frame, outcome: { ...receipt, result } };
  } catch {
    throw unavailable();
  }
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
  verification?: Pick<Verification, "pages" | "admit">,
): Frame {
  const { outcome, time } = frame;
  if (outcome?.scope.family === "command") {
    const { id } = outcome;
    const prior = readV3Value(db, image, "outcome", id, verification?.pages);
    if (prior && prior.outcome.retryUntil > time) throw unavailable();
  }
  if (frame.operation === "issue.claim") return verifyClaimFrame(image, frame);
  if (!verification || outcome?.scope.family !== "lease") return frame;
  const { pages, admit } = verification;
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

const settled = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

export function leaseV3(
  db: SqlDatabase,
  seal: Seal,
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
        append(db, seal, image, [{ ...frame, outcome: refused }]);
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
      append(db, seal, image, [
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
  if ("refusal" in result)
    throw new ForgeFailure(settled(result.refusal.error));
  return settled(result.lease);
}
