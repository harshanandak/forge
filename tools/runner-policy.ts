import { readFileSync } from "node:fs";

export interface RunnerPolicy {
  readonly childTimeoutMs: number;
  readonly stepTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly maxOutputBytes: number;
}

/** Repository execution policy; this never changes individual test timeouts. */
export function validateRunnerPolicy(value: unknown): RunnerPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Runner policy must be an object");
  const input = value as Record<string, unknown>;
  const bounds = {
    childTimeoutMs: 600_000,
    stepTimeoutMs: 600_000,
    cleanupTimeoutMs: 60_000,
    maxOutputBytes: 16 * 1024 * 1024,
  };
  if (Object.keys(input).some((key) => !Object.hasOwn(bounds, key)))
    throw new TypeError("Unknown runner policy key");
  for (const [key, maximum] of Object.entries(bounds)) {
    const item = input[key];
    if (
      typeof item !== "number" ||
      !Number.isSafeInteger(item) ||
      item < 1 ||
      item > maximum
    )
      throw new RangeError(`${key} must be an integer in 1..${maximum}`);
  }
  const result = input as unknown as RunnerPolicy;
  if (result.childTimeoutMs > result.stepTimeoutMs)
    throw new RangeError("childTimeoutMs must not exceed stepTimeoutMs");
  return { ...result };
}

export function readRunnerPolicy(): RunnerPolicy {
  const value: unknown = JSON.parse(
    readFileSync(new URL("./runner-policy.json", import.meta.url), "utf8"),
  );
  return validateRunnerPolicy(value);
}

export function inheritRunnerGroup(): boolean {
  const value = process.env.FORGE_RUNNER_GROUP_SCOPE;
  if (value !== undefined && value !== "inherited")
    throw new TypeError(
      "FORGE_RUNNER_GROUP_SCOPE must be inherited when declared",
    );
  return value === "inherited";
}
