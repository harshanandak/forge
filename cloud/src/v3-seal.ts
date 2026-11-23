import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ForgeFailure } from "../../src/contract/failure.ts";
import {
  canonicalJson,
  digestBytes,
  isObject,
} from "../../src/core/config/pointer.ts";
import { isDigest, isNat } from "./v3-authority.ts";

export interface Key {
  readonly id: string;
  readonly bytes: Buffer;
}
export interface Seal {
  readonly scope: string;
  readonly keys: readonly [Key, ...Key[]];
}

export const bounded = (column: string) =>
  `CASE WHEN length(CAST(${column} AS BLOB))=81 THEN ${column} END AS ${column}`;
export const BOUNDED_MAC = bounded("mac");

const SECRET = /^[A-Za-z0-9_-]{43,512}$/;
const ENVELOPE = /^([0-9a-f]{16})\.([0-9a-f]{64})$/;

function keyOf(secret: unknown): Key | undefined {
  if (
    typeof secret !== "string" ||
    !SECRET.test(secret) ||
    secret.length % 4 === 1
  )
    return undefined;
  const bytes = Buffer.from(secret, "base64url");
  return bytes.length < 32
    ? undefined
    : {
        id: createHash("sha256").update(bytes).digest("hex").slice(0, 16),
        bytes,
      };
}

export function ringOf(first: Key, second?: Key): Seal["keys"] | undefined {
  if (!second || second.bytes.equals(first.bytes)) return [first];
  return second.id === first.id ? undefined : [first, second];
}

export function sealKeys(
  current: unknown,
  previous?: unknown,
): Seal["keys"] | undefined {
  const first = keyOf(current);
  const second = previous === undefined ? undefined : keyOf(previous);
  return first && (previous === undefined || second)
    ? ringOf(first, second)
    : undefined;
}

export function sealOf(
  env: Readonly<Record<string, unknown>>,
  id: { toString(): string } | undefined,
): Seal {
  const keys = sealKeys(env.V3_SEAL_KEY, env.V3_SEAL_KEY_PREVIOUS);
  const scope = id?.toString();
  if (!keys || !scope)
    throw new ForgeFailure({
      code: "UNAVAILABLE",
      message: "Cloud v3 seal is not configured",
      retry: "never",
    });
  return { scope, keys };
}

const tag = ({ bytes }: Key, parts: readonly unknown[]) =>
  createHmac("sha256", bytes).update(canonicalJson(parts)).digest();

const sealed = ({ keys: [key] }: Seal, parts: readonly unknown[]) =>
  `${key.id}.${tag(key, parts).toString("hex")}`;

function authentic(seal: Seal, parts: readonly unknown[], mac: unknown) {
  const found = typeof mac === "string" ? ENVELOPE.exec(mac) : null;
  const key = found && seal.keys.find(({ id }) => id === found[1]);
  if (!key) return false;
  const expected = tag(key, parts);
  const given = Buffer.from(found[2]!, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const rowParts = (
  { scope }: Seal,
  incarnation: unknown,
  sequence: number,
  body: string,
) => ["forge/v3/commit/1", scope, incarnation, sequence, body];

const rootParts = ({ scope }: Seal, body: string) => [
  "forge/v3/root/1",
  scope,
  body,
];

export const signRow = (
  seal: Seal,
  incarnation: unknown,
  sequence: number,
  body: string,
) => sealed(seal, rowParts(seal, incarnation, sequence, body));

export const verifyRow = (
  seal: Seal,
  incarnation: unknown,
  sequence: unknown,
  body: unknown,
  mac: unknown,
): boolean =>
  typeof body === "string" &&
  typeof sequence === "number" &&
  authentic(seal, rowParts(seal, incarnation, sequence, body), mac);

declare const verified: unique symbol;
export interface Member {
  readonly id: string;
  readonly bytes: number;
  readonly hash: string;
}
export interface Manifest {
  readonly format: string;
  readonly head: number;
  readonly eventWatermark: number;
  readonly recordFloor: number;
  readonly publicDigest: string;
  readonly pages: readonly Member[];
  readonly source: string;
  readonly mac: string;
}
export interface VerifiedManifest {
  readonly [verified]: true;
  readonly head: number;
  readonly eventWatermark: number;
  readonly recordFloor: number;
  readonly publicDigest: string;
  readonly members: readonly Member[];
  readonly transcript: Member;
}
const issued = new WeakSet<object>();

const manifestParts = ({ mac: _mac, ...manifest }: Manifest) => [
  "forge/v3/manifest/1",
  manifest,
];

export const verifyManifest = (seal: Seal, manifest: Manifest) =>
  authentic(seal, manifestParts(manifest), manifest.mac);

export function authenticateManifest(
  seal: Seal,
  manifest: Manifest,
  pin: unknown,
): VerifiedManifest | undefined {
  const text = canonicalJson(manifest);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    digestBytes(text) !== pin ||
    !isObject(snapshot) ||
    !Array.isArray(snapshot.pages) ||
    !snapshot.pages.every(isObject) ||
    !verifyManifest(seal, snapshot as unknown as Manifest)
  )
    return undefined;
  const members = snapshot.pages.map(({ id, bytes, hash }) =>
    Object.freeze({ id, bytes, hash }),
  );
  const found = members.filter(({ id }) => id === "transcript:0");
  if (found.length !== 1) return undefined;
  const { bytes, hash } = found[0]!;
  if (!isNat(bytes) || !isDigest(hash)) return undefined;
  const value = Object.freeze({
    head: snapshot.head,
    eventWatermark: snapshot.eventWatermark,
    recordFloor: snapshot.recordFloor,
    publicDigest: snapshot.publicDigest,
    members: Object.freeze(members),
    transcript: found[0]!,
  }) as unknown as VerifiedManifest;
  issued.add(value);
  return value;
}

export const isVerifiedManifest = (value: unknown): value is VerifiedManifest =>
  typeof value === "object" && value !== null && issued.has(value);

export interface TokenFields {
  readonly id: string;
  readonly hash: string;
  readonly device: string;
  readonly session: string;
  readonly agent: string | null;
  readonly harness: string | null;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
}

const tokenParts = ({ scope }: Seal, t: TokenFields) => [
  "forge/v3/token/1",
  scope,
  t.id,
  t.hash,
  t.device,
  t.session,
  t.agent,
  t.harness,
  t.expiresAt,
  t.revokedAt,
];

export const signToken = (seal: Seal, token: TokenFields) =>
  sealed(seal, tokenParts(seal, token));

export const verifyToken = (seal: Seal, token: TokenFields, mac: unknown) =>
  authentic(seal, tokenParts(seal, token), mac);

export interface ApprovalFields {
  readonly id: string;
  readonly project: string;
  readonly incarnation: string;
  readonly restoreEpoch: string;
  readonly activationDigest: string;
  readonly operation: "restore.promote";
  readonly operationDigest: string;
  readonly tokenId: string;
  readonly device: string;
  readonly session: string;
  readonly controlEpoch: 1;
  readonly policyIdentity: string;
  readonly status: "pending" | "approved" | "denied" | "spent";
  readonly requestedAt: number;
  readonly expiresAt: number;
  readonly decidedAt: number | null;
  readonly deciderIssuer: string | null;
  readonly deciderSubject: string | null;
  readonly spentAt: number | null;
}

const approvalParts = ({ scope }: Seal, approval: ApprovalFields) => [
  "forge/v3/approval/1",
  scope,
  approval.id,
  approval.project,
  approval.incarnation,
  approval.restoreEpoch,
  approval.activationDigest,
  approval.operation,
  approval.operationDigest,
  approval.tokenId,
  approval.device,
  approval.session,
  approval.controlEpoch,
  approval.policyIdentity,
  approval.status,
  approval.requestedAt,
  approval.expiresAt,
  approval.decidedAt,
  approval.deciderIssuer,
  approval.deciderSubject,
  approval.spentAt,
];

export const signApproval = (seal: Seal, approval: ApprovalFields) =>
  sealed(seal, approvalParts(seal, approval));

export const verifyApproval = (
  seal: Seal,
  approval: ApprovalFields,
  mac: unknown,
) => authentic(seal, approvalParts(seal, approval), mac);

export const signRoot = (seal: Seal, body: string) =>
  sealed(seal, rootParts(seal, body));

export const verifyRoot = (seal: Seal, body: string, envelope: unknown) =>
  authentic(seal, rootParts(seal, body), envelope);
