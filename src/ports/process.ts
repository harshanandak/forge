// Processes are spawned with argument arrays only, never shell strings, and executables are
// resolved by a PATH (and on Windows PATHEXT) walk. Only the process adapter implements this.
import type { Unavailable } from "../generated/types.ts";

export interface SpawnOptions {
  readonly cwd: string;
  /** The full child environment; nothing is inherited implicitly. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Optional bounded head/tail capture; their sum must fit maxOutputBytes. */
  readonly capture?: {
    readonly headBytes: number;
    readonly tailBytes: number;
  };
  /** Sees every output byte as it arrives; capture bounds never apply to it. */
  readonly observer?: OutputObserver;
  readonly stdin?: string;
  /** Cancellation stops the supervised scope before run settles. */
  readonly signal?: AbortSignal;
  readonly containment?: "supervised" | "strict";
}

export interface OutputObserver {
  push(stream: "stdout" | "stderr", chunk: Uint8Array): void;
}

export type ContainmentCapability =
  | {
      readonly available: true;
      readonly backend: "windows-job" | "linux-cgroup";
    }
  | { readonly available: false; readonly reason: string };

export interface ProcessSupervisionReport {
  readonly mode: "supervised" | "strict";
  readonly backend: "windows-job" | "linux-cgroup" | "process-group";
  readonly supervisorPid: number;
  readonly commandPid?: number;
  /** Known associated PIDs terminated at cleanup; process-group cleanup addresses groupId. */
  readonly stoppedPids: readonly number[];
  readonly groupId?: number;
  readonly confirmed: boolean;
  readonly pidSnapshotComplete?: boolean;
  readonly supervisorResidentBytes: number;
}

export interface ProcessResult {
  /** null when the process was killed. */
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Output exceeded the requested capture bounds; retained bytes are still returned. */
  readonly truncated: boolean;
  readonly durationMs: number;
  /** Present when capture was requested. Digests include every observed raw byte. */
  readonly outputEvidence?: {
    readonly stdout: ProcessOutputEvidence;
    readonly stderr: ProcessOutputEvidence;
  };
  readonly supervision?: ProcessSupervisionReport;
}

export interface ProcessOutputEvidence {
  /** Raw preview bytes, encoded without loss at UTF-8 boundaries. */
  readonly head: string;
  readonly tail: string;
  readonly encoding: "base64";
  readonly totalBytes: number;
  readonly digest: string;
  /** False if the pipes did not finish draining before their cleanup deadline. */
  readonly complete: boolean;
}

export interface ResolvedExecutable {
  readonly kind: "resolved";
  readonly path: string;
}

export interface ProcessPort {
  /** Explicit capability identity; unrelated resolve/run clients are never rewritten. */
  readonly capability: "forge.process/v1";
  /** A host capability probe. Never launches the requested executable. */
  containment?(): Promise<ContainmentCapability>;
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
