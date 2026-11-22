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

export function checkedCloudRefusalReason(
  id: unknown,
  code: string,
  op: string,
): CloudRefusalReasonId | undefined {
  if (typeof id !== "string" || !Object.hasOwn(reasonOperations, id)) return;
  const reasonId = id as CloudRefusalReasonId;
  const ops: readonly string[] = reasonOperations[reasonId];
  return code === "INPUT_INVALID" && ops.includes(op) ? reasonId : undefined;
}
