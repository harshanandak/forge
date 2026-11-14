import { canonicalJson } from "../../src/core/config/pointer.ts";
import { policyGuard, type MergePolicy } from "./merge-evidence.ts";
import { isPlainJson } from "./plain-json.ts";

export type MergePolicyBindings = Readonly<{
  GITHUB_MERGE_POLICY?: unknown;
  GITHUB_REPOSITORY_ID?: unknown;
  FORGE_CLOUD_PROJECT?: unknown;
}>;
type PolicyResult =
  | Readonly<{ ok: true; policy: MergePolicy }>
  | Readonly<{ ok: false; code: "UNAVAILABLE"; reason: string }>;

/** Only Worker configuration supplies expectations; no request data or I/O. */
export async function readMergePolicy(
  env: MergePolicyBindings,
): Promise<PolicyResult> {
  const unavailable = {
    ok: false,
    code: "UNAVAILABLE",
    reason: "Server merge policy is missing or invalid",
  } as const;
  try {
    const raw = env.GITHUB_MERGE_POLICY,
      repository = env.GITHUB_REPOSITORY_ID;
    if (
      typeof raw !== "string" ||
      raw.length > 16_384 ||
      new TextEncoder().encode(raw).byteLength > 16_384 ||
      typeof repository !== "string" ||
      !/^[1-9]\d{0,15}$/.test(repository) ||
      !Number.isSafeInteger(Number(repository))
    )
      return unavailable;
    const value: unknown = JSON.parse(raw);
    if (
      !uniqueKeys(raw) ||
      !isPlainJson(value) ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.hasOwn(value, "digest")
    )
      return unavailable;
    const policy = { ...value, digest: "0".repeat(64) };
    if (
      !policyGuard(policy) ||
      policy.project !== env.FORGE_CLOUD_PROJECT ||
      policy.repositoryId !== Number(repository) ||
      policy.producer.repositoryId !== Number(repository) ||
      !policy.requiredChecks.length ||
      new Set(policy.requiredChecks).size !== policy.requiredChecks.length
    )
      return unavailable;
    const hash = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(canonicalJson(value)),
      ),
    );
    return {
      ok: true,
      policy: {
        ...policy,
        digest: Array.from(hash, (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join(""),
      },
    };
  } catch {
    return unavailable;
  }
}

// JSON.parse checks grammar; this scan retains keys that parsing overwrites.
function uniqueKeys(raw: string): boolean {
  const stack: (Set<string> | undefined)[] = [];
  for (const match of raw.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}]|\[|\]/g)) {
    const token = match[0];
    if (token === "{" || token === "[")
      stack.push(token === "{" ? new Set<string>() : undefined);
    else if (token === "}" || token === "]") stack.pop();
    else if (/^\s*:/.test(raw.slice(match.index + token.length))) {
      const key = JSON.parse(token) as string,
        seen = stack.at(-1);
      if (!seen || seen.has(key)) return false;
      seen.add(key);
    }
  }
  return true;
}
