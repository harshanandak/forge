// Processes are spawned with argument arrays only, never shell strings, and executables are
// resolved by a PATH (and on Windows PATHEXT) walk. Only the process adapter implements this.
import type { Unavailable } from "../generated/types.ts";

export interface SpawnOptions {
  readonly cwd: string;
  /** The full child environment; nothing is inherited implicitly. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly stdin?: string;
  /** Cancellation stops the entire process tree before run settles. */
  readonly signal?: AbortSignal;
}

export interface ProcessResult {
  /** null when the process was killed. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Output beyond maxOutputBytes was dropped; what was kept is still returned. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface ResolvedExecutable {
  readonly kind: "resolved";
  readonly path: string;
}

export interface ProcessPort {
  resolve(
    executable: string,
    env: Readonly<Record<string, string>>,
  ): ResolvedExecutable | Unavailable;
  /** Runs to completion; the whole process tree is stopped on timeout. */
  run(
    executable: ResolvedExecutable,
    args: readonly string[],
    options: SpawnOptions,
  ): Promise<ProcessResult>;
}
