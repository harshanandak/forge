// The async cloud lease client: claim, renew, release and holder over the project's lease routes. It
// reads the stored credential for one exact key, keeps the caller's holder, and hands the request to
// the HTTP adapter. It never writes a credential, opens local state or retries. Nothing calls it yet.
import type {
  CloudHttp,
  CommandWire,
  LeaseResult,
  LeaseRoute,
  LeaseWriteBody,
} from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { LeaseHolder, LeaseRecord } from "../generated/types.ts";
import { wireDeviceId } from "./cloud-login.ts";
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
  /** A typed command at the project authority; the result is checked by `validate`. */
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
  async function exchange(
    send: () => Promise<LeaseResult>,
  ): Promise<LeaseRecord | null> {
    let result: LeaseResult;
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
    if (result.kind === "ok") return result.lease;
    throw new ForgeFailure({
      code: result.code,
      message: `The Forge cloud refused the request (${result.code}).`,
      retry: result.code.startsWith("LEASE_") ? "reconcile_first" : "never",
      ...(result.lease === undefined ? {} : { lease: result.lease }),
    });
  }

  /** The caller's holder in the wire device form; a device that is not the credential's is refused. */
  function wired(holder: LeaseHolder, device: string): LeaseHolder {
    const named = holder.session.device;
    if (named === undefined) return holder;
    if (wireDeviceId(named) !== device)
      throw failure(
        "AUTH_DEVICE_MISMATCH",
        "This session's device is not the device the stored credential belongs to.",
      );
    return { ...holder, session: { ...holder.session, device } };
  }

  async function write(route: LeaseRoute, body: LeaseWriteBody) {
    const { token, device } = stored();
    const holder = wired(body.holder, device);
    const lease = await exchange(() =>
      http.leaseWrite(token, route, { ...body, holder }, signal),
    );
    if (lease === null) throw failure("UNAVAILABLE", UNAVAILABLE);
    return lease;
  }

  return {
    command: () =>
      Promise.reject(
        failure("UNAVAILABLE", "The cloud command client is not implemented."),
      ),
    claim: (input) => write("claim", input),
    renew: (input) => write("renew", input),
    release: (input) => write("release", input),
    async holder(subject) {
      const { token } = stored();
      return await exchange(() => http.leaseHolder(token, subject, signal));
    },
  };
}
