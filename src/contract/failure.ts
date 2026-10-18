import type { ForgeError } from "../generated/types.ts";

/** Thrown by a service client inside a sync handler; the runtime turns it into a failure envelope. */
export class ForgeFailure extends Error {
  readonly error: ForgeError;

  constructor(error: ForgeError) {
    super(`${error.code}: ${error.message}`);
    this.name = "ForgeFailure";
    this.error = error;
  }
}
