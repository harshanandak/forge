import type {
  OAuthOptions,
  OAuthStorage,
} from "../../../cloud/src/adapters/workers-oauth/index.ts";
import { testIdentityVerifier } from "../../contract/lib/identity-verifier.ts";
import { durableRedemption } from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
import type { RedemptionNamespace } from "../../../cloud/src/adapters/workers-oauth/redemption.ts";
import { mock } from "bun:test";
await mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const { durableGrants, GrantState } =
  await import("../../../cloud/src/adapters/workers-oauth/grant-state.ts");
const { refreshPolicy } =
  await import("../../../cloud/src/adapters/workers-oauth/refresh.ts");

export interface OAuthHarness {
  options: OAuthOptions;
  advance(milliseconds?: number): void;
  grantNamespace: RedemptionNamespace;
  grantObject(hash: string): InstanceType<typeof GrantState>;
  grantAlarms: Map<unknown, number>;
}

/** Test-only proof and clock; real state code runs on an in-memory storage host. */
export function createOAuthHarness(identityTtlMs = 3_600_000): OAuthHarness {
  let now = 1_000_000;
  const redemptions = new Map<string, number>();
  const grants = new Map<unknown, Map<string, unknown>>();
  const grantAlarms = new Map<unknown, number>();
  let tail = Promise.resolve();
  const grantObject = (hash: unknown) => {
    let values = grants.get(hash);
    if (!values) {
      values = new Map();
      grants.set(hash, values);
    }
    const store = {
      get: <T>(key: string) =>
        Promise.resolve(structuredClone(values.get(key)) as T | undefined),
      put: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
      setAlarm: (at: number) => {
        grantAlarms.set(hash, at);
        return Promise.resolve();
      },
    };
    return new GrantState(
      {
        storage: {
          ...store,
          transaction: (operation) => {
            const result = tail.then(() => operation(store));
            tail = result.then(
              () => undefined,
              () => undefined,
            );
            return result;
          },
        },
      },
      undefined,
      { now: () => now },
    );
  };
  const grantNamespace: RedemptionNamespace = {
    idFromName: (hash) => hash,
    get: grantObject,
  };
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
  const harness: OAuthHarness = {
    grantNamespace,
    grantObject,
    grantAlarms,
    options: {
      issuer,
      resources: ["https://api.example/a", "https://api.example/b"],
      storage,
      grantRevocation: durableGrants(grantNamespace),
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
  const memory = harness.options.codeRedemption;
  harness.options.codeRedemption = durableRedemption({
    idFromName: (hash) => hash,
    get: (hash) => ({
      fetch: async (request) =>
        new Response(null, {
          status: (await memory.claimOnce(
            String(hash),
            Number(new URL(request.url).searchParams.get("until")),
          ))
            ? 200
            : 400,
        }),
    }),
  });
  harness.options.refresh = refreshPolicy(harness.options);
  return harness;
}
