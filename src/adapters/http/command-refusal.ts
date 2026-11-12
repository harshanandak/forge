// The checked details of a refused typed command. Only a lease, a blocker list or one repair template
// is kept, each closed and checked as a whole; the server's words and every other field are dropped.
import {
  validateItemId,
  validateLeaseHolder,
  validateLeaseRecord,
} from "../../generated/validators.ts";
import type { LeaseConflict, LeaseHolder } from "../../generated/types.ts";

export interface Blocker {
  readonly id: string;
  readonly holder?: LeaseHolder;
  readonly holderUnverified?: true;
}
export interface RefusalDetails {
  readonly lease?: LeaseConflict;
  readonly observed?: { readonly blockers: readonly Blocker[] };
  readonly repair?: string;
}

const QUALIFIED = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d+)$/i;
const DEVICE_TOKEN = /fct_[0-9a-f]{16}\.[A-Za-z0-9_-]{43}/;
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const repairFor = (shown: string) =>
  `forge attempt select ${shown} --attempt <attempt-id> --reason "<why>"; or forge attempt select ${shown} --none --reason "<why>"`;

/** Conflict details the server named: just the subject, or a full lease for that subject. */
export function conflictOf(
  value: unknown,
  subject: string,
  command = false,
  full = false,
): LeaseConflict | undefined {
  const found = record(value);
  if (found?.subject !== subject) return undefined;
  if (Object.keys(found).length === 1) return full ? undefined : { subject };
  const checked = validateLeaseRecord(found);
  if (!checked.ok || checked.value.releasedAt !== undefined) return undefined;
  if (command && !Number.isSafeInteger(checked.value.generation))
    return undefined;
  const { holder, generation, expiresAt } = checked.value;
  return { subject, holder, generation, expiresAt };
}

function blockersOf(value: unknown): readonly Blocker[] | undefined {
  const observed = record(value);
  const list = observed?.blockers;
  if (Object.keys(observed ?? {}).length !== 1) return undefined;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const edges: Blocker[] = [];
  for (const item of list) {
    const edge = record(item);
    const id = edge?.id;
    if (edge === undefined || typeof id !== "string") return undefined;
    if (!validateItemId(id).ok || !QUALIFIED.test(id)) return undefined;
    if (Object.keys(edge).length === 1) {
      edges.push({ id });
      continue;
    }
    const holder = validateLeaseHolder(edge.holder);
    if (!holder.ok || edge.holderUnverified !== true) return undefined;
    if (Object.keys(edge).length !== 3) return undefined;
    edges.push({ id, holder: holder.value, holderUnverified: true });
  }
  return edges;
}

/** The one competing-close repair, rebuilt locally from its shown id, whose number is the requested one. */
function closeRepair(value: unknown, suffix: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const shown = /^forge attempt select (\S+) /.exec(value)?.[1];
  return shown !== undefined &&
    QUALIFIED.exec(shown)?.[2] === suffix &&
    value === repairFor(shown)
    ? repairFor(shown)
    : undefined;
}

function* strings(value: unknown): Generator<string> {
  if (typeof value === "string") yield value;
  else if (typeof value === "object" && value !== null)
    for (const child of Object.values(value)) yield* strings(child);
}
/** No admitted string holds the presented token, any device token or a control character. */
const clean = (details: RefusalDetails, token: string) =>
  [...strings(details)].every(
    (text) =>
      !text.includes(token) &&
      !DEVICE_TOKEN.test(text) &&
      !/\p{Cc}/u.test(text),
  );

/** The details this code carries for this call, or undefined when what the server sent is not usable. */
export function refusalDetails(
  code: string,
  call: { readonly op: string; readonly input: unknown },
  error: Record<string, unknown>,
  token: string,
): RefusalDetails | undefined {
  const id = record(call.input)?.id;
  const suffix = typeof id === "string" ? QUALIFIED.exec(id)?.[2] : undefined;
  let details: RefusalDetails = {};
  if (code.startsWith("LEASE_")) {
    if (suffix === undefined) return undefined;
    const lease = conflictOf(
      error.lease,
      `issue:work-${suffix}`,
      true,
      code === "LEASE_HELD",
    );
    if (lease === undefined) return undefined;
    details = { lease };
  } else if (code === "CLAIM_BLOCKED" && call.op === "issue.claim") {
    const blockers = blockersOf(error.observed);
    if (blockers === undefined) return undefined;
    details = { observed: { blockers } };
  } else if (code === "INPUT_CONFLICT" && call.op === "issue.close") {
    const repair =
      suffix === undefined ? undefined : closeRepair(error.repair, suffix);
    if (repair !== undefined) details = { repair };
  }
  return clean(details, token) ? details : undefined;
}
