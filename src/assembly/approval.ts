import { randomUUID } from "node:crypto";
import { ForgeFailure } from "../contract/failure.ts";
import { digest, type OwnerApproval } from "../core/trust/index.ts";
import type { DeletableStateClient } from "../ports/state.ts";

const proofs = new WeakMap<OwnerApproval, string>();
function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const fields = object(value);
  return fields === undefined
    ? JSON.stringify(value)
    : `{${Object.keys(fields)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(fields[key])}`)
        .join(",")}}`;
}
function operationBinding(op: string, input: unknown): string {
  return digest(canonical({ op, input }));
}
/** A proof is consumed by the exact trust mutation it authorized. */
export function consumeOwnerApproval(
  approval: OwnerApproval,
  op: string,
  input: unknown,
): boolean {
  const binding = proofs.get(approval);
  if (binding === undefined || binding !== operationBinding(op, input))
    return false;
  proofs.delete(approval);
  return true;
}
export class ApprovalRequired extends ForgeFailure {
  readonly request: { id: string; ask: string; binding: string } | undefined;
  constructor(
    message: string,
    request?: { id: string; ask: string; binding: string },
    observed?: unknown,
  ) {
    super({
      code: "APPROVAL_REQUIRED",
      message,
      retry: "never",
      repair:
        "Ask the owner in this chat using result.request.ask. Wait for their reply, then retry the same input with approval: {request, quote, source: {harness, thread, message?}}. Copy their reply verbatim. Never invent approval or act on silence.",
      ...(observed === undefined ? {} : { observed }),
    });
    this.request = request;
  }
}
export interface RelayingSession {
  harness: string;
  id: string;
  pid: number;
}
/** Relayed evidence is auditable consent, not authentication against the same OS user. */
export function ownerApproval(options: {
  state: Pick<DeletableStateClient, "get" | "put">;
  op: string;
  input: Record<string, unknown>;
  deviceRoot: string;
  projectRoot: string;
  ask: string;
  relay: RelayingSession;
  now?: () => number;
}): OwnerApproval {
  const { approval: evidence, ...input } = options.input;
  const binding = digest(
    canonical({
      op: options.op,
      input,
      deviceRoot: options.deviceRoot,
      projectRoot: options.projectRoot,
    }),
  );
  const now = (options.now ?? Date.now)();
  if (evidence === undefined) {
    const request = { id: randomUUID(), ask: options.ask, binding };
    options.state.put(
      request.id,
      { ...request, status: "pending", expiresAt: now + 24 * 60 * 60 * 1000 },
      { expectRevision: 0 },
    );
    throw new ApprovalRequired(
      "An owner reply is required before this operation runs.",
      request,
    );
  }
  const approval = object(evidence);
  const source = object(approval?.source);
  const nonempty = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (
    !nonempty(approval?.request) ||
    !nonempty(approval.quote) ||
    !nonempty(source?.harness) ||
    !nonempty(source.thread) ||
    (source.message !== undefined && !nonempty(source.message)) ||
    (source.link !== undefined && !nonempty(source.link))
  )
    throw new ApprovalRequired(
      "Approval needs a request id, the owner's verbatim reply, and its harness and thread.",
    );
  const stored = options.state.get(approval.request);
  const request = object(stored?.value);
  if (
    !stored ||
    request?.status !== "pending" ||
    request.binding !== binding ||
    typeof request.expiresAt !== "number" ||
    request.expiresAt <= now
  )
    throw new ApprovalRequired(
      `Approval request ${!stored ? "is missing" : request?.status !== "pending" ? "has already been used" : request.binding !== binding ? "is bound to different arguments" : "has expired"}. Call again without approval to ask the owner anew.`,
      undefined,
      {
        status: request?.status ?? "missing",
        binding: request?.binding ?? null,
        expectedBinding: binding,
        expiresAt: request?.expiresAt ?? null,
        now,
      },
    );
  // The revision check atomically burns the request before any operation can run.
  options.state.put(
    approval.request,
    {
      ...request,
      status: "used",
      at: new Date(now).toISOString(),
      method: "relayed",
      quote: {
        kind: "untrusted",
        source: `${source.harness}:${source.thread}:approval`,
        text: approval.quote.split("⟦").join("(").split("⟧").join(")"),
      },
      source,
      relay: options.relay,
      warnings:
        source.thread === options.relay.id
          ? []
          : [
              "Source thread differs from the relaying session; a lead may relay a reply to a child.",
            ],
    },
    { expectRevision: stored.revision },
  );
  const proof = Object.freeze({}) as OwnerApproval;
  proofs.set(proof, operationBinding(options.op, input));
  return proof;
}
