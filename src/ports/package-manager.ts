// The user's own package manager, detected from the project; core never names one.
import type { DetectionObservation, Unavailable } from "../generated/types.ts";
import type { ProcessResult } from "./process.ts";

export interface DetectedPackageManager {
  readonly kind: "detected";
  /** The manager's own name, as its detector reports it. */
  readonly name: string;
  readonly version?: string;
  readonly evidence: readonly DetectionObservation[];
}

export interface PackageManagerPort {
  detect(projectRoot: string): Promise<DetectedPackageManager | Unavailable>;
  /** The project's declared script names and commands. */
  scripts(projectRoot: string): Promise<Readonly<Record<string, string>>>;
  /** Run one declared script with the detected manager; never a command Forge chose. */
  runScript(
    projectRoot: string,
    script: string,
    args: readonly string[],
    timeoutMs: number,
  ): Promise<ProcessResult | Unavailable>;
}
