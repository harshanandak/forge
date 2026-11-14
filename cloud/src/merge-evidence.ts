// Caller-created observations confer no provenance or admission/close authority.
import { isPlainJson } from "./plain-json.ts";
type Guard<T> = (value: unknown) => value is T;
type Value<G> = G extends Guard<infer T> ? T : never;
type Fields = Readonly<Record<string, Guard<unknown>>>;
type Shape<S extends Fields> = { readonly [K in keyof S]: Value<S[K]> };
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
function shape<S extends Fields>(fields: S): Guard<Shape<S>> {
  return (v): v is Shape<S> =>
    record(v) &&
    Object.keys(v).length === Object.keys(fields).length &&
    Object.entries(fields).every(
      ([key, valid]) => Object.hasOwn(v, key) && valid(v[key]),
    );
}
const text: Guard<string> = (v): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= 256 &&
  v.trim() === v &&
  !/[\p{Cc}]/u.test(v);
const positive: Guard<number> = (v): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0;
function pattern(re: RegExp): Guard<string> {
  return (v): v is string => text(v) && re.test(v);
}
const sha = pattern(/^[a-f0-9]{40}$/);
const digest = pattern(/^[a-f0-9]{64}$/);
const project = pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
const timestamp: Guard<string> = (v): v is string =>
  text(v) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) &&
  new Date(v).toJSON() === (v.length === 20 ? v.replace("Z", ".000Z") : v);
function oneOf<const T extends readonly (string | null)[]>(
  ...values: T
): Guard<T[number]> {
  return (v): v is T[number] => values.some((value) => value === v);
}
function nullable<T>(valid: Guard<T>): Guard<T | null> {
  return (v): v is T | null => v === null || valid(v);
}
type Weight = (v: unknown) => number;
function list<T>(valid: Guard<T>, weight?: Weight): Guard<readonly T[]> {
  return (v): v is readonly T[] => {
    if (!Array.isArray(v)) return false;
    const rows = v as unknown[];
    const length = rows.length;
    let total = 0;
    if (weight) for (let i = 0; i < length; i++) total += weight(rows[i]);
    if (total > 4096) return false;
    for (let i = 0; i < length; i++) if (!valid(rows[i])) return false;
    return true;
  };
}
const producerFields = {
  repositoryId: positive,
  appId: positive,
  workflowId: positive,
  workflowPath: pattern(/^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/),
  workflowDigest: digest,
};
const pins = [
  "repositoryId",
  "appId",
  "workflowId",
  "workflowPath",
  "workflowDigest",
] as const;
const policyGuard = shape({
  project,
  repositoryId: positive,
  baseBranch: text,
  version: text,
  digest,
  producer: shape(producerFields),
  requiredChecks: list(text),
});
const bindingGuard = shape({
  project,
  issueId: pattern(/^work-\d+$/),
  linkKey: text,
  linkRevision: positive,
  repositoryId: positive,
  prNumber: positive,
  prId: text,
  headSha: sha,
});
const prGuard = shape({
  repositoryId: positive,
  number: positive,
  id: text,
  headSha: sha,
  state: oneOf("OPEN", "CLOSED", "MERGED"),
  mergeSha: nullable(sha),
  mergedAt: nullable(timestamp),
  baseBranch: text,
});
const outcomeFields = {
  headSha: sha,
  status: oneOf("queued", "in_progress", "completed"),
  conclusion: nullable(
    pattern(
      /^(success|failure|neutral|cancelled|skipped|timed_out|action_required|stale|startup_failure)$/,
    ),
  ),
};
const checkGuard = shape({
  id: positive,
  appId: positive,
  attempt: positive,
  name: text,
  ...outcomeFields,
  completedAt: nullable(timestamp),
});
const runGuard = shape({
  ...producerFields,
  ...outcomeFields,
  id: positive,
  runNumber: positive,
  attempt: positive,
  checks: list(checkGuard),
});
const completeness = pattern(
  /^(complete|outage|permission|truncated|page-cap)$/,
);
const observationGuard = shape({
  binding: bindingGuard,
  initialPr: prGuard,
  finalPr: prGuard,
  targetTip: sha,
  ancestry: oneOf("ancestor", "not-ancestor", "unknown"),
  completeness,
  runs: list(runGuard, (run) =>
    record(run) && Array.isArray(run.checks) ? run.checks.length : Infinity,
  ),
});
export type MergePolicy = Value<typeof policyGuard>;
export type DeliveryBinding = Value<typeof bindingGuard>;
export type MergeObservations = Value<typeof observationGuard>;
export type MergeCandidate = Pick<
  MergeObservations,
  "binding" | "finalPr" | "targetTip" | "runs"
> &
  Readonly<{
    format: "forge.cloud-merge-evidence/1";
    policyVersion: string;
    policyDigest: string;
    ancestry: "ancestor";
    verifiedAt: string;
  }>;
export type MergeRefusalCode =
  | "INPUT_INVALID"
  | "INPUT_CONFLICT"
  | "PR_NOT_MERGED"
  | "RECEIPT_HEAD_MISMATCH"
  | "RECEIPT_INVALID"
  | "UNAVAILABLE";
export type MergeEligibility =
  | Readonly<{ eligible: true; candidate: MergeCandidate }>
  | Readonly<{ eligible: false; code: MergeRefusalCode; reason: string }>;
const refuse = (code: MergeRefusalCode, reason: string): MergeEligibility => ({
  eligible: false,
  code,
  reason,
});
function same<T>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((key) => a[key] === b[key]);
}
const linked = (b: DeliveryBinding) =>
  new RegExp(`^link:${b.issueId}:\\d+$`).test(b.linkKey);
type Outcome = Shape<typeof outcomeFields> & {
  readonly completedAt?: string | null;
};
function coherentOutcome(o: Outcome, now: number): boolean {
  return (
    (o.status === "completed") === (o.conclusion !== null) &&
    (!Object.hasOwn(o, "completedAt") ||
      (o.status === "completed"
        ? o.completedAt != null && Date.parse(o.completedAt) <= now
        : o.completedAt === null))
  );
}

// Callers must bound total input bytes/keys before entry (forge-1362):
// Object.keys/Reflect.ownKeys enumerate width before these guards reject it.
export function evaluateMergeEvidence(
  policy: unknown,
  expected: unknown,
  observation: unknown,
  verifiedAt: unknown,
): MergeEligibility {
  const inputs = [policy, expected, observation, verifiedAt];
  if (!isPlainJson(inputs.map((v) => v ?? null)))
    return refuse("INPUT_INVALID", "Inputs must be plain JSON data");
  if (
    !policyGuard(policy) ||
    !policy.requiredChecks.length ||
    new Set(policy.requiredChecks).size !== policy.requiredChecks.length ||
    policy.producer.repositoryId !== policy.repositoryId
  )
    return refuse("UNAVAILABLE", "Server merge policy is missing or invalid");
  if (!bindingGuard(expected) || !linked(expected) || !timestamp(verifiedAt))
    return refuse("INPUT_INVALID", "Invalid delivery or clock");
  if (
    observation == null ||
    (record(observation) &&
      !Object.hasOwn(observation, "runs") &&
      (observation.status === "PASS" || Object.hasOwn(observation, "digest")))
  )
    return refuse("RECEIPT_INVALID", "GitHub observations required");
  if (
    record(observation) &&
    completeness(observation.completeness) &&
    observation.completeness !== "complete"
  )
    return refuse("UNAVAILABLE", "GitHub evidence is incomplete");
  if (!observationGuard(observation) || !linked(observation.binding))
    return refuse("INPUT_INVALID", "Invalid normalized observations");
  const { initialPr, finalPr, runs } = observation;
  const now = Date.parse(verifiedAt);
  if (
    [initialPr, finalPr].some((pr) =>
      pr.state === "MERGED"
        ? pr.mergeSha === null ||
          pr.mergedAt === null ||
          Date.parse(pr.mergedAt) > now
        : pr.mergeSha !== null || pr.mergedAt !== null,
    ) ||
    runs.some(
      (run) =>
        !coherentOutcome(run, now) ||
        run.checks.some((check) => !coherentOutcome(check, now)) ||
        new Set(run.checks.map((check) => `${check.name}:${check.attempt}`))
          .size !== run.checks.length ||
        runs.some(
          (other) =>
            (other.id === run.id) !== (other.runNumber === run.runNumber) ||
            (other.id === run.id && other.headSha !== run.headSha),
        ) ||
        new Set(run.checks.map((check) => check.id)).size !== run.checks.length,
    ) ||
    new Set(runs.map((run) => `${run.runNumber}:${run.attempt}`)).size !==
      runs.length
  )
    return refuse("INPUT_INVALID", "Contradictory or duplicate observations");
  if (
    policy.project !== expected.project ||
    policy.repositoryId !== expected.repositoryId ||
    !same(expected, observation.binding, [
      "project",
      "issueId",
      "linkKey",
      "linkRevision",
      "repositoryId",
      "prNumber",
      "prId",
      "headSha",
    ]) ||
    [initialPr, finalPr].some(
      (pr) =>
        pr.repositoryId !== expected.repositoryId ||
        pr.number !== expected.prNumber ||
        pr.id !== expected.prId ||
        pr.headSha !== expected.headSha,
    ) ||
    !same(initialPr, finalPr, ["state", "mergeSha", "mergedAt"])
  )
    return refuse("INPUT_CONFLICT", "Delivery binding or PR changed");
  if (observation.ancestry === "unknown")
    return refuse("UNAVAILABLE", "GitHub evidence is incomplete");
  if (
    finalPr.state !== "MERGED" ||
    finalPr.baseBranch !== policy.baseBranch ||
    initialPr.baseBranch !== policy.baseBranch ||
    observation.ancestry !== "ancestor"
  )
    return refuse("PR_NOT_MERGED", "PR has not landed on target");
  if (!runs.length || runs.some((run) => !same(policy.producer, run, pins)))
    return refuse("RECEIPT_INVALID", "Missing or unapproved workflow evidence");
  const current = runs.filter(
    (run) =>
      run.headSha === finalPr.mergeSha &&
      !runs.some((other) => other.id === run.id && other.attempt > run.attempt),
  );
  if (!current.length)
    return refuse("RECEIPT_HEAD_MISMATCH", "Workflow must cover merge commit");
  const evidence = current
    .filter((run) => run.status === "completed")
    .flatMap((run) =>
      policy.requiredChecks.map((name) =>
        run.checks
          .toSorted((a, b) => b.attempt - a.attempt)
          .find((check) => check.name === name),
      ),
    );
  const outcomes = [...current, ...evidence.filter((o) => o !== undefined)];
  if (
    outcomes.length !== current.length + evidence.length ||
    outcomes.some((o) => o.appId !== policy.producer.appId)
  )
    return refuse("RECEIPT_INVALID", "Missing or unapproved required check");
  if (outcomes.some((o) => o.headSha !== finalPr.mergeSha))
    return refuse("RECEIPT_HEAD_MISMATCH", "Evidence must cover merge commit");
  if (
    outcomes.some((o) => o.status === "completed" && o.conclusion !== "success")
  )
    return refuse("RECEIPT_INVALID", "Required evidence did not succeed");
  if (outcomes.some((o) => o.status !== "completed"))
    return refuse("UNAVAILABLE", "Required evidence is pending");
  return {
    eligible: true,
    candidate: {
      format: "forge.cloud-merge-evidence/1",
      policyVersion: policy.version,
      policyDigest: policy.digest,
      binding: { ...expected },
      finalPr: { ...finalPr },
      targetTip: observation.targetTip,
      ancestry: "ancestor",
      verifiedAt,
      // Entry validation guarantees enumerable plain data, so cloning preserves every field.
      runs: structuredClone(current),
    },
  };
}
