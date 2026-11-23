import { digestValue } from "../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { storageFailure } from "./storage-failure.ts";
import { TABLE_PROBE } from "./store.ts";
import { isDigest } from "./v3-authority.ts";
import {
  type ApprovalFields,
  type Seal,
  signApproval,
  type TokenFields,
  verifyApproval,
} from "./v3-seal.ts";
import {
  fail,
  readV3GlobalControl,
  readV3Root,
  unavailable,
  V3_APPROVALS,
  type V3Image,
} from "./v3-store.ts";

const LIFETIME = 600_000;
const MAX_APPROVALS = 8;
const LAST_TIME = 8_640_000_000_000_000;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION = "restore.promote";
const CREATE = `CREATE TABLE IF NOT EXISTS ${V3_APPROVALS} (id TEXT PRIMARY KEY, project TEXT NOT NULL, incarnation TEXT NOT NULL, restore_epoch TEXT NOT NULL, activation_digest TEXT NOT NULL, operation TEXT NOT NULL, operation_digest TEXT NOT NULL, token_id TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, control_epoch INTEGER NOT NULL, policy_identity TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decider_issuer TEXT, decider_subject TEXT, spent_at INTEGER, mac TEXT NOT NULL) WITHOUT ROWID`;

const approvalText = (name: string, min = 1, max = 8192, optional = false) =>
  [
    name,
    `(${optional ? `${name} IS NULL OR ` : ""}(typeof(${name})='text' AND length(CAST(${name} AS BLOB)) BETWEEN ${min} AND ${max}))`,
  ] as const;
const approvalTime = (name: string, optional = false) =>
  [
    name,
    `(${optional ? `${name} IS NULL OR ` : ""}(typeof(${name})='integer' AND ${name} BETWEEN 0 AND ${LAST_TIME}))`,
  ] as const;

type StoredApproval = ApprovalFields & { mac: string };
const SHAPES = {
  id: approvalText("id", 36, 36),
  project: approvalText("project"),
  incarnation: approvalText("incarnation"),
  restoreEpoch: approvalText("restore_epoch"),
  activationDigest: approvalText("activation_digest", 71, 71),
  operation: approvalText("operation"),
  operationDigest: approvalText("operation_digest", 71, 71),
  tokenId: approvalText("token_id", 16, 16),
  device: approvalText("device"),
  session: approvalText("session"),
  controlEpoch: approvalTime("control_epoch"),
  policyIdentity: approvalText("policy_identity", 71, 71),
  status: approvalText("status"),
  requestedAt: approvalTime("requested_at"),
  expiresAt: approvalTime("expires_at"),
  decidedAt: approvalTime("decided_at", true),
  deciderIssuer: approvalText("decider_issuer", 1, 8192, true),
  deciderSubject: approvalText("decider_subject", 1, 8192, true),
  spentAt: approvalTime("spent_at", true),
  mac: approvalText("mac", 81, 81),
} satisfies Record<keyof StoredApproval, readonly [string, string]>;
const COLUMNS = Object.entries(SHAPES) as [
  keyof StoredApproval,
  readonly [string, string],
][];
const IDS = `SELECT CASE WHEN ${SHAPES.id[1]} THEN id END AS id FROM ${V3_APPROVALS} ORDER BY ${V3_APPROVALS}.id LIMIT ${MAX_APPROVALS + 1}`;
const READ = `SELECT (${COLUMNS.map(([, [, guard]]) => guard).join(" AND ")}) AS shape_ok, ${COLUMNS.map(([field, [column, guard]]) => `CASE WHEN ${guard} THEN ${column} END AS ${field}`).join(", ")} FROM ${V3_APPROVALS} WHERE id=?`;
const INSERT = `INSERT INTO ${V3_APPROVALS} (${COLUMNS.map(([, [column]]) => column).join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`;
const approvalUnavailable = () =>
  fail("UNAVAILABLE", "Cloud v3 approval storage is unavailable");

function coherentApproval(row: ApprovalFields): boolean {
  const {
    status,
    requestedAt,
    expiresAt,
    decidedAt,
    deciderIssuer,
    deciderSubject,
    spentAt,
  } = row;
  if (expiresAt !== requestedAt + LIFETIME) return false;
  if (status === "pending")
    return (
      decidedAt === null &&
      deciderIssuer === null &&
      deciderSubject === null &&
      spentAt === null
    );
  if (
    decidedAt === null ||
    decidedAt < requestedAt ||
    deciderIssuer === null ||
    deciderSubject === null
  )
    return false;
  if (status === "spent")
    return spentAt !== null && decidedAt <= spentAt && spentAt < expiresAt;
  return (
    (status === "approved" || status === "denied") &&
    decidedAt < expiresAt &&
    spentAt === null
  );
}

function readApproval(db: SqlDatabase, seal: Seal, id: string): StoredApproval {
  const row = db.get(READ, [id]);
  if (row?.shape_ok !== 1 || row.id !== id || !UUID.test(id))
    throw approvalUnavailable();
  const approval = row as unknown as StoredApproval;
  if (
    approval.operation !== OPERATION ||
    approval.controlEpoch !== 1 ||
    !isDigest(approval.activationDigest) ||
    !isDigest(approval.policyIdentity) ||
    !/^[0-9a-f]{16}$/.test(approval.tokenId) ||
    approval.operationDigest !==
      digestValue([OPERATION, approval.activationDigest]) ||
    !coherentApproval(approval) ||
    !verifyApproval(seal, approval, approval.mac)
  )
    throw approvalUnavailable();
  return approval;
}

function approvalInventory(db: SqlDatabase, seal: Seal): StoredApproval[] {
  try {
    if (!db.get(TABLE_PROBE, [V3_APPROVALS])) return [];
    const ids = db.all(IDS).map(({ id }) => id);
    if (ids.length > MAX_APPROVALS || new Set(ids).size !== ids.length)
      throw approvalUnavailable();
    return ids.map((id) => {
      if (typeof id !== "string") throw approvalUnavailable();
      return readApproval(db, seal, id);
    });
  } catch (error) {
    throw storageFailure(error, true) ?? approvalUnavailable();
  }
}

export function requestV3Approval(
  db: SqlDatabase,
  seal: Seal,
  project: string,
  token: Pick<TokenFields, "id" | "device" | "session">,
  policyIdentity: string,
  now: number,
  image: () => V3Image,
) {
  return db.transaction(() => {
    const root = readV3Root(db, seal);
    const current = image();
    const { activationDigest } = root;
    if (activationDigest === undefined)
      throw fail(
        "INPUT_CONFLICT",
        "The restored project is not awaiting promotion",
      );
    const control = readV3GlobalControl(db, current);
    if (control.incarnation !== root.incarnation || control.epoch !== 1)
      throw unavailable();
    const rows = approvalInventory(db, seal);
    const expired = rows.filter((row) => row.expiresAt <= now);
    if (rows.length - expired.length >= MAX_APPROVALS)
      throw fail("INPUT_CONFLICT", "Too many open promotion requests");
    db.exec(CREATE);
    for (const { id, mac } of expired) {
      if (
        db.run(`DELETE FROM ${V3_APPROVALS} WHERE id=? AND mac=?`, [id, mac])
          .changes !== 1
      )
        throw approvalUnavailable();
    }
    const row: ApprovalFields = {
      id: crypto.randomUUID(),
      project,
      incarnation: root.incarnation,
      restoreEpoch: root.restoreEpoch as string,
      activationDigest,
      operation: OPERATION,
      operationDigest: digestValue([OPERATION, activationDigest]),
      tokenId: token.id,
      device: token.device,
      session: token.session,
      controlEpoch: 1,
      policyIdentity,
      status: "pending",
      requestedAt: now,
      expiresAt: now + LIFETIME,
      decidedAt: null,
      deciderIssuer: null,
      deciderSubject: null,
      spentAt: null,
    };
    const stored = { ...row, mac: signApproval(seal, row) };
    db.run(
      INSERT,
      COLUMNS.map(([field]) => stored[field]),
    );
    return {
      approval: row.id,
      expiresAt: row.expiresAt,
      url: `/promote-approval?id=${row.id}`,
    };
  });
}
