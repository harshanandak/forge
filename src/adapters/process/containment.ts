import { validateSupervision, type SupervisionOptions } from "./supervision.ts";
import type { ContainmentCapability } from "../../ports/process.ts";
import type { Platform } from "./platform.ts";
import { ProcessSpawnError } from "./errors.ts";

export interface ContainmentOptions {
  readonly supervision?: SupervisionOptions;
  /** A host policy can disable strict containment, never enable an unavailable mechanism. */
  readonly strictContainment?: boolean;
}
export interface ContainmentScope {
  readonly backend: "windows-job";
  attach(pid: number): void;
  stop(): Promise<readonly number[]>;
  close(): void;
}
/** Every run validates host options, including runs that never open a Job Object. */
export function validateHostOptions(options: ContainmentOptions): void {
  if (
    options.strictContainment !== undefined &&
    typeof options.strictContainment !== "boolean"
  )
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "strictContainment must be a boolean capability policy",
    );
}
export async function openContainment(
  platform: Platform,
  strict: boolean,
  options: ContainmentOptions = {},
): Promise<ContainmentScope> {
  const timing = validateSupervision(options.supervision);
  validateHostOptions(options);
  if (strict && options.strictContainment === false)
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Strict containment is disabled by the host",
    );
  // Only Windows has a backend that owns detached descendants; strict refuses elsewhere.
  if (platform !== "win32")
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Strict process containment is unavailable on this host",
    );
  const { openWindowsJob } = await import("./windows-job.ts");
  const job = openWindowsJob(timing);
  return {
    backend: "windows-job",
    attach: (pid) => job.attach(pid),
    stop: () => job.stop(),
    close: () => job.close(),
  };
}
export async function containmentCapability(
  platform: Platform,
  options: ContainmentOptions = {},
): Promise<ContainmentCapability> {
  try {
    const scope = await openContainment(platform, true, options);
    scope.close();
    return { available: true, backend: scope.backend };
  } catch (error) {
    return {
      available: false,
      reason:
        error instanceof Error
          ? error.message
          : "Strict containment is unavailable",
    };
  }
}
