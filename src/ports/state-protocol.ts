import type {
  AmbientContext,
  StateEvent,
  StateRecord,
} from "../generated/types.ts";
import type { BatchEntry, HistoryOptions, RangeOptions } from "./state.ts";

/** Server-issued version, scoped to a namespace and a restore epoch. */
export interface StateReadVersion {
  readonly epoch: string;
  readonly revision: number;
}
export type StateQuery =
  | { readonly kind: "get"; readonly key: string }
  | ({ readonly kind: "range" } & RangeOptions)
  | { readonly kind: "count" | "max"; readonly prefix: string }
  | ({ readonly kind: "history" } & HistoryOptions);

interface StateCapability {
  readonly version: 1;
  /** Exact namespace allowed by deployment config; server authority namespaces are denied. */
  readonly namespace: string;
  /** Bounded audit metadata, not a server business-rule selector. */
  readonly operation: string;
  readonly context: AmbientContext;
  /** Digest of canonical namespace config; `discover` only on an unpinned read. */
  readonly policyRevision: string;
}
export interface StateReadRequest extends StateCapability {
  readonly kind: "read";
  readonly query: StateQuery;
  readonly readVersion?: StateReadVersion;
}
export interface StateReadDependency {
  readonly namespace: string;
  readonly key: string;
  readonly expectRevision: number;
  readonly readVersion: StateReadVersion;
}
export interface StateCommitRequest extends StateCapability {
  readonly kind: "commit";
  readonly requestId: string;
  /** Bounded data, fingerprinted for replay; business rules remain on the device. */
  readonly input: unknown;
  readonly readVersion: StateReadVersion;
  readonly readSet: readonly StateReadDependency[];
  readonly entries: readonly BatchEntry[];
  /** The server derives the holder from authenticated context. */
  readonly fence?: { readonly subject: string; readonly generation: number };
}
interface StateResult {
  readonly version: 1;
  readonly project: string;
  readonly namespace: string;
  readonly policyRevision: string;
  readonly readVersion: StateReadVersion;
}
export type StateReadResult = StateResult & {
  readonly result:
    | { readonly kind: "get"; readonly record: StateRecord | null }
    | {
        readonly kind: "range";
        readonly records: readonly StateRecord[];
        readonly next: string | null;
      }
    | { readonly kind: "count" | "max"; readonly value: number }
    | {
        readonly kind: "history";
        readonly events: readonly StateEvent[];
        readonly next: number | null;
      };
};
export interface StateCommitResult extends StateResult {
  readonly requestId: string;
  readonly records: readonly StateRecord[];
  readonly result: unknown;
}
