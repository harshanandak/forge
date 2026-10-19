// Types for block authors (ABI forge.author/v1, profile trusted-action-sync/v1). A handler is
// synchronous: it receives {input, config, services} and returns one JSON value. A Promise is refused
// at the type level here and at run time by the runtime wrapper.
export type {
  BlockManifest,
  DocsRecords,
  ForgeError,
  OperationDeclaration,
  RequiredSlot,
  StateEvent,
  StateRecord,
} from "../generated/types.ts";
export type {
  BatchEntry,
  BatchOptions,
  ExtendedStateClient,
  PutOptions,
  RangeOptions,
  StateClient,
} from "../ports/state.ts";
export type { TrackerOperations, TrackerVerbs } from "../ports/tracker.ts";
export { ForgeFailure } from "./failure.ts";

export interface HandlerArgs<Input, Config = unknown, Services = unknown> {
  readonly input: Input;
  readonly config: Config;
  readonly services: Services;
}

/** Output types that are not thenable; a handler returning a Promise does not type-check. */
export type SyncOutput<Output> =
  Output extends PromiseLike<unknown> ? never : Output;

/** Each operation name mapped to its [input, output]. */
export type OperationTypes = Readonly<
  Record<string, readonly [unknown, unknown]>
>;

/** What the runtime passes every handler; a handler declares only the parts it uses. */
export interface HandlerCall<Input> {
  readonly input: Input;
  readonly config?: unknown;
  readonly services?: unknown;
}

/**
 * The handlers a block exports, keyed by operation name. Method syntax keeps parameters bivariant,
 * so a handler may narrow `config` and `services` to the shapes its manifest declares.
 */
export type Operations<Types extends OperationTypes> = {
  readonly [Op in keyof Types]: {
    handle(args: HandlerCall<Types[Op][0]>): SyncOutput<Types[Op][1]>;
  }["handle"];
};
