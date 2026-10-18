import type { Unavailable } from "../../generated/types.ts";
import type {
  ProcessPort,
  ProcessResult,
  ResolvedExecutable,
  SpawnOptions,
} from "../../ports/process.ts";
import type { Platform } from "./platform.ts";
import { type FileProbe, realFileProbe, resolveExecutable } from "./resolve.ts";
import { runProcess } from "./run.ts";

export { type ProcessErrorCode, ProcessSpawnError } from "./errors.ts";
export type { FileProbe } from "./resolve.ts";

export interface ProcessAdapterOptions {
  /** Defaults to the running platform; tests pass another to exercise its rules. */
  readonly platform?: Platform;
  readonly probe?: FileProbe;
}

/** The one place programs are started: argument arrays only, PATH/PATHEXT resolution, tree-kill, no console window. */
export function createProcessPort(
  options: ProcessAdapterOptions = {},
): ProcessPort {
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? realFileProbe;
  return {
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
      return runProcess(executable.path, args, spawnOptions, platform);
    },
  };
}
