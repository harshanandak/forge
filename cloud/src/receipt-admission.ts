import Input from "../../src/blocks/work/schemas/receipt-admit.input.json" with { type: "json" };
import { validateWithSchema } from "../../src/contract/schema.ts";
import type { StateOwner } from "../../src/core/state/index.ts";
import type { StateRecord } from "../../src/generated/types.ts";
import type { SqlDatabase } from "../../src/ports/store.ts";
import { commandWrite, prepareReceipt } from "./command-write.ts";
import {
  decodeEvidence,
  EvidenceReceiptStore,
  type EvidenceReceipt,
} from "./evidence-receipts.ts";
import { readGithubMergeEvidence } from "./github-evidence.ts";
import type { composeGithub } from "./github-compose.ts";
import { listLinks } from "./issue-links.ts";
import { fail } from "./issue-read.ts";
import { replay } from "./issue-receipts.ts";
import { heldLease } from "./issue-update.ts";
import type { WriteCall } from "./issue-write.ts";
import { evaluateMergeEvidence } from "./merge-evidence.ts";
import { carriesToken } from "./tokens.ts";

type Ports = ReturnType<typeof composeGithub> & {
  readonly signal: AbortSignal;
  readonly repository: {
    readonly host: "github.com";
    readonly owner: string;
    readonly repo: string;
  };
  readonly verifierVersion: string;
};
const OP = "receipt.admit",
  NAMESPACE = "forge/work";

/** Server-only coordinator: observe outside the transaction, recheck and commit without an await. */
export async function admitReceipt(
  db: SqlDatabase,
  owner: StateOwner,
  call: WriteCall,
  ports: Ports,
): Promise<EvidenceReceipt> {
  const { input, context } = structuredClone({
    input: call.input,
    context: call.context,
  });
  if (context.variant !== "leased")
    throw fail("INTERNAL", `${OP} needs a leased context`);
  if (carriesToken(call.requestId))
    throw fail("INPUT_INVALID", "requestId must not carry a credential");
  const identity = prepareReceipt("command", call.principal, call.requestId, {
    op: OP,
    input,
    context,
    device: call.device,
  });
  const replayed = (receipt: EvidenceReceipt) =>
    heldLease(owner, context, receipt.candidate.binding.issueId, OP);
  call.recheck();
  const prior = replay(db, owner, identity.requestId, identity.fingerprint);
  if (prior !== undefined) {
    const receipt = decodeEvidence(JSON.stringify(prior));
    replayed(receipt);
    return receipt;
  }
  const binding = ports.mergePolicyBinding();
  const p0 = await ports.mergePolicy();
  // Prepare is synchronous; P0 is the server snapshot resolved before entering it.
  call.recheck();
  if (validateWithSchema(Input, input).length)
    throw fail("INPUT_INVALID", "input must be { id, pr }");
  const { id, pr } = input as { id: string; pr: number };
  if (!owner.get(NAMESPACE, `issue:${id}`))
    throw fail("NOT_FOUND", "Issue was not found");
  heldLease(owner, context, id, OP);
  const delivery = () =>
    (
      listLinks({ records: db, leases: db }, { id }, ports.now(), "work")
        .records as StateRecord[]
    ).findLast(
      (row) => (row.value as { relation?: unknown }).relation === "delivers",
    );
  const link = delivery(),
    repository = { ...ports.repository };
  const expectedUrl = `https://${repository.host}/${repository.owner}/${repository.repo}/pull/${pr}`;
  const url = (link?.value as { url?: unknown } | undefined)?.url;
  if (
    !link ||
    typeof url !== "string" ||
    url.toLowerCase() !== expectedUrl.toLowerCase()
  )
    throw fail(
      "INPUT_INVALID",
      "Newest delivery must name the admitted repository and PR",
    );
  if (!p0.ok) throw fail(p0.code, p0.reason);
  const policy = p0.policy;
  const observed = await readGithubMergeEvidence(
    {
      locator: {
        owner: repository.owner,
        repo: repository.repo,
        repositoryId: policy.repositoryId,
        branch: policy.baseBranch,
        prNumber: pr,
      },
      policy,
      binding: {
        project: policy.project,
        issueId: id,
        linkKey: link.key,
        linkRevision: link.revision,
        repositoryId: policy.repositoryId,
        prNumber: pr,
      },
    },
    ports,
  );
  if (!observed.ok) throw fail(observed.code, observed.reason);
  const evaluated = evaluateMergeEvidence(
    policy,
    observed.value.binding,
    observed.value,
    new Date(ports.now()).toISOString(),
  );
  if (!evaluated.eligible) throw fail(evaluated.code, evaluated.reason);
  const p1 = await ports.mergePolicy();
  return commandWrite(
    db,
    owner,
    { identity, recheck: call.recheck, expiresAt: call.expiresAt },
    () => undefined,
    () => {
      // commandWrite rechecks the token inside this same synchronous transaction.
      heldLease(owner, context, id, OP);
      const current = delivery();
      if (current?.key !== link.key || current.revision !== link.revision)
        throw fail(
          "INPUT_CONFLICT",
          "Delivery changed during evidence verification",
        );
      if (!p1.ok) throw fail(p1.code, p1.reason);
      if (
        p1.policy.digest !== policy.digest ||
        ports
          .mergePolicyBinding()
          .some((value, index) => value !== binding[index])
      )
        throw fail(
          "INPUT_CONFLICT",
          "Merge policy changed during evidence verification",
        );
      return new EvidenceReceiptStore(db, policy.project).put({
        candidate: evaluated.candidate,
        policy,
        repository,
        verifierVersion: ports.verifierVersion,
        actor: context.actor.id,
        device: call.device,
      });
    },
    replayed,
  );
}
