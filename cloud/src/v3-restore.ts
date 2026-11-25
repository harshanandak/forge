import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import {
  parseRestoreJson,
  withinRestoreBudget,
} from "../../src/core/state/restore-json.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { AdmitLeaseRequest } from "./project.ts";
import { storageFailure } from "./storage-failure.ts";
import { TABLE_PROBE } from "./store.ts";
import { isDigest, isNat } from "./v3-authority.ts";
import {
  archivedCheck,
  digestProjection,
  inventory,
  PAGE_BYTES,
  reconcile,
  roster,
  storedPages,
} from "./v3-checkpoint.ts";
import {
  authenticateManifest,
  type Manifest,
  type Seal,
  type VerifiedManifest,
} from "./v3-seal.ts";
import {
  activateV3,
  fail,
  hasPriorV3RestoreState,
  hasV3Root,
  PAGES,
  readV3Root,
  recoverV3,
  rejectOldCommits,
} from "./v3-store.ts";

const STAGE = "cloud_v3_restore";
const IDS = ["directory:0", "snapshot:0", "transcript:0"];

function check(value: unknown, code = "RESTORE_INVALID_ROW"): asserts value {
  if (!value)
    throw fail(code, "Cloud v3 portable restore could not be verified");
}

const refused = () =>
  fail(
    "RESTORE_INVALID_ROW",
    "Cloud v3 portable restore could not be verified",
  );

function decode(text: unknown): unknown {
  check(typeof text === "string" && withinRestoreBudget(text));
  return parse(text);
}

function parse(text: string): unknown {
  try {
    return parseRestoreJson(text);
  } catch {
    check(false);
  }
}

function manifestOf(seal: Seal, value: unknown, pin: unknown) {
  check(isObject(value));
  const { format, head, eventWatermark, recordFloor, publicDigest, pages } =
    value;
  check(
    Object.keys(value).length === 8 &&
      format === "forge-cloud-portable/4" &&
      [head, eventWatermark, recordFloor].every(isNat) &&
      isDigest(publicDigest) &&
      typeof value.source === "string" &&
      value.source !== "" &&
      typeof value.mac === "string" &&
      Array.isArray(pages) &&
      pages.length === IDS.length,
  );
  pages.forEach((member: unknown, i) =>
    check(
      isObject(member) &&
        Object.keys(member).length === 3 &&
        member.id === IDS[i] &&
        isNat(member.bytes) &&
        member.bytes <= PAGE_BYTES &&
        isDigest(member.hash),
    ),
  );
  const verified = authenticateManifest(
    seal,
    value as unknown as Manifest,
    pin,
  );
  check(verified);
  return verified;
}

const matches = (
  body: unknown,
  { bytes, hash }: { bytes: number; hash: string },
): body is string =>
  typeof body === "string" &&
  Buffer.byteLength(body) === bytes &&
  digestBytes(body) === hash;

export const hasV3Restore = (db: SqlDatabase) =>
  db.get(TABLE_PROBE, [STAGE]) !== undefined;

function watch(db: SqlDatabase) {
  const watched: SqlDatabase & { called: boolean } = {
    called: false,
    exec: (...args) => call(() => db.exec(...args)),
    run: (...args) => call(() => db.run(...args)),
    get: (...args) => call(() => db.get(...args)),
    all: (...args) => call(() => db.all(...args)),
    transaction: (body) => call(() => db.transaction(body)),
  };
  function call<T>(run: () => T) {
    watched.called = true;
    return run();
  }
  return watched;
}

function verify(
  db: SqlDatabase,
  seal: Seal,
  manifest: VerifiedManifest,
  admit: AdmitLeaseRequest,
  table: string,
  note?: (error: unknown) => void,
) {
  let sql: ReturnType<typeof watch> | undefined;
  try {
    const pages = storedPages(db, table);
    sql = watch(db);
    check(pages.size === IDS.length);
    for (const member of manifest.members)
      check(matches(pages.get(member.id), member));
    const portableTranscript = pages.get("transcript:0")!;
    const image = recoverV3(sql, seal, { admit, manifest, portableTranscript });
    const expected = inventory(image, new Map());
    reconcile(pages, expected, portableTranscript);
    check(image.head === manifest.head);
    check(image.eventWatermark === manifest.eventWatermark);
    check(image.recordFloor === manifest.recordFloor);
    check(digestProjection(expected) === manifest.publicDigest);
    return { pages, expected, image };
  } catch (error) {
    let out = error;
    if (
      (error instanceof ForgeFailure && error.error.code === "UNAVAILABLE") ||
      ((error instanceof TypeError || error instanceof RangeError) &&
        !storageFailure(error))
    )
      out = refused();
    if (sql?.called === false && error instanceof ForgeFailure) note?.(out);
    throw out;
  }
}

export function restoreV3Page(
  db: SqlDatabase,
  seal: Seal,
  text: string,
  pin: string | null,
  legacy: boolean,
  admit: AdmitLeaseRequest,
) {
  const input = decode(text);
  check(isObject(input));
  const { page, id, body } = input;
  check(isNat(page) && typeof id === "string" && id === IDS[page]);
  check(Object.keys(input).length === (page === 0 ? 4 : 3));
  const request = digestBytes(text);
  let eligible: unknown;
  const restore = () => {
    rejectOldCommits(db);
    const restored =
      hasV3Root(db) && readV3Root(db, seal).activationDigest !== undefined;
    check(
      !legacy && (restored || !hasPriorV3RestoreState(db)),
      "RESTORE_TARGET_NOT_EMPTY",
    );
    const table = restored ? PAGES : STAGE;
    const staged = hasV3Restore(db)
      ? db.all(
          `SELECT id, request, manifest, pin, verified FROM ${STAGE} ORDER BY id LIMIT 4`,
        )
      : [];
    const prior = staged[page];
    if (restored) check(staged.length === IDS.length);
    check(prior || (!restored && page === staged.length));
    const first = staged[0];
    const manifest = first
      ? manifestOf(seal, decode(first.manifest), first.pin)
      : manifestOf(seal, input.manifest, pin);
    check(matches(body, manifest.members[page]!));
    const verified = page === IDS.length - 1;
    const finish = () => {
      let checked: ReadonlyMap<string, string> | undefined;
      if (verified) {
        const { pages, expected, image } = verify(
          db,
          seal,
          manifest,
          admit,
          table,
          restored ? undefined : (error) => (eligible = error),
        );
        checked = pages;
        if (!restored) {
          const projection = roster(pages, expected, image.head);
          const sql = watch(db);
          const { publicDigest } = manifest;
          try {
            activateV3(sql, seal, image, projection, pages, publicDigest);
          } catch (error) {
            const code = error instanceof ForgeFailure && error.error.code;
            if (!sql.called && code === "RESTORE_TOO_LARGE") eligible = error;
            throw error;
          }
          db.run(`UPDATE ${STAGE} SET body=''`);
        }
      }
      if (restored || verified) {
        const { usage } = recoverV3(
          db,
          seal,
          archivedCheck(db, {
            admit,
            failure: refused,
            pages: checked,
          }),
        );
        if (
          !restored &&
          Object.values(usage).some((bytes) => bytes > PAGE_BYTES)
        )
          throw (eligible = fail(
            "STORAGE_LIMIT_EXCEEDED",
            "The restored history is too large to activate",
          ));
      }
    };
    if (prior) {
      check(prior.id === id && prior.request === request && prior.pin === pin);
      const saved = db.get(
        `SELECT body FROM ${table} WHERE id=? AND length(CAST(body AS BLOB))<=${PAGE_BYTES}`,
        [id],
      );
      check(saved?.body === body && prior.verified === Number(verified));
      finish();
      return { page, verified: prior.verified === 1 };
    }
    if (page === 0)
      db.exec(
        `CREATE TABLE ${STAGE} (id TEXT PRIMARY KEY, body TEXT NOT NULL, request TEXT NOT NULL, manifest TEXT, pin TEXT, verified INTEGER NOT NULL) WITHOUT ROWID`,
      );
    db.run(`INSERT INTO ${STAGE} VALUES (?, ?, ?, ?, ?, ?)`, [
      id,
      body,
      request,
      page === 0 ? canonicalJson(input.manifest) : null,
      pin,
      Number(verified),
    ]);
    finish();
    return { page, verified };
  };
  try {
    return db.transaction(restore);
  } catch (error) {
    if (eligible === undefined || error !== eligible) throw error;
    try {
      db.transaction(() => {
        if (!hasV3Root(db)) db.exec("DROP TABLE IF EXISTS " + STAGE);
      });
    } catch {
      throw error;
    }
    throw error;
  }
}
