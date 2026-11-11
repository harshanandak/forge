// The async cloud lease client: claim, renew, release and holder over the project's lease routes. It
// reads the stored credential for one exact key, keeps the caller's holder, and hands the request to
// the HTTP adapter. It never writes a credential, opens local state or retries. Nothing calls it yet.
import type {
  CloudHttp,
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
  readonly http: Pick<CloudHttp, "leaseWrite" | "leaseHolder">;
  readonly signal?: AbortSignal;
}
export type ClaimInput = Required<Omit<LeaseWriteBody, "generation">>;
export type RenewInput = Required<LeaseWriteBody>;
export type ReleaseInput = Required<Omit<LeaseWriteBody, "ttlMs">>;
export interface CloudLeaseClient {
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

  async function run(
    send: (token: string, device: string) => Promise<LeaseResult>,
  ): Promise<LeaseRecord | null> {
    const stored = credentials.lookup(key, now());
    if (stored === undefined)
      throw failure(
        "AUTH_REQUIRED",
        "No usable cloud credential is stored; run forge cloud login.",
      );
    let result: LeaseResult;
    try {
      result = await send(stored.token, stored.device);
    } catch (error) {
      if (signal?.aborted === true)
        throw failure("INVOCATION_CANCELLED", "The request was cancelled.");
      if (error instanceof ForgeFailure) throw error;
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
    const lease = await run((token, device) =>
      http.leaseWrite(
        token,
        route,
        { ...body, holder: wired(body.holder, device) },
        signal,
      ),
    );
    if (lease === null) throw failure("UNAVAILABLE", UNAVAILABLE);
    return lease;
  }

  return {
    claim: (input) => write("claim", input),
    renew: (input) => write("renew", input),
    release: (input) => write("release", input),
    holder: (subject) =>
      run((token) => http.leaseHolder(token, subject, signal)),
  };
}
