// forge.state@1: the outside-block door to the single state owner. A block gets records in its own
// namespace, with revisions and events; never SQL and never another block's namespace.
import type { StateEvent, StateRecord } from "../generated/types.ts";

export interface PutOptions {
  /** The revision the caller last read; 0 means the key must not exist yet. */
  readonly expectRevision: number;
}

export interface BatchEntry extends PutOptions {
  readonly key: string;
  readonly value: unknown;
}

export interface StateClient {
  get(key: string): StateRecord | undefined;
  /** A stale expectRevision throws a ForgeFailure carrying REVISION_CONFLICT and the current revision. */
  put(key: string, value: unknown, options: PutOptions): StateRecord;
  list(prefix?: string): readonly StateRecord[];
  events(key?: string): readonly StateEvent[];
}

export interface RangeOptions {
  /** Smallest key to read, inclusive. */
  readonly from?: string;
  /** Keys at or after this are not read, exclusive. */
  readonly to?: string;
  /** Records to read at most, from 1 to 1000. */
  readonly limit: number;
  readonly descending?: boolean;
}

/**
 * A client that can write several records atomically and read one bounded page of keys.
 * `putMany`: all entries commit in one transaction or none does, and the store syncs once, not once
 * per record. Every entry carries its own expectRevision, a stale one fails the whole batch, and
 * keys must be distinct. `listRange`: reads at most `limit` records from a key range, in key order
 * or reverse, without loading the rest of the namespace.
 */
export interface ExtendedStateClient extends StateClient {
  putMany(entries: readonly BatchEntry[]): readonly StateRecord[];
  listRange(options: RangeOptions): readonly StateRecord[];
}
