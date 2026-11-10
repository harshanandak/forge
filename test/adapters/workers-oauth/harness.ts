import type {
  OAuthOptions,
  OAuthStorage,
} from "../../../cloud/src/adapters/workers-oauth/index.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";

export interface OAuthHarness {
  options: OAuthOptions;
  advance(milliseconds?: number): void;
}

/** Test-only upstream proof and storage; no provider, network or runtime host is loaded. */
export function createOAuthHarness(identityTtlMs = 3_600_000): OAuthHarness {
  let now = 1_000_000;
  const redemptions = new Map<string, number>();
  const entries = new Map<
    string,
    {
      value: string;
      expires: number;
      metadata: unknown;
    }
  >();
  const storage: OAuthStorage = {
    get<T = string>(
      key: string,
      options?: { type: "json" },
    ): Promise<T | null> {
      const entry = entries.get(key);
      return Promise.resolve(
        !entry || now >= entry.expires
          ? null
          : ((options?.type === "json"
              ? JSON.parse(entry.value)
              : entry.value) as T),
      );
    },
    put(key, value, options) {
      entries.set(key, {
        value,
        expires: now + (options?.expirationTtl ?? Infinity) * 1000,
        metadata: options?.metadata,
      });
      return Promise.resolve();
    },
    delete(key) {
      entries.delete(key);
      return Promise.resolve();
    },
    list({ prefix }) {
      return Promise.resolve({
        keys: [...entries]
          .filter(
            ([name, entry]) => name.startsWith(prefix) && now < entry.expires,
          )
          .map(([name, entry]) => ({ name, metadata: entry.metadata })),
        list_complete: true,
      });
    },
  };
  const issuer = "https://auth.example";
  const identity = testIdentityVerifier(
    new Map([
      [
        "proof",
        {
          issuer: "https://identity.example",
          subject: "person",
          audience: issuer,
          authenticatedAt: now,
          expiresAt: now + identityTtlMs,
        },
      ],
    ]),
  );
  return {
    options: {
      issuer,
      resources: ["https://api.example/a", "https://api.example/b"],
      storage,
      codeRedemption: {
        claimOnce(hash, expiresAt) {
          if (!Number.isFinite(expiresAt) || expiresAt <= now)
            return Promise.reject(new Error("Invalid claim deadline"));
          // Check and set before yielding; memory is an atomic test fake only.
          if ((redemptions.get(hash) ?? -Infinity) > now)
            return Promise.resolve(false);
          redemptions.set(hash, expiresAt);
          return Promise.resolve(true);
        },
      },
      clock: { now: () => now },
      upstream: {
        begin: (state) =>
          Promise.resolve(`https://upstream.example/login?state=${state}`),
        verify: (request, at) =>
          identity.verify(
            new URL(request.url).searchParams.get("proof"),
            issuer,
            at,
          ),
      },
    },
    advance(milliseconds = 3_600_000) {
      now += milliseconds;
    },
  };
}
