import { test, expect } from "bun:test";
import {
  contracts,
  schemaRef,
  evidenceDigest,
  hostInterface,
  blockerCodes,
} from "../../../src/blocks/pr/contract.ts";
import schema from "../../../src/blocks/pr/schemas/pr.json" with { type: "json" };
const time = "2026-10-20T00:00:00Z",
  sha = "a".repeat(40);
const evidence = {
  ref: { repository: "owner/repo", number: 1 },
  observedAt: time,
  core: null,
  checks: [],
  requiredChecks: [],
  reviews: [],
  threads: [],
  labels: [],
  requirements: [],
  gaps: [{ area: "core", code: "UNREADABLE" }],
};
function shape(name: string, value: unknown, expected: boolean): void {
  expect(contracts.validator(schemaRef(name))(value).ok).toBe(expected);
}

test("schemas compile, preserve deleted authors, and reject noncanonical identities", () => {
  for (const name of Object.keys(schema.$defs))
    contracts.validator(schemaRef(name));
  for (const verb of Object.values(hostInterface.operations)) {
    contracts.validator(new URL(verb.input, schema.$id).href);
    contracts.validator(new URL(verb.output, schema.$id).href);
  }
  shape("Sha", sha, true);
  shape("Sha", sha.toUpperCase(), false);
  shape("PullRequestRef", { repository: "Owner/repo", number: 1 }, false);
  const review = {
    id: "review",
    author: null,
    authorizing: false,
    state: "PENDING",
    commitSha: sha,
    submittedAt: null,
    createdAt: time,
    updatedAt: time,
  };
  shape("Review", review, true);
  shape("Review", { ...review, authorizing: "true" }, false);
  expect(schema.$defs.Blocker.properties.code.enum).toEqual([...blockerCodes]);
  shape("Blocker", { code: "INVENTED", message: "unknown" }, false);
}, 1000);

test("merge requires a digest and schema-valid refusals", () => {
  const request = {
    ref: evidence.ref,
    expectHead: sha,
    expectBase: sha,
    evidenceDigest: evidenceDigest(evidence),
    method: "squash",
    title: "Title",
    body: "",
  };
  shape("MergeRequest", request, true);
  shape("MergeRequest", { ...request, evidence }, false);
  shape("MergeRequest", { ...request, evidenceDigest: undefined }, false);
  for (const [reason, fresh, expected] of [
    ["EVIDENCE_CHANGED", evidence, true],
    ["EVIDENCE_CHANGED", undefined, false],
    ["HOST_REFUSED", undefined, true],
    [undefined, undefined, false],
  ] as const)
    shape(
      "MergeResult",
      { merged: false, reason, ...(fresh ? { evidence: fresh } : {}) },
      expected,
    );
}, 1000);

test("digest canonicalizes keys and read times while detecting changed evidence", () => {
  const reordered = {
    ...evidence,
    observedAt: "2026-10-20T00:00:01Z",
    ref: { number: 1, repository: "owner/repo" },
  };
  expect(evidenceDigest(evidence)).toBe(evidenceDigest(reordered));
  expect(evidenceDigest(evidence)).not.toBe(
    evidenceDigest({ ...evidence, labels: ["blocked"] }),
  );
  expect(() =>
    evidenceDigest({ ...evidence, observedAt: "invalid" }),
  ).toThrow();
}, 1000);
