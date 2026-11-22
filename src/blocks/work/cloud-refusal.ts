const reasonOperations = {
  "receipt.delivery_mismatch": ["issue.close"],
  "store.unregistered_table": [
    "issue.claim",
    "issue.close",
    "issue.comment",
    "issue.create",
    "issue.dep",
    "issue.link",
    "issue.release",
    "issue.renew",
    "issue.update",
    "lane.dispatch",
    "lane.resume",
    "lane.stop",
  ],
} as const;
Object.freeze(reasonOperations);

export type CloudRefusalReasonId = keyof typeof reasonOperations;

export function isCloudRefusalReasonId(
  id: unknown,
): id is CloudRefusalReasonId {
  return typeof id === "string" && Object.hasOwn(reasonOperations, id);
}

export function checkedCloudRefusalReason(
  id: unknown,
  code: string,
  op: string,
): CloudRefusalReasonId | undefined {
  if (!isCloudRefusalReasonId(id)) return undefined;
  const ops: readonly string[] = reasonOperations[id];
  return code === "INPUT_INVALID" && ops.includes(op) ? id : undefined;
}
