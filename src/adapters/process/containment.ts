import type { ContainmentCapability } from "../../ports/process.ts";
import type { Platform } from "./platform.ts";
import { ProcessSpawnError } from "./errors.ts";
import { killTree } from "./tree-kill.ts";

export interface ContainmentOptions {
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
export async function openContainment(platform: Platform, strict: boolean, options: ContainmentOptions = {}): Promise<ContainmentScope> {
  if (strict && options.strictContainment === false)
    throw new ProcessSpawnError("CONTAINMENT_UNAVAILABLE", "Strict containment is disabled by the host");
  if (platform === "win32") {
    const {openWindowsJob} = await import("./windows-job.ts");
    return {backend:"windows-job", ...openWindowsJob()};
  }
  if (platform === "linux" && strict) {
    const {openLinuxCgroup} = await import("./cgroup.ts");
    const group = openLinuxCgroup(options.cgroupRoot);
    return {backend:"linux-cgroup", attach:pid=>group.attach(pid), stop:()=>group.stop(), close:()=>group.close()};
  }
  if (strict) throw new ProcessSpawnError("CONTAINMENT_UNAVAILABLE", "Strict process containment is unavailable on this host");
  let pid: number | undefined;
  return { backend:"process-group", attach(value) { pid = value; },
    async stop() { if (pid === undefined) return []; await killTree(pid, platform); return [pid]; }, close() {},
  };
}
export async function containmentCapability(platform: Platform, options: ContainmentOptions = {}): Promise<ContainmentCapability> {
  try { const scope = await openContainment(platform, true, options); scope.close();
    if (scope.backend === "process-group") return {available:false,reason:"Only process-group supervision is available"};
    return {available:true,backend:scope.backend};
  } catch (error) { return {available:false,reason:error instanceof Error ? error.message : "Strict containment is unavailable"}; }
}
