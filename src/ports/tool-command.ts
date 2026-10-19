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
export interface AccountScriptsOptions {
  readonly account: string;
  readonly gitPath: string;
  readonly ghPath: string;
  readonly ghArgs: readonly string[];
  readonly envPath: string;
  readonly shellPath: string;
  readonly environmentNames: readonly string[];
  readonly allowedGhCommands: readonly string[];
  readonly accountKey: string;
  readonly marker: string;
  readonly windows: boolean;
}
export interface AccountBootstrapOptions {
  readonly body: string;
  readonly envPath: string;
  readonly shellPath: string;
  readonly environmentNames: readonly string[];
  readonly marker: string;
  readonly windows: boolean;
}
export interface AccountCommandPort extends ToolCommandPort {
  bootstrap(options: AccountBootstrapOptions): string;
  scripts(options: AccountScriptsOptions): {
    readonly router: string;
    readonly credential: string;
  };
}
