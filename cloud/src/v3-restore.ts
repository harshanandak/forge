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
import { inventory, reconcile } from "./v3-checkpoint.ts";
import { recoverV3, requireFreshV3 } from "./v3-store.ts";

const STAGE = "cloud_v3_restore";
const PAGE_BYTES = 256 * 1024;
const IDS = ["directory:0", "snapshot:0", "transcript:0"];

const invalid = () =>
  new ForgeFailure({
    code: "RESTORE_INVALID_ROW",
    message: "Cloud v3 portable restore could not be verified",
    retry: "never",
  });

function check(value: unknown): asserts value {
  if (!value) throw invalid();
}

function decode(text: string): unknown {
  check(withinRestoreBudget(text));
  try {
    return parseRestoreJson(text);
  } catch {
    throw invalid();
  }
}

function manifestOf(value: unknown, pin: unknown) {
  check(isObject(value));
  const { format, head, eventWatermark, recordFloor, publicDigest, pages } =
    value;
  check(
    Object.keys(value).length === 6 &&
      format === "forge-cloud-portable/3" &&
      isNat(head) &&
      isNat(eventWatermark) &&
      isNat(recordFloor) &&
      isDigest(publicDigest) &&
      Array.isArray(pages) &&
      pages.length === IDS.length,
  );
  const roster = pages.map((member: unknown, i) => {
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
  return { head, eventWatermark, recordFloor, publicDigest, roster };
}

function matches(
  body: unknown,
  { bytes, hash }: { bytes: number; hash: string },
): body is string {
  return (
    typeof body === "string" &&
    Buffer.byteLength(body) === bytes &&
    digestBytes(body) === hash
  );
}

export const hasV3Restore = (db: SqlDatabase) =>
  db.get(TABLE_PROBE, [STAGE]) !== undefined;

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
  check(
    isNat(page) &&
      page < IDS.length &&
      id === IDS[page] &&
      Object.keys(input).length === (page === 0 ? 4 : 3),
  );
  const request = digestBytes(text);
  return db.transaction(() => {
    requireFreshV3(db, legacy, true);
    const staged = hasV3Restore(db)
      ? db.all(
          `SELECT page, request, manifest, pin, verified FROM ${STAGE} ORDER BY page LIMIT 4`,
        )
      : [];
    const first = staged[0];
    const manifest =
      page === 0
        ? manifestOf(input.manifest, pin)
        : manifestOf(decode(String(first?.manifest)), first?.pin);
    check(matches(body, manifest.roster[page]!));
    const prior = staged[page];
    if (prior !== undefined) {
      check(
        prior.page === page &&
          prior.request === request &&
          (page !== 0 || prior.pin === pin),
      );
      return { page, verified: prior.verified === 1 };
    }
    check(page === staged.length);
    if (page === 0)
      db.exec(
        `CREATE TABLE ${STAGE} (page INTEGER PRIMARY KEY, request TEXT NOT NULL, body TEXT NOT NULL, manifest TEXT, pin TEXT, verified INTEGER NOT NULL)`,
      );
    const verified = page === IDS.length - 1;
    db.run(`INSERT INTO ${STAGE} VALUES (?, ?, ?, ?, ?, ?)`, [
      page,
      request,
      body,
      page === 0 ? canonicalJson(input.manifest) : null,
      pin,
      Number(verified),
    ]);
    if (verified) {
      const rows = db.all(
        `SELECT page, body FROM ${STAGE} ORDER BY page LIMIT 4`,
      );
      check(rows.length === IDS.length);
      const pages = new Map(
        rows.map(({ page, body }, i) => {
          const member = manifest.roster[i]!;
          check(page === i && matches(body, member));
          return [member.id, body];
        }),
      );
      const transcript = pages.get("transcript:0")!;
      try {
        const image = recoverV3(db, { admit, transcript });
        check(
          image.head === manifest.head &&
            image.eventWatermark === manifest.eventWatermark &&
            image.recordFloor === manifest.recordFloor &&
            reconcile(pages, inventory(image, new Map()), transcript) ===
              manifest.publicDigest,
        );
      } catch (error) {
        if (error instanceof ForgeFailure && error.error.code === "UNAVAILABLE")
          throw invalid();
        throw error;
      }
    }
    return { page, verified };
  });
}
