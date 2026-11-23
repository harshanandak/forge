import { digestValue } from "../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import {
  type ApprovalFields,
  type Seal,
  signApproval,
  type TokenFields,
} from "./v3-seal.ts";
import { readV3Root, V3_APPROVALS } from "./v3-store.ts";

const LIFETIME = 600_000;
const CREATE = `CREATE TABLE IF NOT EXISTS ${V3_APPROVALS} (id TEXT PRIMARY KEY, project TEXT NOT NULL, incarnation TEXT NOT NULL, restore_epoch TEXT NOT NULL, activation_digest TEXT NOT NULL, operation TEXT NOT NULL, operation_digest TEXT NOT NULL, token_id TEXT NOT NULL, device TEXT NOT NULL, session TEXT NOT NULL, control_epoch INTEGER NOT NULL, policy_identity TEXT NOT NULL, status TEXT NOT NULL, requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decider_issuer TEXT, decider_subject TEXT, spent_at INTEGER, mac TEXT NOT NULL) WITHOUT ROWID`;

export function requestV3Approval(
  db: SqlDatabase,
  seal: Seal,
  project: string,
  token: Pick<TokenFields, "id" | "device" | "session">,
  policyIdentity: string,
  now: number,
) {
  return db.transaction(() => {
    const root = readV3Root(db, seal);
    const activationDigest = root.activationDigest ?? null;
    const operation = "restore.promote";
    const row: ApprovalFields = {
      id: crypto.randomUUID(),
      project,
      incarnation: root.incarnation as string,
      restoreEpoch: root.restoreEpoch as string,
      activationDigest,
      operation,
      operationDigest: digestValue([operation, activationDigest]),
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
    db.exec(CREATE);
    db.run(`DELETE FROM ${V3_APPROVALS} WHERE expires_at<=?`, [now]);
    db.run(
      `INSERT INTO ${V3_APPROVALS} (id, project, incarnation, restore_epoch, activation_digest, operation, operation_digest, token_id, device, session, control_epoch, policy_identity, status, requested_at, expires_at, decided_at, decider_issuer, decider_subject, spent_at, mac) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?)`,
      [
        row.id,
        row.project,
        row.incarnation,
        row.restoreEpoch,
        row.activationDigest,
        row.operation,
        row.operationDigest,
        row.tokenId,
        row.device,
        row.session,
        row.controlEpoch,
        row.policyIdentity,
        row.status,
        row.requestedAt,
        row.expiresAt,
        signApproval(seal, row),
      ],
    );
    return {
      approval: row.id,
      expiresAt: row.expiresAt,
      url: `/promote-approval?id=${row.id}`,
    };
  });
}
