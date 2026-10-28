import type { ProcessPort } from "../../ports/process.ts";
import type { StateClient } from "../../ports/state.ts";
import type { RunnerOutputPort } from "../../ports/runner-output.ts";
import type { InputSnapshot, MergeResult } from "./types.ts";
export interface CryptoService {
  sha256(text: string): string;
  randomUUID(): string;
}
export interface CloneFilesService {
  readonly root: string;
  read(path: string, maxBytes: number): string | undefined;
  snapshot(input: {
    readonly paths: readonly string[];
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
  }): Promise<InputSnapshot>;
}
export interface CatalogServices {
  readonly process: ProcessPort & {
    readonly cleanupBudgetMs?: number;
    retainMergeOutcome?(result: MergeResult): void;
  };
  readonly state: StateClient;
  readonly output: RunnerOutputPort;
  readonly files: CloneFilesService;
  readonly environment: {
    select(names: readonly string[]): Readonly<Record<string, string>>;
  };
  readonly crypto: CryptoService;
}
