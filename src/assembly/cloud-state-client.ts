// The async cloud lease client: claim, renew, release and holder over the project's lease routes. It
// reads the stored credential for one exact key, keeps the caller's holder, and hands the request to
// the HTTP adapter. It never writes a credential, opens local state or retries. Nothing calls it yet.
import {
  carriesToken,
  type CloudHttp,
  type CommandWire,
  type LeaseRoute,
  type LeaseWriteBody,
  type RefusalDetails,
} from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import { leaseHeldMessage } from "../contract/lease.ts";
import type {
  AmbientContext,
  LeaseHolder,
  LeaseRecord,
} from "../generated/types.ts";
import { wireDeviceId } from "./wire-device.ts";
import type { CredentialKey, CredentialStore } from "./cloud-profile.ts";

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

export function createCloudLeaseClient(
  options: CloudLeaseOptions,
): CloudLeaseClient {
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
        "No usable cloud credential is stored; run forge cloud login.",
      );
    return found;
  }

  /** One request. Whatever the transport throws is rebuilt: only a cancellation keeps its code, never its text. */
  async function exchange<T extends { kind: string }>(
    send: () => Promise<T>,
  ): Promise<Extract<T, { kind: "ok" }>> {
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
    if (result.kind === "ok") return result as Extract<T, { kind: "ok" }>;
    const bad = result as unknown as {
      code: string;
    } & RefusalDetails;
    const held =
      bad.code === "LEASE_HELD" && bad.lease?.holder !== undefined
        ? leaseHeldMessage(
            bad.lease.subject,
            bad.lease.holder,
            bad.lease.expiresAt ?? "",
          )
        : undefined;
    throw new ForgeFailure({
      code: bad.code,
      message: held ?? `The Forge cloud refused the request (${bad.code}).`,
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
      const { result } = await exchange(() =>
        http.command(token, wire, signal),
      );
      const valid = await Promise.resolve()
        .then(() => validate(result))
        .catch(() => false);
      if (!valid || carriesToken(result, token))
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
