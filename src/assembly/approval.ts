import { randomUUID } from "node:crypto";
import { ForgeFailure } from "../contract/failure.ts";
import { digest, type OwnerApproval } from "../core/trust/index.ts";
import type { DeletableStateClient } from "../ports/state.ts";
import { agentSession } from "./identity.ts";

export { agentSession };

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
function issueProof(op: string, input: unknown): OwnerApproval {
  const proof = Object.freeze({}) as OwnerApproval;
  proofs.set(proof, operationBinding(op, input));
  return proof;
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
  warning?: string;
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
      `An owner reply is required before this operation runs.${options.warning === undefined ? "" : ` ${options.warning}`}`,
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
  return issueProof(options.op, input);
}

/** A person is typing: both ends are terminals and no agent session is running. */
export function attendedTerminal(
  env: Readonly<Record<string, string | undefined>>,
  stdinTTY: boolean,
  stderrTTY: boolean,
): boolean {
  return stdinTTY && stderrTTY && !agentSession(env);
}
/** Only these may run unattended from owner.json; recovery, memory and doors never can. */
export const POLICY_OPS: ReadonlySet<string> = new Set([
  "block.admit",
  "config.grant",
]);
/**
 * The operations an owner.json text lets unattended calls run. The whole file must be valid: an
 * object with only an `unattended` list of unique, eligible operations. Any violation voids it all.
 */
export function unattendedOps(text: string | undefined): {
  ops: ReadonlySet<string>;
  problem?: string;
} {
  if (text === undefined) return { ops: new Set() };
  const voided = (reason: string) => ({
    ops: new Set<string>(),
    problem: `owner.json was ignored: ${reason}. Fix or remove it.`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return voided("it is not valid JSON");
  }
  const fields = object(parsed);
  const listed = fields?.unattended;
  if (
    fields === undefined ||
    Object.keys(fields).length !== 1 ||
    !Array.isArray(listed)
  )
    return voided('it must be an object with only an "unattended" list');
  if (
    listed.some((op) => typeof op !== "string" || !POLICY_OPS.has(op)) ||
    new Set(listed).size !== listed.length
  )
    return voided(
      "it lists an unknown, repeated or ineligible operation (only block.admit and config.grant may run unattended)",
    );
  return { ops: new Set(listed as string[]) };
}
/** Evidence that Forge saw first-hand (a typed phrase, or the owner's own policy file). */
export function directApproval(options: {
  state: Pick<DeletableStateClient, "put">;
  op: string;
  input: Record<string, unknown>;
  deviceRoot: string;
  projectRoot: string;
  method: "attended" | "scripts-policy";
  /** The plain sentence the owner agreed to; it names the digest, effects or target. */
  ask: string;
  relay: RelayingSession;
  now?: () => number;
}): OwnerApproval {
  const input = { ...options.input };
  delete input.approval;
  options.state.put(
    randomUUID(),
    {
      status: "used",
      method: options.method,
      op: options.op,
      ask: options.ask,
      binding: digest(
        canonical({
          op: options.op,
          input,
          deviceRoot: options.deviceRoot,
          projectRoot: options.projectRoot,
        }),
      ),
      at: new Date((options.now ?? Date.now)()).toISOString(),
      relay: options.relay,
    },
    { expectRevision: 0 },
  );
  return issueProof(options.op, input);
}

const MEMORY_OWNER_OPS = new Set([
  "memory.forget",
  "memory.restore",
  "memory.accept",
  "memory.reject",
  "decision.adopt",
]);
/** Memory forget, restore, accept, reject and adopt claim the owner's words, so they need a relayed reply. */
export function memoryOwnerOp(candidate: {
  blockId?: string | undefined;
  declaredOp?: string | undefined;
}): boolean {
  return (
    candidate.blockId === "forge/memory" &&
    MEMORY_OWNER_OPS.has(candidate.declaredOp ?? "")
  );
}
/**
 * Splits a memory call's approval claim. An owner claim, or any approval that names a request, needs
 * relayed evidence. An agent decision or a missing approval stays with the memory block's own policy.
 */
export function memoryOwnerClaim(
  input: unknown,
):
  | { input: Record<string, unknown>; relayed: boolean; quote?: string }
  | undefined {
  const fields = object(input);
  const claim = object(fields?.approval);
  if (fields === undefined || claim === undefined) return undefined;
  if (claim.by !== "owner" && claim.request === undefined) return undefined;
  const relayed = claim.request !== undefined;
  const rest = { ...fields };
  delete rest.approval;
  return {
    input: relayed ? fields : rest,
    relayed,
    ...(typeof claim.quote === "string" ? { quote: claim.quote } : {}),
  };
}
/** What the owner is asked, in one plain sentence naming the action. */
export function memoryOwnerAsk(declaredOp: string, input: unknown): string {
  const fields = object(input);
  const id = typeof fields?.id === "string" ? fields.id : "";
  if (declaredOp === "decision.adopt")
    return `Adopt decision ${id} so it becomes a binding standing rule.`;
  if (declaredOp === "memory.accept" || declaredOp === "memory.reject") {
    const ids = Array.isArray(fields?.ids)
      ? fields.ids.filter((entry): entry is string => typeof entry === "string")
      : [];
    return declaredOp === "memory.accept"
      ? `Accept the proposed notes ${ids.join(", ")} so they are served to every session.`
      : `Reject the proposed notes ${ids.join(", ")}. They stay in history and are never served.`;
  }
  if (declaredOp === "memory.restore") {
    const notes = Array.isArray(fields?.notes) ? fields.notes.length : 0;
    return `Restore ${notes} note${notes === 1 ? "" : "s"} from an export into Forge memory.`;
  }
  return fields?.undo === true
    ? `Restore the forgotten note ${id} with its saved text and history.`
    : `Forget note ${id}. Its text is hidden and kept only as a private backup.`;
}

/** Resuming stopped lanes restarts spending, so it always needs a relayed owner reply. */
export function laneResumeOp(candidate: {
  blockId?: string | undefined;
  declaredOp?: string | undefined;
}): boolean {
  return (
    candidate.blockId === "forge/work" && candidate.declaredOp === "lane.resume"
  );
}
/**
 * Naming the owner channel decides whose replies approve gated lane steps, so it needs a relayed
 * owner reply and is never implicit or self-approved.
 */
export function laneOwnerChannelOp(
  candidate: { blockId?: string | undefined; declaredOp?: string | undefined },
  input: unknown,
): boolean {
  return (
    candidate.blockId === "forge/work" &&
    candidate.declaredOp === "lane.record" &&
    object(input)?.ownerChannel !== undefined
  );
}
export function laneOwnerChannelAsk(input: unknown): string {
  const channel = object(object(input)?.ownerChannel);
  const shown = (value: unknown) => (typeof value === "string" ? value : "");
  return `Make ${shown(channel?.harness)} thread ${shown(channel?.thread)} the owner channel. Replies from it become approvals for gated lane steps.`;
}
/** Recording a gated step's request id on an ask: the runtime checks the request before the block stores it. */
export function laneRequestOp(
  candidate: { blockId?: string | undefined; declaredOp?: string | undefined },
  input: unknown,
): boolean {
  return (
    candidate.blockId === "forge/work" &&
    candidate.declaredOp === "lane.record" &&
    object(input)?.request !== undefined
  );
}
/**
 * True when `request` is a pending, unexpired approval request bound to exactly this operation and
 * input in this device and project. It only reads; nothing is consumed.
 */
export function requestBoundTo(options: {
  state: Pick<DeletableStateClient, "get">;
  request: unknown;
  op: string;
  input: unknown;
  deviceRoot: string;
  projectRoot: string;
  now?: () => number;
}): boolean {
  if (typeof options.request !== "string") return false;
  const stored = object(options.state.get(options.request)?.value);
  const input = object(options.input);
  if (stored === undefined || input === undefined) return false;
  return (
    stored.status === "pending" &&
    typeof stored.expiresAt === "number" &&
    stored.expiresAt > (options.now ?? Date.now)() &&
    stored.binding ===
      digest(
        canonical({
          op: options.op,
          input,
          deviceRoot: options.deviceRoot,
          projectRoot: options.projectRoot,
        }),
      )
  );
}
/**
 * True when `request` exists and can never approve again: it was used, or it is still marked
 * pending past its expiry. It only reads; a pending, unexpired or unknown request is not spent.
 */
export function requestSpent(options: {
  state: Pick<DeletableStateClient, "get">;
  request: unknown;
  now?: () => number;
}): boolean {
  if (typeof options.request !== "string") return false;
  const stored = object(options.state.get(options.request)?.value);
  if (stored === undefined) return false;
  return (
    stored.status === "used" ||
    (stored.status === "pending" &&
      typeof stored.expiresAt === "number" &&
      stored.expiresAt <= (options.now ?? Date.now)())
  );
}
/** Splits the optional approval claim off a lane resume call; a missing claim asks the owner. */
export function laneResumeClaim(input: unknown): {
  input: Record<string, unknown>;
  relayed: boolean;
  quote?: string;
} {
  const fields = object(input) ?? {};
  const claim = object(fields.approval);
  const rest = { ...fields };
  delete rest.approval;
  return {
    input: claim === undefined ? rest : fields,
    relayed: claim !== undefined,
    ...(typeof claim?.quote === "string" ? { quote: claim.quote } : {}),
  };
}
export function laneResumeAsk(input: unknown): string {
  const fields = object(input);
  return fields?.all === true
    ? "Resume every stopped lane. Forge starts spending calls and time again."
    : `Resume lane ${typeof fields?.id === "string" ? fields.id : ""}. Forge starts spending calls and time on it again.`;
}
