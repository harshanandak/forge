import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import type { ProtectPath } from "../contract/runtime.ts";

export interface PathProtection {
  readonly protectPath: ProtectPath;
  createPrivateDirectory(path: string): Promise<boolean>;
  createPrivateFile(path: string): Promise<FileHandle | null>;
}

export interface ProtectionDeps {
  readonly platform: NodeJS.Platform;
  readonly lstat: (path: string) => Stats;
  readonly geteuid: () => number | undefined;
  readonly now: () => number;
  readonly execute: (
    executable: string,
    args: readonly string[],
    options: SpawnSyncOptionsWithStringEncoding,
  ) => {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
    readonly error?: Error;
  };
}

export function createPathProtection(
  _deps: Partial<ProtectionDeps> = {},
): PathProtection {
  throw new Error("not_built");
}
