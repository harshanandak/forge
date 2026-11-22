import type { ForgeError } from "../generated/types.ts";

/** Thrown by a service client inside a handler; the runtime turns it into a failure envelope. */
export class ForgeFailure extends Error {
  readonly error: ForgeError;
  declare readonly reasonId?: string;

  constructor(error: ForgeError, reasonId?: string) {
    super(`${error.code}: ${error.message}`);
    this.name = "ForgeFailure";
    this.error = error;
    if (reasonId !== undefined) this.reasonId = reasonId;
  }
}
