import type { ForgeError } from "../generated/types.ts";
import type { CloudRefusalReasonId } from "./cloud-refusal.ts";

/** Thrown by a service client inside a handler; the runtime turns it into a failure envelope. */
export class ForgeFailure extends Error {
  readonly error: ForgeError;
  declare readonly reasonId?: CloudRefusalReasonId;

  constructor(error: ForgeError, reasonId?: CloudRefusalReasonId) {
    super(`${error.code}: ${error.message}`);
    this.name = "ForgeFailure";
    this.error = error;
    if (reasonId !== undefined) this.reasonId = reasonId;
  }
}
