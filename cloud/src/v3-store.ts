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
const MANIFEST_BYTES = 128 * 1024;
const TAIL_ROWS = 1024;
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

const fail = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });
const unavailable = () => fail("UNAVAILABLE", "Cloud v3 root is unavailable");

export function readV3Root(db: SqlDatabase) {
  if (!tables.every((table) => hasTable(db, table))) throw unavailable();
  const row = db.get(
    `SELECT body, seal FROM ${ROOT} WHERE id=1 AND length(CAST(body AS BLOB))<=${MANIFEST_BYTES}`,
  );
  if (typeof row?.body !== "string" || row.seal !== digestBytes(row.body))
    throw unavailable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.body);
  } catch {
    throw unavailable();
  }
  if (
    !isObject(parsed) ||
    typeof parsed.incarnation !== "string" ||
    parsed.incarnation.length === 0 ||
    typeof parsed.restoreEpoch !== "string" ||
    parsed.restoreEpoch.length === 0
  )
    throw unavailable();
  const expected = genesis(parsed.incarnation, parsed.restoreEpoch);
  if (
    row.body !== canonicalJson(expected) ||
    canonicalJson(
      db.all(
        `SELECT id, CASE WHEN length(CAST(body AS BLOB))=${emptyBytes} THEN body END AS body FROM ${PAGES} ORDER BY id LIMIT 3`,
      ),
    ) !== canonicalJson(pages)
  )
    throw unavailable();
  return expected;
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
    return readV3Root(db);
  });
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
