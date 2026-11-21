import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { AdmitLeaseRequest } from "./project.ts";
import { type DurableStorage, TABLE_PROBE } from "./store.ts";
import {
  COLLECTIONS,
  COMMITS,
  entryDigest,
  PAGES,
  PAGE_SCHEMA,
  readV3Root,
  recoverV3,
  ROOT,
  type V3Image,
} from "./v3-store.ts";

const STAGE = "cloud_v3_checkpoint";
const STAGED = "cloud_v3_checkpoint_pages";
const RETIRED = "cloud_v3_retired_pages";
const PAGE_BYTES = 256 * 1024;
const MANIFEST_BYTES = 128 * 1024;
const TURN_ROWS = 64;
const TURN_MAX_NON_TAIL_ROWS = 39;
const TURN_TAIL_ROWS = Math.floor((TURN_ROWS - TURN_MAX_NON_TAIL_ROWS) / 2);
const TURN_TAIL_BYTES = 512 * 1024;
const SNAPSHOT = "snapshot:0";
const activeStages = new WeakSet<DurableStorage>();

function requireCheckpoint(condition: unknown): asserts condition {
  if (!condition)
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message: "Cloud v3 checkpoint cannot be verified within one turn",
      retry: "never",
    });
}

type Item = readonly [string, string, string | null, number | undefined];

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    requireCheckpoint(false);
  }
}

export function inventory(
  image: V3Image,
  pages: ReadonlyMap<string, Buffer>,
  collections: readonly (typeof COLLECTIONS)[number][] = COLLECTIONS,
): Item[] {
  return collections.flatMap((collection) =>
    [...image.entries[collection].keys()].sort().map((key) => {
      const slot = image.entries[collection].get(key)!;
      if ("deleted" in slot) return [collection, key, null, slot.revision];
      if ("value" in slot)
        return [collection, key, canonicalJson(slot.value), slot.revision];
      const data = pages
        .get(slot.page)
        ?.subarray(slot.offset, slot.offset + slot.length);
      requireCheckpoint(
        data?.length === slot.length && digestBytes(data) === slot.digest,
      );
      const body = data.toString("utf8");
      requireCheckpoint(digestBytes(body) === slot.digest);
      return [collection, key, body, slot.revision];
    }),
  );
}

function storedPages(db: SqlDatabase, table: string) {
  const rows = db.all(
    `SELECT id, CASE WHEN length(CAST(body AS BLOB))<=${PAGE_BYTES} THEN body END AS body FROM ${table} ORDER BY id LIMIT 4`,
  );
  requireCheckpoint(rows.length <= 3);
  return new Map(
    rows.map(({ id, body }) => {
      requireCheckpoint(typeof id === "string" && typeof body === "string");
      return [id, body];
    }),
  );
}

function archive(body: string): unknown {
  const frame = JSON.parse(body) as Record<string, unknown>;
  if (isObject(frame.outcome) && "result" in frame.outcome) {
    const { result, ...receipt } = frame.outcome;
    frame.outcome = { ...receipt, resultDigest: digestValue(result) };
  }
  return frame;
}

function reconcileReceipts(
  retained: readonly Item[],
  history: readonly unknown[],
) {
  const expected = new Map<string, string>();
  for (const [i, frame] of history.entries()) {
    requireCheckpoint(isObject(frame) && frame.sequence === i + 1);
    const { time, outcome, lease } = frame;
    if (outcome === undefined) continue;
    requireCheckpoint(
      isObject(outcome) &&
        typeof outcome.id === "string" &&
        !("result" in outcome),
    );
    expected.set(
      outcome.id,
      canonicalJson({ time, outcome, ...(lease !== undefined && { lease }) }),
    );
  }
  requireCheckpoint(expected.size === retained.length);
  for (const [, id, body] of retained)
    requireCheckpoint(
      body !== null && expected.get(id) === canonicalJson(archive(body)),
    );
}

function pack(items: readonly Item[], transcript: string) {
  let offset = 0;
  const snapshot: string[] = [];
  const directory = items.map(([collection, key, body, revision]) => {
    const metadata = revision === undefined ? {} : { revision };
    if (body === null) return { collection, key, ...metadata, deleted: true };
    const length = Buffer.byteLength(body);
    const entry = {
      collection,
      key,
      ...metadata,
      page: SNAPSHOT,
      offset,
      length,
      digest: digestBytes(body),
    };
    offset += length;
    snapshot.push(body);
    return entry;
  });
  return new Map([
    ["directory:0", canonicalJson(directory)],
    [SNAPSHOT, snapshot.join("")],
    ["transcript:0", transcript],
  ]);
}

function roster(
  pages: ReadonlyMap<string, string>,
  items: readonly Item[],
  cut: number,
) {
  const counts = {
    directory: items.length,
    snapshot: items.filter((item) => item[2] !== null).length,
    transcript: cut,
  };
  const spans: Record<string, readonly unknown[]> = {
    directory: [
      items[0]?.slice(0, 2) ?? null,
      items.at(-1)?.slice(0, 2) ?? null,
    ],
    snapshot: [null, null],
    transcript: cut ? [1, cut] : [null, null],
  };
  const listed = Object.entries(counts).map(([kind, count]) => {
    const id = `${kind}:0`;
    const body = pages.get(id);
    requireCheckpoint(body !== undefined);
    const [first, last] = spans[kind]!;
    return {
      id,
      kind,
      ordinal: 0,
      count,
      first,
      last,
      bytes: Buffer.byteLength(body),
      hash: digestBytes(body),
    };
  });
  requireCheckpoint(listed.every(({ bytes }) => bytes <= PAGE_BYTES));
  return {
    counts,
    bytes: Object.fromEntries(listed.map(({ kind, bytes }) => [kind, bytes])),
    pages: listed,
  };
}

export function reconcile(
  pages: ReadonlyMap<string, string>,
  expected: readonly Item[],
  transcript: string,
) {
  const body = pages.get("directory:0");
  const snapshot = pages.get(SNAPSHOT);
  requireCheckpoint(
    body !== undefined &&
      snapshot !== undefined &&
      pages.get("transcript:0") === transcript,
  );
  const bytes = Buffer.from(snapshot);
  let offset = 0;
  const entries = expected.map(([collection, key, value, revision]) => {
    const metadata = revision === undefined ? {} : { revision };
    if (value === null) return { collection, key, ...metadata, deleted: true };
    const length = Buffer.byteLength(value);
    const digest = digestBytes(value);
    requireCheckpoint(
      digestBytes(bytes.subarray(offset, offset + length)) === digest,
    );
    const entry = { collection, key, page: SNAPSHOT, offset, length, digest };
    offset += length;
    return { ...entry, ...metadata };
  });
  requireCheckpoint(offset === bytes.length && canonicalJson(entries) === body);
  return digestValue(
    expected.map(([name, key, value, revision]) => [
      name,
      key,
      entryDigest(value === null ? null : digestBytes(value), revision),
    ]),
  );
}

function discardStage(db: SqlDatabase) {
  db.exec(`DROP TABLE IF EXISTS ${STAGED}`);
  db.exec(`DROP TABLE IF EXISTS ${STAGE}`);
}

function collect(db: SqlDatabase, cut: number) {
  db.run(`DELETE FROM ${COMMITS} WHERE sequence<=?`, [cut]);
  db.exec(`DROP TABLE IF EXISTS ${RETIRED}`);
}

function commitHead(db: SqlDatabase, coveredHead: number) {
  const last = db.get(
    `SELECT sequence FROM ${COMMITS} ORDER BY sequence DESC LIMIT 1`,
  );
  return Math.max(coveredHead, Number(last?.sequence ?? 0));
}

type ReplaceWarm = (image: V3Image | undefined) => void;

export async function checkpointV3(
  db: SqlDatabase,
  storage: DurableStorage,
  warm: V3Image | undefined,
  replaceWarm: ReplaceWarm,
  admit: AdmitLeaseRequest,
) {
  requireCheckpoint(!activeStages.has(storage));
  activeStages.add(storage);
  try {
    const pending = db.get(TABLE_PROBE, [RETIRED]) !== undefined;
    return await checkpoint(db, storage, warm, replaceWarm, pending, admit);
  } finally {
    activeStages.delete(storage);
  }
}

async function checkpoint(
  db: SqlDatabase,
  storage: DurableStorage,
  warm: V3Image | undefined,
  replaceWarm: ReplaceWarm,
  pending: boolean,
  admit: AdmitLeaseRequest,
) {
  const root = readV3Root(db);
  const source = canonicalJson(root);
  const seal = digestBytes(source);
  const cut = commitHead(db, root.coveredHead);
  requireCheckpoint(cut - root.coveredHead <= TURN_TAIL_ROWS);
  const prior = storedPages(db, PAGES);
  requireCheckpoint(
    prior.size === root.pages.length &&
      root.pages.every(({ id, hash }) => {
        const body = prior.get(id);
        return body !== undefined && digestBytes(body) === hash;
      }),
  );
  const frames = db.all(
    `SELECT CASE WHEN sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence)<=${TURN_TAIL_BYTES} THEN body END AS body FROM ${COMMITS} WHERE sequence>? AND sequence<=? ORDER BY sequence`,
    [root.coveredHead, cut],
  );
  requireCheckpoint(
    frames.length === cut - root.coveredHead &&
      frames.every(({ body }) => typeof body === "string"),
  );
  const archived = parse(prior.get("transcript:0") ?? "null");
  requireCheckpoint(
    Array.isArray(archived) &&
      archived.length === root.coveredHead &&
      "transcriptDigest" in root &&
      digestBytes(prior.get("transcript:0")!) === root.transcriptDigest,
  );
  const history: readonly unknown[] = archived;
  const previous = new Map(
    [...prior].map(([id, body]) => [id, Buffer.from(body)]),
  );
  const image = recoverV3(db, {
    admit,
    pages: previous,
    sealed: (sealed) =>
      reconcileReceipts(inventory(sealed, previous, ["outcome"]), history),
  });
  requireCheckpoint(image.head === cut);
  const expected = inventory(image, previous);
  const current = inventory(warm && !warm.stale ? warm : image, previous);
  const transcript = canonicalJson([
    ...history,
    ...frames.map(({ body }) => archive(String(body))),
  ]);
  const cutoff = Math.max(Number(image.root.receiptCutoff), Date.now());
  const pages = pack(current, transcript);
  const proposal = canonicalJson(roster(pages, current, cut));
  requireCheckpoint(Buffer.byteLength(proposal) <= MANIFEST_BYTES);
  db.transaction(() => {
    discardStage(db);
    db.exec(
      `CREATE TABLE ${STAGE} (source TEXT NOT NULL, cut INTEGER NOT NULL, cutoff INTEGER NOT NULL, proposal TEXT NOT NULL)`,
    );
    db.exec(`CREATE TABLE ${STAGED} ${PAGE_SCHEMA}`);
    db.run(`INSERT INTO ${STAGE} VALUES (?, ?, ?, ?)`, [
      seal,
      cut,
      cutoff,
      proposal,
    ]);
    for (const [id, body] of pages)
      db.run(`INSERT INTO ${STAGED} VALUES (?, ?)`, [id, body]);
  });

  let switchStarted = false;
  try {
    await storage.sync?.();
    const staged = db.get(
      `SELECT source, cut, cutoff, CASE WHEN length(CAST(proposal AS BLOB))<=${MANIFEST_BYTES} THEN proposal END AS proposal FROM ${STAGE} LIMIT 1`,
    );
    requireCheckpoint(
      staged?.source === seal && staged.cut === cut && staged.cutoff === cutoff,
    );
    const readback = storedPages(db, STAGED);
    const projectionDigest = reconcile(readback, expected, transcript);
    const verified = roster(readback, expected, cut);
    requireCheckpoint(canonicalJson(verified) === staged.proposal);
    const manifest = canonicalJson({
      ...root,
      ...verified,
      generation: root.generation + 1,
      parentDigest: seal,
      coveredHead: cut,
      eventWatermark: image.eventWatermark,
      transcriptDigest: digestBytes(transcript),
      publicDigest: projectionDigest,
      privateDigest: digestValue([]),
    });
    requireCheckpoint(Buffer.byteLength(manifest) <= MANIFEST_BYTES);
    const next = db.transaction(() => {
      const pinned = db.get(
        `SELECT 1 FROM ${ROOT} WHERE id=1 AND seal=? AND body=?`,
        [seal, source],
      );
      requireCheckpoint(pinned && commitHead(db, root.coveredHead) === cut);
      replaceWarm(undefined);
      switchStarted = true;
      if (pending) collect(db, root.coveredHead);
      db.exec(`ALTER TABLE ${PAGES} RENAME TO ${RETIRED}`);
      db.exec(`ALTER TABLE ${STAGED} RENAME TO ${PAGES}`);
      db.run(`UPDATE ${ROOT} SET body=?, seal=? WHERE id=1`, [
        manifest,
        digestBytes(manifest),
      ]);
      return recoverV3(db);
    });
    try {
      await storage.sync?.();
    } catch (error) {
      replaceWarm(undefined);
      throw error;
    }
    replaceWarm(next);
    collect(db, cut);
    discardStage(db);
    return {
      rosterDigest: digestValue(verified.pages),
      projectionDigest,
    };
  } finally {
    if (!switchStarted) db.transaction(() => discardStage(db));
  }
}
