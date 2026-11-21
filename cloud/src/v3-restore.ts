import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  digestValue,
  isObject,
} from "../../src/core/config/pointer.ts";
import {
  parseRestoreJson,
  withinRestoreBudget,
} from "../../src/core/state/restore-json.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import type { AdmitLeaseRequest } from "./project.ts";
import { TABLE_PROBE } from "./store.ts";
import { isDigest, isNat } from "./v3-authority.ts";
import {
  digestProjection,
  inventory,
  PAGE_BYTES,
  reconcile,
  storedPages,
} from "./v3-checkpoint.ts";
import { fail, hasPriorV3RestoreState, recoverV3 } from "./v3-store.ts";

const STAGE = "cloud_v3_restore";
const IDS = ["directory:0", "snapshot:0", "transcript:0"];

function check(value: unknown, code = "RESTORE_INVALID_ROW"): asserts value {
  if (!value)
    throw fail(code, "Cloud v3 portable restore could not be verified");
}

function decode(text: unknown): unknown {
  check(typeof text === "string" && withinRestoreBudget(text));
  try {
    return parseRestoreJson(text);
  } catch {
    check(false);
  }
}

function manifestOf(value: unknown, pin: unknown) {
  check(isObject(value));
  const { format, head, eventWatermark, recordFloor, publicDigest, pages } =
    value;
  check(
    Object.keys(value).length === 6 &&
      format === "forge-cloud-portable/3" &&
      [head, eventWatermark, recordFloor].every(isNat) &&
      isDigest(publicDigest) &&
      Array.isArray(pages) &&
      pages.length === IDS.length,
  );
  const members = pages.map((member: unknown, i) => {
    check(
      isObject(member) &&
        Object.keys(member).length === 3 &&
        member.id === IDS[i] &&
        isNat(member.bytes) &&
        member.bytes <= PAGE_BYTES &&
        isDigest(member.hash),
    );
    return { id: IDS[i]!, bytes: member.bytes, hash: member.hash };
  });
  check(digestValue(value) === pin);
  return { head, eventWatermark, recordFloor, publicDigest, members };
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

function verify(
  db: SqlDatabase,
  manifest: ReturnType<typeof manifestOf>,
  admit: AdmitLeaseRequest,
) {
  try {
    const pages = storedPages(db, STAGE);
    check(pages.size === IDS.length);
    for (const member of manifest.members)
      check(matches(pages.get(member.id), member));
    const portableTranscript = pages.get("transcript:0")!;
    const image = recoverV3(db, { admit, portableTranscript });
    const expected = inventory(image, new Map());
    reconcile(pages, expected, portableTranscript);
    check(image.head === manifest.head);
    check(image.eventWatermark === manifest.eventWatermark);
    check(image.recordFloor === manifest.recordFloor);
    check(digestProjection(expected) === manifest.publicDigest);
  } catch (error) {
    if (error instanceof ForgeFailure && error.error.code === "UNAVAILABLE")
      check(false);
    throw error;
  }
}

export function restoreV3Page(
  db: SqlDatabase,
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
  return db.transaction(() => {
    check(!legacy && !hasPriorV3RestoreState(db), "RESTORE_TARGET_NOT_EMPTY");
    const staged = hasV3Restore(db)
      ? db.all(
          `SELECT id, request, manifest, pin, verified FROM ${STAGE} ORDER BY id LIMIT 4`,
        )
      : [];
    const prior = staged[page];
    check(prior || page === staged.length);
    const first = staged[0];
    const manifest = first
      ? manifestOf(decode(first.manifest), first.pin)
      : manifestOf(input.manifest, pin);
    check(matches(body, manifest.members[page]!));
    const verified = page === IDS.length - 1;
    if (prior) {
      check(prior.id === id && prior.request === request && prior.pin === pin);
      const saved = db.get(
        `SELECT body FROM ${STAGE} WHERE id=? AND length(CAST(body AS BLOB))<=${PAGE_BYTES}`,
        [id],
      );
      check(saved?.body === body && prior.verified === Number(verified));
      if (verified) verify(db, manifest, admit);
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
    if (verified) verify(db, manifest, admit);
    return { page, verified };
  });
}
