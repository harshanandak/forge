import type { InterfaceDocument } from "../../generated/types.ts";
import { createHash } from "node:crypto";
import { SchemaRegistry } from "../../contract/schema.ts";
import schema from "./schemas/pr.json" with { type: "json" };
import mergeResult from "./schemas/merge-result.json" with { type: "json" };
import mergeRefusal from "./schemas/merge-refusal.json" with { type: "json" };
import { validateInterfaceDocument } from "../../generated/validators.ts";
import host from "./schemas/forge.pr-host.json" with { type: "json" };

export const HOST_INTERFACE = "forge.pr-host@1";
const parsedHost = validateInterfaceDocument(host);
if (!parsedHost.ok) throw new Error("Invalid host interface");
export const hostInterface: InterfaceDocument = parsedHost.value;
export const contracts: SchemaRegistry = new SchemaRegistry([
  schema,
  { ...mergeResult, $id: new URL("merge-result.json", schema.$id).href },
  { ...mergeRefusal, $id: new URL("merge-refusal.json", schema.$id).href },
]);
export const schemaRef = (name: string): string =>
  `${schema.$id}#/$defs/${name}`;

/** Schemas remain the authority at the provider boundary; no unchecked cast to domain types. */
export const blockerCodes = [
  "CORE_UNREADABLE",
  "EVIDENCE_GAP",
  "REQUIREMENT_UNKNOWN",
  "HOST_BLOCKED",
  "BYPASS_CAPABLE",
  "MERGEABILITY_UNKNOWN",
  "CHECK_STATE_UNKNOWN",
  "REVIEW_ORDER_AMBIGUOUS",
  "CHECK_ORDER_AMBIGUOUS",
  "DRAFT",
  "CONFLICTING",
  "CHECK_FAILED",
  "CHECK_PENDING",
  "NO_CHECKS",
  "REVIEW_BLOCKED",
  "REVIEW_REQUIRED",
  "REQUIREMENT_UNSATISFIED",
  "REQUIREMENT_PENDING",
  "MERGE_METHOD_UNAVAILABLE",
  "BLOCKING_LABEL",
  "SETTLING",
] as const;
export type BlockerCode = (typeof blockerCodes)[number];
/** The read timestamp is not a merge condition; all decision-bearing evidence is. */
export function evidenceDigest(evidence: unknown): string {
  const checked = contracts.validator<unknown>(schemaRef("Evidence"))(evidence);
  if (!checked.ok) throw new Error("Invalid evidence");
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") {
      const record = value as Readonly<Record<string, unknown>>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
        .join(",")}}`;
    }
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("Evidence must be JSON");
    return encoded;
  };
  const { observedAt: _readTime, ...state } = checked.value as Readonly<
    Record<string, unknown>
  >;
  return `sha256:${createHash("sha256").update(canonical(state)).digest("hex")}`;
}
