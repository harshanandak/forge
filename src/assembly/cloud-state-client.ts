// The async cloud lease client: claim, renew, release and holder over the project's lease routes. It
// reads the stored credential for one exact key, keeps the caller's holder, and hands the request to
// the HTTP adapter. It never writes a credential, opens local state or retries. Nothing calls it yet.
import type { CloudHttp, LeaseWriteBody } from "../adapters/http/index.ts";
import { ForgeFailure } from "../contract/failure.ts";
import type { LeaseRecord } from "../generated/types.ts";
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

const notYet = () =>
  Promise.reject(
    new ForgeFailure({
      code: "UNAVAILABLE",
      message: "The cloud lease client is not implemented.",
      retry: "never",
    }),
  );

export function createCloudLeaseClient(
  _options: CloudLeaseOptions,
): CloudLeaseClient {
  return { claim: notYet, renew: notYet, release: notYet, holder: notYet };
}
