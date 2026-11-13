// Cloud receipt identity never comes from the request body or a public header.
import { ForgeFailure } from "../../src/contract/failure.ts";
import { digestValue, isObject } from "../../src/core/config/pointer.ts";
import type { SqlDatabase, SqlRow } from "../../src/ports/store.ts";

export type ReceiptPrincipal = readonly ["token" | "owner", string, string];
export interface ReceiptScope {
  readonly version: 2;
  readonly principal: string;
}
export const receiptScope = (principal: ReceiptPrincipal): ReceiptScope => ({
  version: 2,
  principal: digestValue(principal),
});
export function scopeRequestId(
  family: "command" | "lease",
  principal: ReceiptPrincipal,
  raw: string,
): string {
  const hash = digestValue([2, family, principal, raw]).slice(7);
  return (family === "command" ? "c2:" : "l2:") + hash;
}
export const versioned = (value: unknown): boolean =>
  isObject(value) &&
  isObject(value.scope) &&
  Object.keys(value.scope).sort().join() === "principal,version" &&
  value.scope.version === 2 &&
  typeof value.scope.principal === "string" &&
  /^sha256:[a-f0-9]{64}$/.test(value.scope.principal);

function ownedFingerprint(value: unknown): boolean {
  try {
    return typeof value === "string" && versioned(JSON.parse(value));
  } catch {
    return false;
  }
}
function typedFingerprint(row: SqlRow | undefined): unknown {
  try {
    return row === undefined
      ? undefined
      : (JSON.parse(String(row.body)) as { value?: { fingerprint?: unknown } })
          .value?.fingerprint;
  } catch {
    return undefined;
  }
}
/** Both spellings are checked: a legacy caller could have chosen a version-2-looking id. */
export function guardLegacy(
  db: SqlDatabase,
  raw: string,
  scoped: string,
): void {
  for (const id of new Set([raw, scoped])) {
    const typed = db.get(
      "SELECT body FROM state_records WHERE namespace=? AND key=?",
      ["forge/cloud", "request:" + id],
    );
    const lease = db.get(
      "SELECT fingerprint FROM domain_cloud_requests WHERE request_id=?",
      [id],
    );
    const command = db.get(
      "SELECT fingerprint FROM domain_cloud_command_receipts WHERE request_id=? AND imported=0",
      [id],
    );
    const inner = db.get(
      "SELECT 1 FROM state_requests WHERE namespace=? AND request_id=?",
      ["forge/work", id],
    );
    // An inner acquisition is scoped only when its versioned outer receipt proves it.
    const typedOwned = ownedFingerprint(typedFingerprint(typed));
    const leaseOwned = ownedFingerprint(lease?.fingerprint);
    const commandOwned = ownedFingerprint(command?.fingerprint);
    if (
      (typed !== undefined && !typedOwned) ||
      (lease !== undefined && !leaseOwned) ||
      (command !== undefined && !commandOwned) ||
      (inner !== undefined && !typedOwned && !leaseOwned && !commandOwned)
    )
      throw new ForgeFailure({
        code: "UNAVAILABLE",
        retry: "never",
        message:
          "This request ID has an unowned legacy receipt; reconcile it and use a new request ID",
      });
  }
}
