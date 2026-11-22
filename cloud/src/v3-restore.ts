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
import { isDigest, isNat, sealedAuthorityValid } from "./v3-authority.ts";
import {
  digestProjection,
  inventory,
  PAGE_BYTES,
  reconcile,
  roster,
  storedPages,
} from "./v3-checkpoint.ts";
import type { Seal } from "./v3-seal.ts";
import {
  activateV3,
  fail,
  hasPriorV3RestoreState,
  hasV3Root,
  PAGES,
  readV3Root,
  recoverV3,
  type V3Image,
  withinDepth,
} from "./v3-store.ts";

const STAGE = "cloud_v3_restore";
const IDS = ["directory:0", "snapshot:0", "transcript:0"];

function check(value: unknown, code = "RESTORE_INVALID_ROW"): asserts value {
  if (!value)
    throw fail(code, "Cloud v3 portable restore could not be verified");
}

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

function completeRefusals(image: V3Image, pages: ReadonlyMap<string, string>) {
  const directory = parse(pages.get("directory:0")!);
  check(Array.isArray(directory));
  const entries = new Map(
    (directory as unknown[])
      .filter(isObject)
      .filter((entry) => entry.collection === "outcome")
      .map((entry) => [entry.key, entry]),
  );
  const snapshot = Buffer.from(pages.get("snapshot:0")!);
  for (const [key, slot] of image.entries.outcome) {
    if (!("value" in slot) || !isObject(slot.value)) continue;
    const { outcome } = slot.value;
    if (
      !isObject(outcome) ||
      outcome.status === "ok" ||
      !isDigest(outcome.resultDigest)
    )
      continue;
    const { offset, length } = entries.get(key) ?? {};
    check(isNat(offset) && isNat(length) && offset + length <= snapshot.length);
    const saved = parse(snapshot.subarray(offset, offset + length).toString());
    check(isObject(saved) && isObject(saved.outcome) && withinDepth(saved));
    const { result, ...receipt } = saved.outcome;
    check(
      sealedAuthorityValid("outcome", key, saved) &&
        canonicalJson({
          ...saved,
          outcome: { ...receipt, resultDigest: digestValue(result) },
        }) === canonicalJson(slot.value),
    );
    image.entries.outcome.set(key, { value: saved });
  }
}

function verify(
  db: SqlDatabase,
  seal: Seal,
  manifest: ReturnType<typeof manifestOf>,
  admit: AdmitLeaseRequest,
  table: string,
) {
  try {
    const pages = storedPages(db, table);
    check(pages.size === IDS.length);
    for (const member of manifest.members)
      check(matches(pages.get(member.id), member));
    const portableTranscript = pages.get("transcript:0")!;
    const image = recoverV3(db, seal, { admit, portableTranscript });
    completeRefusals(image, pages);
    const expected = inventory(image, new Map());
    reconcile(pages, expected, portableTranscript);
    check(image.head === manifest.head);
    check(image.eventWatermark === manifest.eventWatermark);
    check(image.recordFloor === manifest.recordFloor);
    check(digestProjection(expected) === manifest.publicDigest);
    return { pages, expected, image };
  } catch (error) {
    if (
      (error instanceof ForgeFailure && error.error.code === "UNAVAILABLE") ||
      error instanceof TypeError ||
      error instanceof RangeError
    )
      check(false);
    throw error;
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
  return db.transaction(() => {
    const restored =
      hasV3Root(db) && readV3Root(db).activationDigest !== undefined;
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
      ? manifestOf(decode(first.manifest), first.pin)
      : manifestOf(input.manifest, pin);
    check(matches(body, manifest.members[page]!));
    const verified = page === IDS.length - 1;
    const finish = () => {
      if (verified) {
        const { pages, expected, image } = verify(
          db,
          seal,
          manifest,
          admit,
          table,
        );
        if (!restored) {
          const projection = roster(pages, expected, image.head);
          activateV3(db, seal, image, projection, pages, manifest.publicDigest);
          db.run(`UPDATE ${STAGE} SET body=''`);
        }
      }
      if (restored || verified) recoverV3(db, seal);
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
  });
}
