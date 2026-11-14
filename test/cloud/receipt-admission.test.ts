import { expect, test } from "bun:test";
import { admitReceipt } from "../../cloud/src/receipt-admission.ts";
import { readGithubMergeEvidence } from "../../cloud/src/github-evidence.ts";
import {
  decodeEvidence,
  EvidenceReceiptStore,
} from "../../cloud/src/evidence-receipts.ts";
import { evaluateMergeEvidence } from "../../cloud/src/merge-evidence.ts";
import { ForgeFailure } from "../../src/contract/failure.ts";
import { ACTOR } from "../../cloud/conformance/max-source.ts";
import {
  admissionFixture,
  namespace,
  subject,
  type AdmissionFixture,
} from "./receipt-admission.fixture.ts";

type Phase = "prepare" | "observe" | "github-await" | "policy-await";
const rows: readonly [Phase, string, string, unknown][] = [
  ["prepare", "NOT_FOUND", "write.input.id", "work-999"],
  ["prepare", "LEASE_STALE", "lease", "released"],
  ["prepare", "LEASE_STALE", "lease", "foreign"],
  ["prepare", "INPUT_INVALID", "link", "absent"],
  ["prepare", "INPUT_INVALID", "link", "repository"],
  ["prepare", "INPUT_INVALID", "link", "pr"],
  ["prepare", "INPUT_INVALID", "link", "newest"],
  ["prepare", "UNAVAILABLE", "policy", "missing"],
  ["prepare", "UNAVAILABLE", "policy", "invalid"],
  ["prepare", "INPUT_INVALID", "write.input.headSha", "a"],
  ["observe", "UNAVAILABLE", "state.unavailable", true],
  ["observe", "RECEIPT_INVALID", "state.failingCheck", true],
  ["observe", "INPUT_INVALID", "state.changedPr", true],
  ["observe", "UNAVAILABLE", "state.prState", "open"],
  ["observe", "UNAVAILABLE", "state.prState", "closed"],
  ["github-await", "AUTH_REVOKED", "state.auth", "AUTH_REVOKED"],
  ["github-await", "AUTH_EXPIRED", "state.auth", "AUTH_EXPIRED"],
  ["github-await", "LEASE_STALE", "lease", "takeover"],
  ["github-await", "LEASE_STALE", "lease", "generation"],
  ["github-await", "INPUT_CONFLICT", "link", "revision"],
  ["github-await", "INPUT_CONFLICT", "link", "new"],
  ["github-await", "INPUT_CONFLICT", "policy", "changed"],
  ["github-await", "UNAVAILABLE", "policy", "missing"],
  ["policy-await", "AUTH_REVOKED", "state.auth", "AUTH_REVOKED"],
  ["policy-await", "INPUT_CONFLICT", "link", "revision"],
  ["policy-await", "LEASE_STALE", "lease", "released"],
  ["policy-await", "INPUT_CONFLICT", "policy", "changed"],
  ["policy-await", "INPUT_CONFLICT", "policy", "missing"],
  ["policy-await", "INPUT_CONFLICT", "env.GITHUB_REPOSITORY_ID", "43"],
  ["policy-await", "INPUT_CONFLICT", "env.FORGE_CLOUD_PROJECT", "other"],
  ["observe", "UNAVAILABLE", "cap", 8],
  ["observe", "rollback", "state.failCommit", true],
];
function change(f: AdmissionFixture, field: string, value: unknown) {
  if (field === "lease") {
    if (value === "foreign") {
      Object.assign(f.write.context, {
        session: { id: "other", device: "laptop" },
      });
      return;
    }
    f.owner.release(namespace, {
      subject,
      holder: f.holder,
      generation: f.lease.generation,
    });
    if (value !== "released") {
      const holder =
        value === "takeover"
          ? { ...f.holder, session: { id: "other", device: "laptop" } }
          : f.holder;
      f.owner.acquire(namespace, subject, holder, 600_000, "next-generation");
    }
  } else if (field === "link") {
    if (value === "absent") {
      f.owner.delete(namespace, "link:work-1:1", ACTOR, { expectRevision: 1 });
      return;
    }
    const urls: Record<string, string> = {
      repository: "https://github.com/other/forge/pull/490",
      pr: "https://github.com/acme/forge/pull/491",
      newest: "https://github.com/acme/forge/pull/491",
    };
    f.link(
      value === "newest" ? 10 : value === "new" ? 2 : 1,
      urls[String(value)],
    );
  } else if (field === "policy") {
    const policy = JSON.parse(String(f.env.GITHUB_MERGE_POLICY)) as object;
    f.env.GITHUB_MERGE_POLICY =
      value === "changed"
        ? JSON.stringify({ ...policy, version: "2" })
        : value === "invalid"
          ? "{}"
          : undefined;
  } else if (field === "cap") {
    const result = evaluateMergeEvidence(
      f.f.policy,
      f.f.expected,
      { ...f.f.observation, binding: f.f.expected },
      new Date().toISOString(),
    );
    if (!result.eligible) throw new Error("Invalid evidence fixture");
    for (let n = 0; n < Number(value); n++)
      new EvidenceReceiptStore(f.db, "forge").put({
        candidate: result.candidate,
        policy: f.f.policy,
        repository: f.ports.repository,
        verifierVersion: "1",
        actor: ACTOR.id,
        device: "laptop",
      });
  } else {
    const keys = field.split(".");
    let target = f as unknown as Record<string, unknown>;
    for (const key of keys.slice(0, -1))
      target = target[key] as Record<string, unknown>;
    target[keys.at(-1)!] = value;
  }
}
for (const [phase, code, field, value] of rows)
  test(`receipt admission: ${phase} ${field}=${JSON.stringify(value)}`, async () => {
    const f = await admissionFixture();
    try {
      const run = () => admitReceipt(f.db, f.owner, f.write, f.ports);
      let before = f.snapshot();
      const mutate = () => {
        expect(f.snapshot()).toEqual(before);
        change(f, field, value);
        before = f.snapshot();
        return Promise.resolve();
      };
      if (phase === "github-await") f.state.onRead = mutate;
      else if (phase === "policy-await") f.state.onPolicy = mutate;
      else await mutate();
      try {
        await run();
        throw new Error("Expected refusal");
      } catch (error) {
        if (code === "rollback")
          expect(error).toHaveProperty(
            "message",
            "injected command receipt failure",
          );
        else {
          expect(error).toBeInstanceOf(ForgeFailure);
          expect(error).toHaveProperty("error.code", code);
        }
      }
      if (phase === "prepare")
        expect([f.state.calls.length, f.state.credentials]).toEqual([0, 0]);
      else expect(f.state.calls.length).toBeGreaterThan(0);
      if (phase.endsWith("await")) expect(f.state.policyReads).toBe(2);
      expect(f.snapshot()).toEqual(before);
    } finally {
      f.dbSource.close();
    }
  }, 30_000);

test("verify and close: one evidence receipt and close, exact retry writes nothing", async () => {
  const f = await admissionFixture();
  try {
    const run = () => admitReceipt(f.db, f.owner, f.write, f.ports),
      before = f.snapshot();
    const closed = await run(),
      after = f.snapshot(),
      calls = f.state.calls.length;
    expect(closed).toMatchObject({ id: "work-1", status: "closed" });
    expect(after.evidence).toHaveLength(1);
    const receipt = decodeEvidence(String(after.evidence[0]!.body));
    expect(closed).toHaveProperty("receipt", receipt.id);
    expect(closed).not.toHaveProperty("withoutReceipt");
    expect(f.owner.get(namespace, subject)?.value).toMatchObject({
      status: "closed",
      receipt: receipt.id,
    });
    expect(receipt.origin).toBe("verified");
    expect(receipt.candidate.binding).toEqual(f.f.expected);
    expect([receipt.actor, receipt.device, receipt.repository]).toEqual([
      ACTOR.id,
      "laptop",
      f.ports.repository,
    ]);
    expect([f.state.policyReads, f.state.prReads, f.state.credentials]).toEqual(
      [2, 2, 1],
    );
    for (const table of ["state_leases", "state_requests"])
      expect(after.tables[table]).toEqual(before.tables[table]);
    expect(after.tables.state_events!.length).toBe(
      before.tables.state_events!.length + 1,
    );
    const changed = after.tables.state_records!.filter(
      (row) =>
        !before.tables.state_records!.some(
          (prior) => JSON.stringify(prior) === JSON.stringify(row),
        ),
    );
    expect(changed.map((row) => row.key)).toEqual([subject]);
    expect(after.tables.domain_cloud_command_receipts!.length).toBe(
      before.tables.domain_cloud_command_receipts!.length + 1,
    );
    expect(await run()).toEqual(closed);
    expect(f.snapshot()).toEqual(after);
    expect(f.state.calls).toHaveLength(calls);
    f.write = { ...f.write, input: { id: "work-1", pr: 491 } };
    await expect(run()).rejects.toHaveProperty("error.code", "INPUT_CONFLICT");
    f.state.auth = "AUTH_REVOKED";
    await expect(run()).rejects.toHaveProperty("error.code", "AUTH_REVOKED");
    expect(f.snapshot()).toEqual(after);
  } finally {
    f.dbSource.close();
  }
}, 30_000);

for (const mode of ["derived", "partial", "changed"])
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
            mode === "partial" ? { ...binding, prId: "PR_example" } : binding,
        },
        f.ports,
      );
      expect(result.ok).toBe(mode === "derived");
      if (result.ok) {
        expect(result.value.binding).toEqual(f.f.expected);
        expect([f.state.prReads, f.state.credentials]).toEqual([2, 1]);
      } else expect(result.code).toBe("INPUT_INVALID");
    } finally {
      f.dbSource.close();
    }
  }, 30_000);
