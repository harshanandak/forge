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
  archive,
  COLLECTIONS,
  COMMITS,
  entryDigest,
  foldTranscript,
  PAGE_BYTES,
  PAGES,
  PAGE_SCHEMA,
  readSealedRoot,
  recoverV3,
  ROOT,
  TAIL_ROWS,
  type Discovery,
  type V3Image,
} from "./v3-store.ts";
import { BOUNDED_MAC, type Seal, signRoot, verifyRow } from "./v3-seal.ts";

const STAGE = "cloud_v3_checkpoint";
const STAGED = "cloud_v3_checkpoint_pages";
const RETIRED = "cloud_v3_retired_pages";
export { PAGE_BYTES };
const MANIFEST_BYTES = 128 * 1024;
const TURN_ROWS = 64;
const TURN_MAX_NON_TAIL_ROWS = 39;
const TURN_TAIL_ROWS = Math.floor((TURN_ROWS - TURN_MAX_NON_TAIL_ROWS) / 2);
const TURN_TAIL_BYTES = 512 * 1024;
const SNAPSHOT = "snapshot:0";
const activeStages = new WeakSet<DurableStorage>();

const unverified = () =>
  new ForgeFailure({
    code: "UNAVAILABLE",
    message: "Cloud v3 checkpoint cannot be verified within one turn",
    retry: "never",
  });

function requireCheckpoint(condition: unknown): asserts condition {
  if (!condition) throw unverified();
}

export function checkpointPrefixLength(lengths: readonly number[]): number {
  let count = 0;
  let remaining = TURN_TAIL_BYTES;
  for (const bytes of lengths) {
    if (count === TURN_TAIL_ROWS || bytes > remaining) break;
    remaining -= bytes;
    count++;
  }
  return count;
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

export function storedPages(db: SqlDatabase, table: string) {
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

export function roster(
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
}

export function digestProjection(items: readonly Item[]) {
  return digestValue(
    items.map(([collection, key, body, revision]) => [
      collection,
      key,
      entryDigest(body === null ? null : digestBytes(body), revision),
    ]),
  );
}

export function archivedCheck(
  db: SqlDatabase,
  options: {
    admit: AdmitLeaseRequest;
    failure: () => Error;
    pages?: ReadonlyMap<string, string> | undefined;
  },
) {
  const { admit, failure } = options;
  const sealed = (image: V3Image, { current }: Discovery) => {
    const { root, recordFloor } = image;
    try {
      const pages = options.pages ?? storedPages(db, PAGES);
      const ids = root.generation === 0 ? "" : `,${SNAPSHOT}`;
      requireCheckpoint(
        root.pages.map(({ id }) => id).join() ===
          `directory:0${ids},transcript:0` &&
          pages.size === root.pages.length &&
          root.pages.every(({ id, bytes, hash }) => {
            const body = pages.get(id);
            return (
              body !== undefined &&
              Buffer.byteLength(body) === bytes &&
              digestBytes(body) === hash
            );
          }),
      );
      const transcript = pages.get("transcript:0")!;
      const frames = parse(transcript);
      requireCheckpoint(
        Array.isArray(frames) &&
          frames.length === root.coveredHead &&
          digestBytes(transcript) === root.transcriptDigest &&
          canonicalJson(frames) === transcript,
      );
      const boundary = current
        ? root.coveredHead + 1
        : frames.findLastIndex(
            (frame: unknown) =>
              isObject(frame) && frame.operation === "restore.activate",
          ) + 1;
      const folded = foldTranscript(db, frames, "archived", admit, {
        root,
        boundary,
      });
      const snapshot = pages.has(SNAPSHOT);
      const expected = inventory(folded, new Map());
      if (snapshot) reconcile(pages, expected, transcript);
      requireCheckpoint(
        digestProjection(expected) === root.publicDigest &&
          folded.head === root.coveredHead &&
          folded.eventWatermark === root.eventWatermark &&
          folded.recordFloor === recordFloor,
      );
      image.fold = folded.fold!;
    } catch {
      throw failure();
    }
  };
  return { admit, sealed };
}

function discardStage(db: SqlDatabase) {
  db.exec(`DROP TABLE IF EXISTS ${STAGED}`);
  db.exec(`DROP TABLE IF EXISTS ${STAGE}`);
}

function collect(db: SqlDatabase, cut: number) {
  db.transaction(() => {
    db.run(`DELETE FROM ${COMMITS} WHERE sequence<=?`, [cut]);
    db.exec(`DROP TABLE IF EXISTS ${RETIRED}`);
    discardStage(db);
  });
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
  commitSeal: Seal,
  storage: DurableStorage,
  warm: V3Image | undefined,
  replaceWarm: ReplaceWarm,
  admit: AdmitLeaseRequest,
) {
  requireCheckpoint(!activeStages.has(storage));
  activeStages.add(storage);
  try {
    return await checkpoint(db, commitSeal, storage, warm, replaceWarm, admit);
  } finally {
    activeStages.delete(storage);
  }
}

async function checkpoint(
  db: SqlDatabase,
  commitSeal: Seal,
  storage: DurableStorage,
  warm: V3Image | undefined,
  replaceWarm: ReplaceWarm,
  admit: AdmitLeaseRequest,
) {
  const { root, envelope } = readSealedRoot(db, commitSeal);
  requireCheckpoint(root.activationDigest === undefined);
  if (db.get(TABLE_PROBE, [RETIRED])) collect(db, root.coveredHead);
  const source = canonicalJson(root);
  const seal = digestBytes(source);
  const tail = commitHead(db, root.coveredHead) - root.coveredHead;
  requireCheckpoint(tail >= 0 && tail <= TAIL_ROWS);
  const candidateCount = Math.min(tail, TURN_TAIL_ROWS);
  const prior = storedPages(db, PAGES);
  const candidates = db.all(
    `SELECT sequence, ${BOUNDED_MAC}, length(CAST(body AS BLOB)) AS bytes, CASE WHEN sum(length(CAST(body AS BLOB))) OVER (ORDER BY sequence)<=${TURN_TAIL_BYTES} THEN body END AS body FROM ${COMMITS} WHERE sequence>? AND sequence<=? ORDER BY sequence`,
    [root.coveredHead, root.coveredHead + candidateCount],
  );
  requireCheckpoint(candidates.length === candidateCount);
  const count = checkpointPrefixLength(
    candidates.map(({ bytes }) => Number(bytes)),
  );
  requireCheckpoint(tail === 0 || count > 0);
  const cut = root.coveredHead + count;
  const frames = candidates.slice(0, count);
  requireCheckpoint(
    frames.every(({ sequence, body, mac }) =>
      verifyRow(commitSeal, root.incarnation, sequence, body, mac),
    ),
  );
  requireCheckpoint(
    prior.size === root.pages.length &&
      root.pages.every(({ id, hash }) => {
        const body = prior.get(id);
        return body !== undefined && digestBytes(body) === hash;
      }),
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
  const check = (pages: ReadonlyMap<string, string>) =>
    archivedCheck(db, { admit, failure: unverified, pages });
  const image = recoverV3(
    db,
    commitSeal,
    { ...check(prior), pages: previous },
    { through: cut },
  );
  requireCheckpoint(image.head === cut);
  const expected = inventory(image, previous);
  const current =
    warm && !warm.stale && warm.head === cut
      ? inventory(warm, previous)
      : expected;
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
    reconcile(readback, expected, transcript);
    const verified = roster(readback, expected, cut);
    requireCheckpoint(canonicalJson(verified) === staged.proposal);
    const projectionDigest = digestProjection(expected);
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
        [envelope, source],
      );
      requireCheckpoint(pinned);
      const head = commitHead(db, root.coveredHead);
      requireCheckpoint(head >= cut);
      replaceWarm(undefined);
      switchStarted = true;
      db.exec(`ALTER TABLE ${PAGES} RENAME TO ${RETIRED}`);
      db.exec(`ALTER TABLE ${STAGED} RENAME TO ${PAGES}`);
      db.run(`UPDATE ${ROOT} SET body=?, seal=? WHERE id=1`, [
        manifest,
        signRoot(commitSeal, manifest),
      ]);
      const verifiedRoot = recoverV3(db, commitSeal, check(readback), {
        through: cut,
      });
      return head === cut ? verifiedRoot : undefined;
    });
    try {
      await storage.sync?.();
    } catch (error) {
      replaceWarm(undefined);
      throw error;
    }
    if (next) replaceWarm(next);
    collect(db, cut);
    await storage.sync?.();
    return {
      coveredHead: cut,
      more: commitHead(db, cut) > cut,
      rosterDigest: digestValue(verified.pages),
      projectionDigest,
    };
  } finally {
    if (!switchStarted) db.transaction(() => discardStage(db));
  }
}
