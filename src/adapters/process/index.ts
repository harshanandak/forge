import { spawn } from "node:child_process";
import type { Unavailable } from "../../generated/types.ts";
import { isAbsolute, relative, sep } from "node:path";
import type {
  DesktopLauncher,
  ProcessPort,
  ProcessResult,
  ResolvedExecutable,
  SpawnOptions,
} from "../../ports/process.ts";
import type { Platform } from "./platform.ts";
import { type FileProbe, realFileProbe, resolveExecutable } from "./resolve.ts";
import {
  containmentCapability,
  type ContainmentOptions,
} from "./containment.ts";
import { runProcess } from "./run.ts";

export { type ProcessErrorCode, ProcessSpawnError } from "./errors.ts";
export type { FileProbe } from "./resolve.ts";
export { processStartTime } from "./resolve.ts";

export interface ProcessAdapterOptions extends ContainmentOptions {
  /** Defaults to the running platform; tests pass another to exercise its rules. */
  readonly platform?: Platform;
  readonly probe?: FileProbe;
}

/** The one place programs are started: argument arrays only, PATH/PATHEXT resolution, tree cleanup, no console window. */
export function createProcessPort(
  options: ProcessAdapterOptions = {},
): ProcessPort {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? realFileProbe;
  return {
    capability: "forge.process/v1",
    containment: () => containmentCapability(platform, options),
    resolve(
      executable: string,
      env: Readonly<Record<string, string>>,
    ): ResolvedExecutable | Unavailable {
      return resolveExecutable(executable, env, platform, probe);
    },
    async run(
      executable: ResolvedExecutable,
      args: readonly string[],
      spawnOptions: SpawnOptions,
    ): Promise<ProcessResult> {
      if (spawnOptions.leaveDirectory) {
        const from = relative(spawnOptions.leaveDirectory, process.cwd());
        if (from !== ".." && !from.startsWith(".." + sep) && !isAbsolute(from))
          process.chdir(spawnOptions.cwd);
      }
      return runProcess(executable.path, args, spawnOptions, platform, options);
    },
  };
}

/** Desktop handoff deliberately leaves the application running after the CLI exits. */
export function createDesktopLauncher(
  start: typeof spawn = spawn,
): DesktopLauncher {
  return {
    resolve: (name, env) =>
      resolveExecutable(name, env, process.platform, realFileProbe),
    launch(executable, args, options) {
      return new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error("Cancelled"));
          return;
        }
        const child = start(executable.path, [...args], {
          cwd: options.cwd,
          env: { ...options.env },
          detached: true,
          stdio: "ignore",
          shell: false,
          windowsHide: true,
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
  };
}
