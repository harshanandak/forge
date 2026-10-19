import { validateSupervision, type SupervisionOptions } from "./supervision.ts";
import type { ContainmentCapability } from "../../ports/process.ts";
import type { Platform } from "./platform.ts";
import { ProcessSpawnError } from "./errors.ts";
import { killTree } from "./tree-kill.ts";

export interface ContainmentOptions {
  readonly supervision?: SupervisionOptions;
  /** A host policy can disable strict containment, never enable an unavailable mechanism. */
  readonly strictContainment?: boolean;
  readonly cgroupRoot?: string;
}
export interface ContainmentScope {
  readonly backend: "windows-job" | "linux-cgroup" | "process-group";
  attach(pid: number): void;
  stop(): Promise<readonly number[]>;
  close(): void;
}
export async function openContainment(
  platform: Platform,
  strict: boolean,
  options: ContainmentOptions = {},
): Promise<ContainmentScope> {
  const timing = validateSupervision(options.supervision);
  if (
    (options.strictContainment !== undefined &&
      typeof options.strictContainment !== "boolean") ||
    (options.cgroupRoot !== undefined &&
      (typeof options.cgroupRoot !== "string" ||
        options.cgroupRoot.length === 0 ||
        options.cgroupRoot.length > 4096 ||
        options.cgroupRoot.includes("\0")))
  )
    throw new ProcessSpawnError(
      "INVALID_OPTIONS",
      "Containment host options must be a boolean capability policy and a bounded cgroup path",
    );
  if (strict && options.strictContainment === false)
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Strict containment is disabled by the host",
    );
  if (platform === "win32") {
    const { openWindowsJob } = await import("./windows-job.ts");
    const job = openWindowsJob(timing);
    return {
      backend: "windows-job",
      attach: (pid) => job.attach(pid),
      stop: () => job.stop(),
      close: () => job.close(),
    };
  }
  if (platform === "linux" && strict) {
    const { openLinuxCgroup } = await import("./cgroup.ts");
    const group = openLinuxCgroup({
      ...timing,
      ...(options.cgroupRoot === undefined ? {} : { root: options.cgroupRoot }),
    });
    return {
      backend: "linux-cgroup",
      attach: (pid) => group.attach(pid),
      stop: () => group.stop(),
      close: () => group.close(),
    };
  }
  if (strict)
    throw new ProcessSpawnError(
      "CONTAINMENT_UNAVAILABLE",
      "Strict process containment is unavailable on this host",
    );
  let pid: number | undefined;
  return {
    backend: "process-group",
    attach(value) {
      pid = value;
    },
    async stop() {
      if (pid === undefined) return [];
      await killTree(pid, timing);
      return [pid];
    },
    close() {},
  };
}
export async function containmentCapability(
  platform: Platform,
  options: ContainmentOptions = {},
): Promise<ContainmentCapability> {
  try {
    const scope = await openContainment(platform, true, options);
    scope.close();
    if (scope.backend === "process-group")
      return {
        available: false,
        reason: "Only process-group supervision is available",
      };
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
