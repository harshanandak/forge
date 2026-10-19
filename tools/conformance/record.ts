import type {
  InvocationRequest,
  ResultEnvelope,
} from "../../src/generated/types.ts";

export interface Observation {
  readonly operation: string;
  readonly input: unknown;
  readonly outcome: unknown;
}

/** Snapshot actual calls before handlers or callers can mutate their values. */
export class Recorder {
  readonly #invoke: (request: InvocationRequest) => Promise<ResultEnvelope>;
  readonly #observations: Observation[] = [];
  constructor(invoke: (request: InvocationRequest) => Promise<ResultEnvelope>) {
    this.#invoke = invoke;
  }
  async invoke(request: InvocationRequest): Promise<ResultEnvelope> {
    const input = structuredClone(request.input);
    let outcome: ResultEnvelope;
    try {
      outcome = await this.#invoke(request);
    } catch (error: unknown) {
      this.#observations.push({ operation: request.op, input, outcome: error });
      throw error;
    }
    this.#observations.push(
      structuredClone({ operation: request.op, input, outcome }),
    );
    return outcome;
  }
  observations(): readonly Observation[] {
    return structuredClone(this.#observations);
  }
}
