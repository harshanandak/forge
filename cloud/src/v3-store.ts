import { ForgeFailure } from "../../src/contract/failure.ts";
import { decideLease } from "../../src/contract/lease.ts";
import {
  canonicalJson,
  digestBytes,
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
import { TABLE_PROBE } from "./store.ts";

const ROOT = "cloud_v3_root";
const PAGES = "cloud_v3_pages";
const COMMITS = "cloud_v3_commits";
const COMMIT_FORMAT = "forge-cloud-commit/3";
const MiB = 1024 * 1024;
const MANIFEST_BYTES = 128 * 1024;
const ROSTER_PAGES = 640;
const DIRECTORY_PAGES = 32;
const DIRECTORY_BYTES = 4 * MiB;
const TAIL_ROWS = 1024;
const TAIL_BYTES = 16 * MiB;
const KINDS = ["directory", "snapshot", "transcript"];
const COLLECTIONS = ["lease", "outcome", "record", "witness"] as const;
const SYNTHETIC_KEYS = ["events", "operation", "time"];
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
  [PAGES]: "(id TEXT PRIMARY KEY, body TEXT NOT NULL) WITHOUT ROWID",
  [COMMITS]:
    "(sequence INTEGER PRIMARY KEY CHECK(sequence>0), body TEXT NOT NULL)",
};
const tables = Object.keys(schema);
const legacyTables =
  "SELECT 1 FROM sqlite_schema WHERE type='table' AND (name GLOB 'state_*' OR name GLOB 'domain_cloud_*') LIMIT 1";

const hasTable = (db: SqlDatabase, name: string): boolean =>
  db.get(TABLE_PROBE, [name]) !== undefined;

export const hasV3Root = (db: SqlDatabase): boolean => hasTable(db, ROOT);

function genesis(incarnation: string, restoreEpoch: string) {
  return {
    format: "forge-cloud-root/3",
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
type Slot = { readonly value: unknown } | Pointer;
export interface V3Image {
  readonly root: Readonly<Record<string, unknown>> & {
    readonly coveredHead: number;
    readonly pages: readonly Page[];
  };
  readonly entries: Readonly<Record<Collection, Map<string, Slot>>>;
  head: number;
  eventWatermark: number;
}

const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });
const unavailable = () => fail("UNAVAILABLE", "Cloud v3 root is unavailable");
const nat = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw unavailable();
  return value;
};
const parse = (text: unknown): unknown => {
  try {
    return JSON.parse(String(text));
  } catch {
    throw unavailable();
  }
};

export function readV3Root(db: SqlDatabase) {
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
  const listed = root.pages.map((page): Page & { ordinal: number } => {
    const kind = isObject(page) ? KINDS.indexOf(String(page.kind)) : -1;
    if (!isObject(page) || kind < rank) throw unavailable();
    if (kind > rank) [rank, next] = [kind, 0];
    const ordinal = nat(page.ordinal);
    if (ordinal !== next++) throw unavailable();
    const name = KINDS[kind]!;
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
      hash: String(page.hash),
    };
  });
  const [generation, coveredHead, eventWatermark] = [
    root.generation,
    root.coveredHead,
    root.eventWatermark,
  ].map(nat) as [number, number, number];
  const manifest = { ...root, counts, bytes, pages: listed };
  if (
    Object.keys(root).sort().join() !== Object.keys(base).sort().join() ||
    canonicalJson(manifest) !== row.body ||
    (generation === 0 && row.body !== canonicalJson(base)) ||
    coveredHead !== (counts.transcript ?? 0) ||
    listed.filter(({ kind }) => kind === "directory").length >
      DIRECTORY_PAGES ||
    (bytes.directory ?? 0) > DIRECTORY_BYTES
  )
    throw unavailable();
  return { ...manifest, coveredHead, eventWatermark };
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
  const target = byId.get(String(entry.page));
  const offset = nat(entry.offset);
  const length = nat(entry.length);
  if (
    target === undefined ||
    target.kind === "directory" ||
    length === 0 ||
    offset + length > target.bytes ||
    typeof entry.digest !== "string"
  )
    throw unavailable();
  return {
    collection,
    key,
    page: target.id,
    offset,
    length,
    digest: entry.digest,
  };
}

export function recoverV3(db: SqlDatabase): V3Image {
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
  const image: V3Image = {
    root,
    entries: {
      lease: new Map(),
      outcome: new Map(),
      record: new Map(),
      witness: new Map(),
    },
    head: root.coveredHead,
    eventWatermark: root.eventWatermark,
  };
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
      canonicalJson(entries) !== body ||
      entries.length !== page.count ||
      canonicalJson(ends) !== canonicalJson([page.first, page.last])
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
    }
  }
  const rows = db.all(
    `SELECT sequence, CASE WHEN sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence)<=${TAIL_BYTES} THEN body END AS body FROM (SELECT sequence, body FROM ${COMMITS} WHERE sequence>? ORDER BY sequence LIMIT ${TAIL_ROWS + 1}) ORDER BY sequence`,
    [root.coveredHead],
  );
  if (rows.length > TAIL_ROWS) throw unavailable();
  for (const { sequence, body } of rows) {
    const frame = typeof body === "string" ? parse(body) : undefined;
    if (
      sequence !== image.head + 1 ||
      !validFrame(frame) ||
      frame.format !== COMMIT_FORMAT ||
      frame.sequence !== sequence
    )
      throw unavailable();
    apply(image, frame, nat(sequence));
  }
  return image;
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
    return viewV3(recoverV3(db));
  });
}

export function viewV3(image: V3Image) {
  const digest = (slot: Slot) =>
    "value" in slot ? digestBytes(canonicalJson(slot.value)) : slot.digest;
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

export const GENESIS_LEASE_ONLY =
  "Cloud v3 lease commands need the genesis root until they read the recovered image";

export function requireGenesisForLease(db: SqlDatabase) {
  if (recoverV3(db).root.generation !== 0)
    throw fail("UNAVAILABLE", GENESIS_LEASE_ONLY);
}

export function appendV3Frames(
  db: SqlDatabase,
  frames: unknown,
  trusted = false,
) {
  if (!Array.isArray(frames) || frames.length === 0)
    throw fail("INPUT_INVALID", "Invalid v3 frame batch");
  const batch: readonly unknown[] = frames;
  return db.transaction(() => {
    const { coveredHead } = readV3Root(db);
    const last = db.get(
      `SELECT sequence FROM ${COMMITS} ORDER BY sequence DESC LIMIT 1`,
    );
    let sequence = Math.max(coveredHead, Number(last?.sequence ?? 0));
    if (
      !Number.isSafeInteger(sequence) ||
      sequence - coveredHead + batch.length > TAIL_ROWS
    )
      throw unavailable();
    for (const frame of batch) {
      if (
        !isObject(frame) ||
        (!trusted &&
          Object.keys(frame).some((key) => !SYNTHETIC_KEYS.includes(key))) ||
        typeof frame.operation !== "string" ||
        !frame.operation ||
        typeof frame.time !== "number" ||
        !Number.isSafeInteger(frame.time) ||
        frame.time < 0 ||
        !Array.isArray(frame.events)
      )
        throw fail("INPUT_INVALID", "Invalid v3 frame");
      sequence++;
      db.run(`INSERT INTO ${COMMITS} VALUES (?, ?)`, [
        sequence,
        canonicalJson({ ...frame, format: "forge-cloud-commit/3", sequence }),
      ]);
    }
    return { head: sequence };
  });
}

interface Frame {
  readonly time: number;
  readonly events: readonly unknown[];
  readonly lease?: LeaseRecord;
  readonly outcome?: {
    readonly id: string;
    readonly scope: ReceiptScope & { readonly family: "lease" };
    readonly fingerprint: string;
    readonly status: string;
    readonly result?: ForgeError;
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

function validFrame(frame: unknown): frame is Frame & Record<string, unknown> {
  return (
    isObject(frame) &&
    typeof frame.operation === "string" &&
    frame.operation.length > 0 &&
    typeof frame.time === "number" &&
    Number.isSafeInteger(frame.time) &&
    frame.time >= 0 &&
    Array.isArray(frame.events)
  );
}

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

function latest(db: SqlDatabase, path: string, value: string) {
  const row = db.get(
    `SELECT body FROM ${COMMITS} WHERE json_extract(body, ?)=? ORDER BY sequence DESC LIMIT 1`,
    [path, value],
  );
  return row === undefined
    ? undefined
    : (JSON.parse(String(row.body)) as Frame);
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

export function leaseV3(
  db: SqlDatabase,
  command: LeaseCommand,
  expiresAt: number,
): LeaseRecord {
  const { route, subject, holder, ttlMs, requestId } = command;
  const result = db.transaction(
    (): { lease: LeaseRecord } | { refusal: ForgeFailure } => {
      readV3Root(db);
      const fingerprint = leaseFingerprint(command);
      const now = Date.now();
      const read = () => latest(db, "$.lease.subject", subject)?.lease;
      const prior = latest(db, "$.outcome.id", requestId);
      if (prior?.outcome !== undefined && prior.outcome.retryUntil > now) {
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
        appendV3Frames(db, [{ ...frame, outcome: refused }], true);
        return { refusal: error };
      };
      let current: LeaseRecord | undefined;
      try {
        if (route !== "release") checkTtl(ttlMs, expiresAt);
        current = read();
        checkLeaseSubject(
          subject,
          route === "claim" ? "acquire" : "held",
          current,
        );
      } catch (error) {
        return refuse(error);
      }
      const witnessed =
        route === "claim" ? latest(db, "$.witness.id", requestId) : undefined;
      if (witnessed?.witness !== undefined) {
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
        return { lease: witnessed.lease! };
      }
      let lease: LeaseRecord;
      try {
        lease = transition(command, current, now);
        checkLeaseRecord(lease);
      } catch (error) {
        return refuse(error);
      }
      appendV3Frames(
        db,
        [
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
        ],
        true,
      );
      return { lease };
    },
  );
  if ("refusal" in result) throw result.refusal;
  return result.lease;
}
