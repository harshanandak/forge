// forge.state@1: the outside-block door to the single state owner. A block gets records in its own
// namespace, with revisions and events; never SQL and never another block's namespace.
import type { StateEvent, StateRecord } from "../generated/types.ts";

export interface PutOptions {
  /** The revision the caller last read; 0 means the key must not exist yet. */
  readonly expectRevision: number;
}

export interface StateClient {
  get(key: string): StateRecord | undefined;
  /** A stale expectRevision throws a ForgeFailure carrying REVISION_CONFLICT and the current revision. */
  put(key: string, value: unknown, options: PutOptions): StateRecord;
  list(prefix?: string): readonly StateRecord[];
  events(key?: string): readonly StateEvent[];
}
