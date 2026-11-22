// The async cloud lease client: claim, renew, release and holder over the project's lease routes. It
// reads the stored credential for one exact key, keeps the caller's holder, and hands the request to
// the HTTP adapter. It never writes a credential, opens local state or retries. Nothing calls it yet.
import {
  carriesToken,
  type CloudHttp,
  type CommandRefusalCode,
  type CommandWire,
  type LeaseRoute,
  type LeaseWriteBody,
  type RefusalDetails,
} from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { storageRefusal } from "../adapters/http/storage-refusal.ts";
import {
  isCloudRefusalReasonId,
  type CloudRefusalReasonId,
} from "../blocks/work/cloud-refusal.ts";
import type {
  AmbientContext,
  LeaseHolder,
  LeaseRecord,
} from "../generated/types.ts";
import { wireDeviceId } from "./wire-device.ts";
import type { CredentialKey, CredentialStore } from "./cloud-profile.ts";
import type * as State from "../ports/state-protocol.ts";

export interface CloudLeaseOptions {
  /** The exact origin, project UUID and cloud project name the credential was saved under. */
  readonly key: CredentialKey;
  readonly credentials: Pick<CredentialStore, "lookup">;
  readonly now: () => number;
  readonly http: Pick<
    CloudHttp,
    "origin" | "project" | "leaseWrite" | "leaseHolder" | "command"
  >;
  readonly signal?: AbortSignal;
}
export type ClaimInput = Required<Omit<LeaseWriteBody, "generation">>;
export type RenewInput = Required<LeaseWriteBody>;
export type ReleaseInput = Required<Omit<LeaseWriteBody, "ttlMs">>;
export interface CloudLeaseClient {
  /**
   * A typed command at the project authority. The result is validated by `validate` (the operation's
   * declared output schema, supplied by the caller) and is never returned unvalidated.
   */
  command(
    call: CommandWire,
    validate: (result: unknown) => boolean,
  ): Promise<Record<string, unknown>>;
  claim(input: ClaimInput): Promise<LeaseRecord>;
  renew(input: RenewInput): Promise<LeaseRecord>;
  release(input: ReleaseInput): Promise<LeaseRecord>;
  /** The raw record: `null`, an expired or a released lease is never filtered or treated as a grant. */
  holder(subject: string): Promise<LeaseRecord | null>;
}

const failure = (code: string, message: string) =>
  new ForgeFailure({ code, message, retry: "never" });
const MISMATCH =
  "This session's device is not the device the stored credential belongs to.";
const UNAVAILABLE = "The Forge cloud gave no usable answer.";

const reasonMessages: Readonly<Record<CloudRefusalReasonId, string>> =
  Object.freeze({
    "receipt.delivery_mismatch":
      "Add or correct the newest delivers link so it points to the pull request being closed in the admitted repository.",
    "store.unregistered_table":
      "The cloud project contains an unregistered storage table. Ask the project owner to inspect the store.",
  });

const refusalMessages = Object.freeze({
  APPROVAL_REQUIRED:
    "Owner approval is still required. Run lane resume without an approval to get a new request.",
  INPUT_INVALID: "The Forge cloud rejected the command input.",
  CONTEXT_MISSING: "The request is missing required context.",
  UNKNOWN_COMMAND: "This command is unavailable in the Forge cloud.",
  NOT_FOUND: "The requested item was not found in the Forge cloud.",
  INPUT_CONFLICT: "The request conflicts with current cloud state.",
  RECEIPT_REQUIRED: "A receipt or an explicit exemption is required.",
  RECEIPT_INVALID: "The Forge cloud could not accept the receipt evidence.",
  RECEIPT_HEAD_MISMATCH: "The receipt evidence must cover the merge commit.",
  PR_NOT_MERGED: "The pull request has not merged into its target branch.",
  REVISION_CONFLICT: "Cloud state changed. Read it again before retrying.",
  LEASE_HELD:
    "Another holder has the lease. Read the lease state to reconcile before retrying.",
  CLAIM_BLOCKED: "The issue has unresolved blockers.",
  LEASE_NOT_HELD: "The caller does not hold the lease.",
  LEASE_STALE: "The lease generation is stale.",
  LEASE_EXPIRED: "The lease has expired.",
  INTERNAL: "The Forge cloud encountered an internal error.",
  UNAVAILABLE: "The Forge cloud is unavailable.",
  AUTH_REQUIRED: "The Forge cloud requires a device credential.",
  AUTH_INVALID: "The cloud credential is invalid.",
  AUTH_REVOKED: "The cloud credential was revoked.",
  AUTH_EXPIRED: "The cloud credential has expired.",
  AUTH_DEVICE_MISMATCH:
    "The cloud credential does not match the device or session.",
  AUTH_FORBIDDEN: "The request is forbidden in the Forge cloud.",
} satisfies Record<
  Exclude<CommandRefusalCode, "QUOTA_EXHAUSTED" | "STORAGE_LIMIT_EXCEEDED">,
  string
>);

/** A checked command failure with a result the CLI and MCP must carry. */
export class CloudCommandFailure extends ForgeFailure {
  readonly result: Record<string, unknown>;
  constructor(result: Record<string, unknown>) {
    super({
      code: "APPROVAL_REQUIRED",
      message: "Fresh owner approval is required",
      retry: "never",
    });
    this.result = result;
  }
}

function cloudExchange(
  options: Pick<CloudLeaseOptions, "key" | "credentials" | "now" | "signal"> & {
    readonly http: Pick<CloudHttp, "origin" | "project">;
  },
) {
  const { key, credentials, now, http, signal } = options;

  /** The stored credential for the exact key, and only when the transport is bound to that key. */
  function stored() {
    if (http.origin !== key.origin || http.project !== key.project)
      throw failure(
        "INPUT_INVALID",
        "The cloud transport is bound to a different origin or project than the credential key.",
      );
    const found = credentials.lookup(key, now());
    if (found === undefined)
      throw failure(
        "AUTH_REQUIRED",
        "No usable cloud credential is stored; run forge auth login.",
      );
    return found;
  }

  /** One request. Whatever the transport throws is rebuilt: only a cancellation keeps its code, never its text. */
  async function exchange<T extends { kind: string }>(
    send: () => Promise<T>,
    Refusal: typeof ForgeFailure = ForgeFailure,
  ): Promise<Extract<T, { kind: "ok" | "approval_required" }>> {
    let result: T;
    try {
      result = await send();
    } catch (error) {
      const stopped =
        error instanceof ForgeFailure &&
        error.error.code === "INVOCATION_CANCELLED";
      if (signal?.aborted === true || stopped)
        throw failure("INVOCATION_CANCELLED", "The request was cancelled.");
      throw failure("UNAVAILABLE", UNAVAILABLE);
    }
    if (result.kind === "ok" || result.kind === "approval_required")
      return result as Extract<T, { kind: "ok" | "approval_required" }>;
    const bad = result as unknown as {
      code: string;
      reasonId?: CloudRefusalReasonId;
    } & RefusalDetails;
    const storage = storageRefusal(bad.code);
    if (storage) throw new Refusal(storage);
    const { code, reasonId } = bad;
    const message = isCloudRefusalReasonId(reasonId)
      ? reasonMessages[reasonId]
      : Object.hasOwn(refusalMessages, code)
        ? refusalMessages[code as keyof typeof refusalMessages]
        : "The Forge cloud refused the request.";
    throw new Refusal({
      code,
      message,
      retry: bad.code.startsWith("LEASE_") ? "reconcile_first" : "never",
      ...(bad.lease === undefined ? {} : { lease: bad.lease }),
      ...(bad.observed === undefined ? {} : { observed: bad.observed }),
      ...(bad.repair === undefined ? {} : { repair: bad.repair }),
    });
  }

  /** The caller's holder in the wire device form; a device that is not the credential's is refused. */
  function wired(holder: LeaseHolder, device: string): LeaseHolder {
    const named = holder.session.device;
    if (named === undefined) return holder;
    if (wireDeviceId(named) !== device)
      throw failure("AUTH_DEVICE_MISMATCH", MISMATCH);
    return { ...holder, session: { ...holder.session, device } };
  }

  /** The caller's context for the wire: this project by name with no root, any named device in wire form. */
  function contextFor(context: AmbientContext, device: string) {
    const named = [context.device?.id, context.session?.device];
    if (named.some((d) => d !== undefined && wireDeviceId(d) !== device))
      throw failure("AUTH_DEVICE_MISMATCH", MISMATCH);
    return {
      ...context,
      project: { id: key.project },
      ...(context.device === undefined ? {} : { device: { id: device } }),
      ...(context.session?.device === undefined
        ? {}
        : { session: { ...context.session, device } }),
    };
  }

  return { stored, exchange, wired, contextFor };
}

export function createCloudLeaseClient(
  options: CloudLeaseOptions,
): CloudLeaseClient {
  const { key, http, signal } = options;
  const { stored, exchange, wired, contextFor } = cloudExchange(options);

  async function write(route: LeaseRoute, body: LeaseWriteBody) {
    const { token, device } = stored();
    const holder = wired(body.holder, device);
    const { lease } = await exchange(() =>
      http.leaseWrite(token, route, { ...body, holder }, signal),
    );
    // A success answer that echoes the presented token is refused whole, as unusable.
    if (lease === null || carriesToken(lease, token))
      throw failure("UNAVAILABLE", UNAVAILABLE);
    return lease;
  }

  return {
    async command(call, validate) {
      const { token, device } = stored();
      const wire = {
        requestId: call.requestId,
        op: call.op,
        input: call.input,
        context: contextFor(call.context, device),
        ...(call.dryRun === undefined ? {} : { dryRun: call.dryRun }),
      };
      const answer = await exchange(() => http.command(token, wire, signal));
      const { result } = answer;
      const valid = await Promise.resolve()
        .then(() => validate(result))
        .catch(() => false);
      if (!valid || carriesToken(result, token))
        throw failure("UNAVAILABLE", UNAVAILABLE);
      if (answer.kind === "approval_required") {
        const input = call.input as {
          all?: true;
          id?: string;
          approval?: unknown;
        };
        const scope = result.scope as { all?: true; id?: string } | undefined;
        const expiresAt = Date.parse(String(result.expiresAt));
        const expected =
          typeof input?.id === "string"
            ? input.id.replace(/^.*-/, "work-")
            : undefined;
        if (
          call.op !== "lane.resume" ||
          input?.approval !== undefined ||
          Object.keys(result).sort().join() !== "expiresAt,request,scope" ||
          !(expiresAt > options.now()) ||
          typeof result.request !== "string" ||
          (input?.all === true
            ? scope?.all !== true
            : expected === undefined || scope?.id !== expected)
        )
          throw failure("UNAVAILABLE", UNAVAILABLE);
        const deadline = new Date(expiresAt)
          .toISOString()
          .replace("T", " ")
          .replace(/:00\.000Z$|\.000Z$|Z$/, " UTC");
        const target =
          input?.all === true ? "all stopped lanes" : `lane ${expected}`;
        const ask = `Resume ${target} in Forge project ${key.project}? Forge can dispatch work and start spending calls and time again. Please reply here before ${deadline}.`;
        throw new CloudCommandFailure({ ...result, ask });
      }
      if (call.op === "lane.resume" && "request" in result)
        throw failure("UNAVAILABLE", UNAVAILABLE);
      return result;
    },
    claim: (input) => write("claim", input),
    renew: (input) => write("renew", input),
    release: (input) => write("release", input),
    async holder(subject) {
      const { token } = stored();
      const { lease } = await exchange(() =>
        http.leaseHolder(token, subject, signal),
      );
      if (carriesToken(lease, token)) throw failure("UNAVAILABLE", UNAVAILABLE);
      return lease;
    },
  };
}

export interface CloudRecordOptions extends Omit<CloudLeaseOptions, "http"> {
  readonly http: Pick<
    CloudHttp,
    "origin" | "project" | "stateRead" | "stateCommit"
  >;
}
export interface CloudRecordClient {
  read(call: State.StateReadRequest): Promise<State.StateReadResult>;
  /** Observe only the token id from the same lookup, immediately before transport entry. */
  commit(
    call: State.StateCommitRequest,
    principal?: (id: string) => void,
  ): Promise<State.StateCommitResult>;
}

/** A decoded refusal for this attempt, not proof that an earlier attempt did not commit. */
export class CloudRecordRefusal extends ForgeFailure {}

/** One bound project's checked record transport, with no local state or automatic resend. */
export function createCloudRecordClient(
  options: CloudRecordOptions,
): CloudRecordClient {
  const { http, signal } = options;
  const { stored, exchange, contextFor } = cloudExchange(options);
  const unknownCommit = () =>
    new ForgeFailure({
      code: "UNAVAILABLE",
      message:
        "Commit acceptance is unknown; reconciliation required with the exact request and request ID.",
      retry: "reconcile_first",
    });
  return {
    async read(call) {
      const { token, device } = stored();
      const body = { ...call, context: contextFor(call.context, device) };
      const { result } = await exchange(
        () => http.stateRead(token, body, signal),
        CloudRecordRefusal,
      );
      if (carriesToken(result, token))
        throw failure("UNAVAILABLE", UNAVAILABLE);
      return result;
    },
    async commit(call, principal) {
      const { token, device, id } = stored();
      const body = { ...call, context: contextFor(call.context, device) };
      if (signal?.aborted === true)
        throw failure("INVOCATION_CANCELLED", "The request was cancelled.");
      try {
        const { result } = await exchange(() => {
          principal?.(id);
          return http.stateCommit(token, body, signal);
        }, CloudRecordRefusal);
        if (carriesToken(result, token)) throw unknownCommit();
        return result;
      } catch (error) {
        if (
          error instanceof ForgeFailure &&
          !(error instanceof CloudRecordRefusal) &&
          (error.error.code === "UNAVAILABLE" ||
            error.error.code === "INVOCATION_CANCELLED")
        )
          throw unknownCommit();
        throw error;
      }
    },
  };
}
