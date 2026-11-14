import { expect, test } from "bun:test";
import { readGithubMergeEvidence } from "../../cloud/src/github-evidence.ts";
import {
  EvidenceReceiptStore,
  evidenceEligible,
} from "../../cloud/src/evidence-receipts.ts";
import { evaluateMergeEvidence } from "../../cloud/src/merge-evidence.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { ACTOR } from "../../cloud/conformance/max-source.ts";
import {
  admissionFixture,
  namespace,
  subject,
  type Admission,
  type AdmissionFixture,
} from "./receipt-admission.fixture.ts";

type Phase =
  "prepare" | "observe" | "github-await" | "policy-await" | "success" | "route";
const rows: readonly [string, string | null, Phase][] = [
  ["admit and exact retry", null, "success"],
  ["missing issue", "NOT_FOUND", "prepare"],
  ["no lease", "LEASE_STALE", "prepare"],
  ["another holder", "LEASE_STALE", "prepare"],
  ["no delivery", "INPUT_INVALID", "prepare"],
  ["wrong repository", "INPUT_INVALID", "prepare"],
  ["wrong PR", "INPUT_INVALID", "prepare"],
  ["newest delivery wins", "INPUT_INVALID", "prepare"],
  ["noncanonical URL", "INPUT_INVALID", "prepare"],
  ["missing policy", "UNAVAILABLE", "prepare"],
  ["invalid policy", "UNAVAILABLE", "prepare"],
  ["extra input", "INPUT_INVALID", "prepare"],
  ["reader unavailable", "UNAVAILABLE", "observe"],
  ["failed check", "RECEIPT_INVALID", "observe"],
  ["PR changed", "INPUT_INVALID", "observe"],
  ["token revoked", "AUTH_REVOKED", "github-await"],
  ["token expired", "AUTH_EXPIRED", "github-await"],
  ["lease takeover", "LEASE_STALE", "github-await"],
  ["lease generation", "LEASE_STALE", "github-await"],
  ["link revision", "INPUT_CONFLICT", "github-await"],
  ["new delivery", "INPUT_CONFLICT", "github-await"],
  ["policy changed during await", "INPUT_CONFLICT", "github-await"],
  ["policy unusable during await", "UNAVAILABLE", "github-await"],
  ["token revoked", "AUTH_REVOKED", "policy-await"],
  ["link revision", "INPUT_CONFLICT", "policy-await"],
  ["no lease", "LEASE_STALE", "policy-await"],
  ["ninth receipt", "UNAVAILABLE", "observe"],
  ["command receipt rollback", "injected command receipt failure", "observe"],
  ["receipt.admit", "UNKNOWN_COMMAND", "route"],
  ["receipt.show", "UNKNOWN_COMMAND", "route"],
];
function change(f: AdmissionFixture, name: string) {
  if (f.write.context.variant !== "leased")
    throw new Error("Invalid fixture context");
  const release = () =>
    f.owner.release(namespace, {
      subject,
      holder: f.holder,
      generation: f.lease.generation,
    });
  switch (name) {
    case "missing issue":
      f.write = { ...f.write, input: { id: "work-999", pr: 490 } };
      break;
    case "no lease":
      release();
      break;
    case "another holder":
      f.write = {
        ...f.write,
        context: {
          ...f.write.context,
          session: { id: "other", device: "laptop" },
        },
      };
      break;
    case "no delivery":
      f.owner.delete(namespace, "link:work-1:1", ACTOR, { expectRevision: 1 });
      break;
    case "wrong repository":
      f.link(1, "https://github.com/other/forge/pull/490");
      break;
    case "wrong PR":
      f.link(1, "https://github.com/acme/forge/pull/491");
      break;
    case "newest delivery wins":
      f.link(10, "https://github.com/acme/forge/pull/491");
      break;
    case "noncanonical URL":
      f.link(1, "https://github.com/acme/forge/pull/490?x=1");
      break;
    case "missing policy":
    case "policy unusable during await":
      f.env.GITHUB_MERGE_POLICY = undefined;
      break;
    case "invalid policy":
      f.env.GITHUB_MERGE_POLICY = "{}";
      break;
    case "extra input":
      f.write = {
        ...f.write,
        input: { id: "work-1", pr: 490, headSha: "a".repeat(40) },
      };
      break;
    case "reader unavailable":
      f.state.unavailable = true;
      break;
    case "failed check":
      f.state.failingCheck = true;
      break;
    case "PR changed":
      f.state.changedPr = true;
      break;
    case "token revoked":
      f.state.auth = "AUTH_REVOKED";
      break;
    case "token expired":
      f.state.auth = "AUTH_EXPIRED";
      break;
    case "lease takeover":
    case "lease generation":
      release();
      f.owner.acquire(
        namespace,
        subject,
        {
          ...f.holder,
          session:
            name === "lease takeover"
              ? { id: "other", device: "laptop" }
              : f.holder.session,
        },
        600_000,
        "next-generation",
      );
      break;
    case "link revision":
      f.link();
      break;
    case "new delivery":
      f.link(2);
      break;
    case "policy changed during await": {
      const policy = JSON.parse(String(f.env.GITHUB_MERGE_POLICY)) as {
        version: string;
      };
      policy.version = "2";
      f.env.GITHUB_MERGE_POLICY = JSON.stringify(policy);
      break;
    }
    case "command receipt rollback":
      f.state.failCommit = true;
      break;
    case "ninth receipt": {
      const result = evaluateMergeEvidence(
        f.f.policy,
        f.f.expected,
        { ...f.f.observation, binding: f.f.expected },
        new Date().toISOString(),
      );
      if (!result.eligible) throw new Error("Invalid evidence fixture");
      const store = new EvidenceReceiptStore(f.db, "forge");
      for (let n = 0; n < 8; n++)
        store.put({
          candidate: result.candidate,
          policy: f.f.policy,
          repository: f.ports.repository,
          verifierVersion: "1",
          actor: ACTOR.id,
          device: "laptop",
        });
      break;
    }
  }
}
for (const [name, code, phase] of rows)
  test(`receipt admission: ${name} (${phase})`, async () => {
    const f = await admissionFixture();
    try {
      if (phase === "route") {
        const before = f.snapshot();
        const response = await f.send(
          f.routeCall("unrouted", name, { id: "work-1", pr: 490 }),
        );
        expect(JSON.parse(response.text)).toHaveProperty("error.code", code);
        expect(f.snapshot()).toEqual(before);
        return;
      }
      const path = "../../cloud/src/" + "receipt-admission.ts";
      expect(await Bun.file(new URL(path, import.meta.url)).exists()).toBe(
        true,
      );
      const { admitReceipt: admit } = (await import(path)) as {
        admitReceipt: Admission;
      };
      let before = f.snapshot();
      const mutate = () => {
        change(f, name);
        before = f.snapshot();
        return Promise.resolve();
      };
      if (phase === "github-await") f.state.onRead = mutate;
      else if (phase === "policy-await") f.state.onPolicy = mutate;
      else await mutate();
      if (phase === "success") {
        const receipt = await admit(f.db, f.owner, f.write, f.ports);
        expect(receipt.origin).toBe("verified");
        expect(evidenceEligible(receipt)).toBe(true);
        expect(receipt.candidate.binding).toEqual(f.f.expected);
        expect([receipt.actor, receipt.device, receipt.repository]).toEqual([
          ACTOR.id,
          "laptop",
          f.ports.repository,
        ]);
        expect(receipt.policy.digest).toBe(receipt.candidate.policyDigest);
        expect([
          f.state.policyReads,
          f.state.prReads,
          f.state.credentials,
        ]).toEqual([2, 2, 1]);
        const after = f.snapshot(),
          calls = f.state.calls.length;
        for (const table of [
          "state_records",
          "state_events",
          "state_leases",
          "state_requests",
        ])
          expect(after.tables[table]).toEqual(before.tables[table]);
        expect(after.evidence).toHaveLength(1);
        expect(after.tables.domain_cloud_command_receipts!.length).toBe(
          before.tables.domain_cloud_command_receipts!.length + 1,
        );
        expect(await admit(f.db, f.owner, f.write, f.ports)).toEqual(receipt);
        expect(f.snapshot()).toEqual(after);
        expect(f.state.calls).toHaveLength(calls);
        await expect(
          admit(
            f.db,
            f.owner,
            { ...f.write, input: { id: "work-1", pr: 491 } },
            f.ports,
          ),
        ).rejects.toHaveProperty("error.code", "INPUT_CONFLICT");
        f.state.auth = "AUTH_REVOKED";
        await expect(
          admit(f.db, f.owner, f.write, f.ports),
        ).rejects.toHaveProperty("error.code", "AUTH_REVOKED");
        expect(f.snapshot()).toEqual(after);
        return;
      }
      try {
        await admit(f.db, f.owner, f.write, f.ports);
        throw new Error("Expected refusal");
      } catch (error) {
        if (name === "command receipt rollback")
          expect(error).toHaveProperty("message", code);
        else {
          expect(error).toBeInstanceOf(ForgeFailure);
          expect(error).toHaveProperty("error.code", code);
        }
      }
      if (phase === "prepare")
        expect([f.state.calls.length, f.state.credentials]).toEqual([0, 0]);
      else expect(f.state.calls.length).toBeGreaterThan(0);
      if (phase === "github-await" || phase === "policy-await")
        expect(f.state.policyReads).toBe(2);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.dbSource.close();
    }
  }, 30_000);

for (const mode of [
  "derived",
  "supplied",
  "partial",
  "changed",
  "mismatch",
] as const)
  test(`receipt reader identity: ${mode}`, async () => {
    const f = await admissionFixture();
    try {
      const p0 = await f.ports.mergePolicy();
      if (!p0.ok) throw new Error("Invalid policy fixture");
      const { prId: _prId, headSha: _headSha, ...binding } = f.f.expected;
      f.state.changedPr = mode === "changed";
      const result = await readGithubMergeEvidence(
        {
          locator: {
            owner: "acme",
            repo: "forge",
            repositoryId: 42,
            branch: "main",
            prNumber: 490,
          },
          policy: p0.policy,
          binding:
            mode === "supplied"
              ? f.f.expected
              : mode === "partial"
                ? { ...binding, prId: "PR_example" }
                : mode === "mismatch"
                  ? { ...f.f.expected, prId: "wrong" }
                  : binding,
        },
        f.ports,
      );
      expect(result.ok).toBe(mode === "derived" || mode === "supplied");
      if (result.ok) {
        expect(result.value.binding).toEqual(f.f.expected);
        expect([f.state.prReads, f.state.credentials]).toEqual([2, 1]);
      } else expect(result.code).toBe("INPUT_INVALID");
    } finally {
      f.dbSource.close();
    }
  }, 30_000);
