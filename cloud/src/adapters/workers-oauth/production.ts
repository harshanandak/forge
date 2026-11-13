import { createOidcVerifier } from "../../../../src/assembly/oidc.ts";
import { createClerkBinding } from "./clerk/index.ts";
import { createClerkUpstream, type ClerkUpstream } from "./clerk/upstream.ts";
import { durableRedemption, type RedemptionNamespace } from "./redemption.ts";
import type { OAuthOptions, OAuthStorage } from "./index.ts";
import type { readOAuthConfig } from "./config.ts";
import type { WorkerDependencies } from "./compose.ts";
import { durableGrants } from "./grant-state.ts";

// One cached verifier per Worker instance in this isolate, replaced on config change.
const verifiers = new WeakMap<
  WorkerDependencies,
  { key: string; verifier: ReturnType<typeof createOidcVerifier> }
>();
/** The Clerk upstream for a configuration: the OAuth callback and the device approval page both use it. */
export function clerkUpstream(
  config: ReturnType<typeof readOAuthConfig>,
  dependencies: WorkerDependencies,
): ClerkUpstream {
  const clock = dependencies.clock ?? { now: Date.now },
    network = dependencies.fetch ?? fetch;
  const key = JSON.stringify(config);
  let cached = verifiers.get(dependencies);
  if (cached?.key !== key) {
    const verifier = createOidcVerifier(
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ["RS256"],
        jwksUrl: config.jwksUrl,
        cacheTtlMs: 300_000,
        refreshIntervalMs: 1_000,
        fetchTimeoutMs: config.timeoutMs,
      },
      {
        get: async (url, signal) => {
          const response = await network(url, { signal, redirect: "manual" });
          if (!response.ok || response.redirected)
            throw new Error("Clerk keys unavailable");
          return response.text();
        },
      },
      clock,
    );
    cached = { key, verifier };
    verifiers.set(dependencies, cached);
  }
  return createClerkUpstream(
    config,
    createClerkBinding(cached.verifier, config.clientId, clock),
    {
      post: (url, body, signal) =>
        network(url, { method: "POST", body, signal, redirect: "manual" }),
    },
    clock,
  );
}

export function productionOptions(
  config: ReturnType<typeof readOAuthConfig>,
  env: Readonly<Record<string, unknown>>,
  dependencies: WorkerDependencies,
): OAuthOptions {
  return {
    issuer: new URL(config.redirectUri).origin,
    resources: [config.resource],
    storage: env.OAUTH_KV as OAuthStorage,
    grantRevocation: durableGrants(env.GRANT_STATE as RedemptionNamespace),
    codeRedemption: durableRedemption(
      env.CODE_REDEMPTION as RedemptionNamespace,
    ),
    clock: dependencies.clock ?? { now: Date.now },
    upstream: clerkUpstream(config, dependencies),
  };
}
