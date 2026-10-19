// forge.author/v2, trusted-action/v2: one value-or-Promise handler ABI.
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
  ProcessPort,
  ProcessResult,
  SpawnOptions,
  ResolvedExecutable,
} from "../ports/process.ts";
export type {
  BatchEntry,
  BatchOptions,
  DeleteOptions,
  DeletableStateClient,
  ExtendedStateClient,
  HistoryOptions,
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
  readonly signal: AbortSignal;
  /** Absolute runtime deadline, in milliseconds since the Unix epoch. */
  readonly deadline: number;
}

/** Each operation name mapped to its [input, output]. */
export type OperationTypes = Readonly<
  Record<string, readonly [unknown, unknown]>
>;

/** What the runtime passes every handler; a handler declares only the parts it uses. */
export interface HandlerCall<Input> {
  readonly input: Input;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly config?: unknown;
  readonly services?: unknown;
}

/**
 * The handlers a block exports, keyed by operation name. Method syntax keeps parameters bivariant,
 * so a handler may narrow `config` and `services` to the shapes its manifest declares.
 */
export type Operations<Types extends OperationTypes> = {
  readonly [Op in keyof Types]: {
    handle(
      args: HandlerCall<Types[Op][0]>,
    ): Types[Op][1] | Promise<Types[Op][1]>;
  }["handle"];
};
