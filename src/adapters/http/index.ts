// Outbound HTTPS to one Forge cloud origin and project. Stub: behaviour lands with the fix commit.
export interface CloudRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly redirect: "manual";
  readonly signal: AbortSignal;
}
export type CloudFetch = (
  url: string,
  init: CloudRequestInit,
) => Promise<Response>;

export interface LoginChallenge {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly expiresIn: number;
  readonly interval: number;
  readonly device: string;
}
export type StartResult =
  | { readonly kind: "started"; readonly challenge: LoginChallenge }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly interval?: number;
    };
export type PollResult =
  | { readonly kind: "credential"; readonly credential: string }
  | {
      readonly kind: "refused";
      readonly error: string;
      readonly interval?: number;
    };

export interface CloudHttpOptions {
  readonly origin: string;
  readonly project: string;
  readonly fetch?: CloudFetch;
  /** Deadline for one request, headers and body together. */
  readonly timeoutMs?: number;
  /** Largest response body accepted. */
  readonly maxBytes?: number;
}
export interface CloudHttp {
  loginStart(device: string, signal?: AbortSignal): Promise<StartResult>;
  loginPoll(deviceCode: string, signal?: AbortSignal): Promise<PollResult>;
}

export function validateOrigin(_origin: string): string {
  throw new Error("not implemented");
}
export function validateProject(_project: string): string {
  throw new Error("not implemented");
}
export const defaultCloudFetch: CloudFetch = () =>
  Promise.reject(new Error("not implemented"));
export function createCloudHttp(_options: CloudHttpOptions): CloudHttp {
  throw new Error("not implemented");
}
