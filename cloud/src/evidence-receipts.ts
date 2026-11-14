import { ForgeFailure } from "../../src/contract/failure.ts";
import { SchemaRegistry } from "../../src/contract/schema.ts";
import { parseUntrustedJson } from "../../src/contract/untrusted.ts";
import { canonicalJson } from "../../src/core/config/pointer.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import receiptSchema from "../../src/blocks/work/schemas/receipt.output.json" with { type: "json" };
import * as merge from "./merge-evidence.ts";
import { isPlainJson } from "./plain-json.ts";
export const EVIDENCE_RECEIPTS = "domain_cloud_evidence_receipts";
const T = EVIDENCE_RECEIPTS;
export const EVIDENCE_MIGRATION = {
  id: "008_cloud_evidence_receipts",
  statements: [
    `CREATE TABLE ${T} (id TEXT PRIMARY KEY, issue_id TEXT NOT NULL, body TEXT NOT NULL)`,
    `CREATE INDEX evidence_receipts_issue ON ${T}(issue_id)`,
  ],
};
export type EvidenceInput = Readonly<{
  candidate: merge.MergeCandidate;
  policy: merge.MergePolicy;
  repository: Readonly<{ host: "github.com"; owner: string; repo: string }>;
  verifierVersion: string;
  actor: string;
  device: string;
}>;
export interface EvidenceReceipt extends EvidenceInput {
  readonly format: "forge.cloud-evidence-receipt/1";
  readonly id: string;
  readonly origin: "verified" | "imported";
  readonly subjectKind: "merge-commit";
}
const MAX_BYTES = 16 * 1024;
const registry = new SchemaRegistry([receiptSchema]);
const fail = (code = "RECEIPT_INVALID", message = code): never => {
  throw new ForgeFailure({ code, message, retry: "never" });
};
export function decodeEvidence(text: string): EvidenceReceipt {
  const parsed = parseUntrustedJson(text, {
    maxBytes: MAX_BYTES,
    maxDepth: 16,
    maxNodes: 4096,
    maxStringLength: 256,
  });
  if (!parsed.ok || registry.validate("#", parsed.value).length) return fail();
  const receipt = parsed.value as EvidenceReceipt;
  const c = receipt.candidate;
  const result = merge.evaluateMergeEvidence(
    receipt.policy,
    c.binding,
    {
      binding: c.binding,
      initialPr: c.finalPr,
      finalPr: c.finalPr,
      targetTip: c.targetTip,
      ancestry: c.ancestry,
      completeness: "complete",
      runs: c.runs,
    },
    c.verifiedAt,
  );
  if (!result.eligible || canonicalJson(result.candidate) !== canonicalJson(c))
    return fail();
  return receipt;
}
export const evidenceEligible = (receipt: EvidenceReceipt): boolean =>
  receipt.origin === "verified";
export function assertNoEvidence(db: SqlDatabase): void {
  if (
    db.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", [T]) &&
    db.get(`SELECT 1 FROM ${T} LIMIT 1`)
  )
    fail("INPUT_INVALID", "Evidence receipts require cloud dump v3");
}
export class EvidenceReceiptStore {
  readonly #db: SqlDatabase;
  readonly #project: string;
  constructor(db: SqlDatabase, project: string) {
    this.#db = db;
    this.#project = project;
  }
  get(project: string, issue: string, id: string): EvidenceReceipt {
    if (project !== this.#project) return fail();
    const db = this.#db;
    const row = db.get(`SELECT issue_id, body FROM ${T} WHERE id=?`, [id]);
    if (!row || row.issue_id !== issue) return fail();
    const receipt = decodeEvidence(String(row.body));
    if (
      receipt.id !== id ||
      receipt.candidate.binding.project !== project ||
      receipt.candidate.binding.issueId !== issue
    )
      return fail();
    return receipt;
  }
  // An existing ID is supplied only by server retry state, never by a device request.
  put(input: EvidenceInput, id: string = crypto.randomUUID()): EvidenceReceipt {
    if (!isPlainJson(input)) return fail();
    const body = canonicalJson({
      ...input,
      format: "forge.cloud-evidence-receipt/1",
      id,
      origin: "verified",
      subjectKind: "merge-commit",
    });
    if (new TextEncoder().encode(body).length > MAX_BYTES)
      return fail("UNAVAILABLE", "Evidence receipt exceeds 16 KiB");
    const receipt = decodeEvidence(body),
      binding = receipt.candidate.binding;
    if (binding.project !== this.#project) return fail();
    const db = this.#db;
    return db.transaction(() => {
      const prior = db.get(`SELECT body FROM ${T} WHERE id=?`, [id]);
      if (prior) {
        if (prior.body !== body) return fail("INPUT_CONFLICT");
        return this.get(this.#project, binding.issueId, id);
      }
      const counts = db.get(
        `SELECT COUNT(*) AS total, SUM(issue_id=?) AS issue FROM ${T}`,
        [binding.issueId],
      )!;
      if (Number(counts.total) >= 16_384 || Number(counts.issue) >= 8)
        return fail("UNAVAILABLE");
      db.run(`INSERT INTO ${T}(id,issue_id,body) VALUES (?,?,?)`, [
        id,
        binding.issueId,
        body,
      ]);
      return this.get(this.#project, binding.issueId, id);
    });
  }
}
