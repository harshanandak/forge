import type { Unavailable } from "../generated/types.ts";
import type {
  ProcessResult,
  ResolvedExecutable,
  SpawnOptions,
} from "./process.ts";

/** An adapter owns executable resolution and argv dispatch; the caller supplies every budget. */
export interface ToolCommandPort {
  resolve(
    program: string,
    env: Readonly<Record<string, string>>,
  ): ResolvedExecutable | Unavailable;
  run(
    program: string,
    args: readonly string[],
    options: SpawnOptions,
  ): Promise<ProcessResult | Unavailable>;
}
export interface AccountCommandPort extends ToolCommandPort {
  run(
    program: string,
    args: readonly string[],
    options: SpawnOptions & {
      readonly credential?: {
        readonly token: string;
        readonly pinnedGit: string;
        readonly ownedConfigDir: string;
        readonly ownedDataDir: string;
      };
    },
  ): Promise<ProcessResult | Unavailable>;
}
