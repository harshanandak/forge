import {
  ownerApproval,
  consumeOwnerApproval,
  ApprovalRequired,
} from "../../src/assembly/approval.ts";
import {
  TrustStore as Store,
  type TrustRecords,
  type OwnerApproval,
} from "../../src/core/trust/index.ts";
import type { StateRecord } from "../../src/generated/types.ts";

/** Runtime fixtures relay a synthetic owner reply; production proof validation still runs. */
export class TrustStore extends Store {
  constructor(records?: TrustRecords) {
    super(records, consumeOwnerApproval);
  }
}
export function admit(store: Store, digest: string): void {
  store.admit(approval("block.admit", { digest }), digest);
}
export function grant(
  store: Store,
  digest: string,
  effects: readonly string[],
): void {
  store.grant(approval("config.grant", { digest, effects }), digest, effects);
}
export function approval(
  op: string,
  input: Record<string, unknown>,
): OwnerApproval {
  const values = new Map<string, StateRecord>();
  const options = {
    state: {
      get: (key: string) => values.get(key),
      put(key: string, value: unknown) {
        const record: StateRecord = {
          namespace: "forge/core-approvals",
          key,
          value,
          revision: (values.get(key)?.revision ?? 0) + 1,
          updatedAt: "2026-11-05T00:00:00Z",
          updatedBy: { kind: "human", id: "fixture" },
        };
        values.set(key, record);
        return record;
      },
    },
    op,
    input,
    deviceRoot: "fixture-device",
    projectRoot: "fixture-project",
    ask: `Allow ${op}?`,
    relay: { harness: "fixture", id: "fixture", pid: 1 },
  };
  try {
    ownerApproval(options);
  } catch (error) {
    if (!(error instanceof ApprovalRequired) || !error.request) throw error;
    return ownerApproval({
      ...options,
      input: {
        ...input,
        approval: {
          request: error.request.id,
          quote: "yes",
          source: { harness: "fixture", thread: "fixture" },
        },
      },
    });
  }
  throw Error("Expected approval request");
}

export async function relay(
  call: (
    op: string,
    input: Record<string, unknown>,
  ) => Promise<import("../../src/generated/types.ts").ResultEnvelope>,
  op: string,
  input: Record<string, unknown>,
) {
  const first = await call(op, input);
  if (first.ok || first.error.code !== "APPROVAL_REQUIRED")
    throw Error(JSON.stringify(first));
  const request = (first.result as { request: { id: string } }).request.id;
  return call(op, {
    ...input,
    approval: {
      request,
      quote: "yes",
      source: { harness: "fixture", thread: "fixture" },
    },
  });
}
