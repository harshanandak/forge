export type ProcessErrorCode =
  "INVALID_OPTIONS" | "UNSAFE_ARGUMENT" | "SPAWN_FAILED" | "TREE_KILL_FAILED";

/** The command could not be started at all; a command that ran and failed is a ProcessResult. */
export class ProcessSpawnError extends Error {
  readonly code: ProcessErrorCode;

  constructor(code: ProcessErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProcessSpawnError";
    this.code = code;
  }
}
