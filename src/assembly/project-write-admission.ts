import { isDeepStrictEqual } from "node:util";
import type { StateWriteAdmission } from "../core/state/index.ts";
import type { OwnerApproval } from "../core/trust/index.ts";
import { consumeOwnerApproval } from "./approval.ts";

declare const exclusiveWriter: unique symbol;
export interface ExclusiveWriteCapability {
  readonly [exclusiveWriter]: true;
}

const exclusiveWriters = new WeakSet<ExclusiveWriteCapability>();
const approvedUnfreezes = new WeakSet<object>();
const namespace = "forge/work";
const key = "autopilot:global";

export function authorizeUnfreeze(
  proof: OwnerApproval,
  op: string,
): OwnerApproval | undefined {
  if (!consumeOwnerApproval(proof, op, {})) return undefined;
  approvedUnfreezes.add(proof);
  return proof;
}

export const projectWriteAdmission: StateWriteAdmission = (read, put) => {
  const value = read(namespace, key)?.value;
  if (
    typeof value !== "object" ||
    value === null ||
    !Object.hasOwn(value, "frozen")
  )
    return undefined;
  const { frozen, ...unfrozen } = value as Record<string, unknown>;
  const authority = put?.authority;
  if (put && authority !== undefined) {
    if (put.namespace === namespace && put.key === key) {
      if (
        approvedUnfreezes.has(authority) &&
        isDeepStrictEqual(put.value, unfrozen)
      ) {
        approvedUnfreezes.delete(authority);
        return undefined;
      }
    } else if (exclusiveWriters.has(authority as ExclusiveWriteCapability)) {
      return undefined;
    }
  }
  const since =
    typeof frozen === "string" && Number.isFinite(Date.parse(frozen))
      ? frozen
      : "an unreadable time";
  return `The local tracker store has been frozen since ${since} and no longer accepts writes.`;
};
