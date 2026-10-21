import {
  invocationDeadline,
  validateTimeout,
  TIMEOUT_BOUNDS,
} from "./deadline.ts";
import type { ClockPort } from "../../ports/clock.ts";
import { InvocationServices } from "./services.ts";
import { bindContext } from "../../contract/context.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import {
  parseUntrustedJson,
  DEFAULT_PARSE_LIMITS,
} from "../../contract/untrusted.ts";
import { validateInvocationRequest } from "../../generated/validators.ts";
import type {
  BoundContext,
  InvocationRequest,
  ResultEnvelope,
  ParseLimits,
} from "../../generated/types.ts";
import { Catalog, type CapturedBlock } from "../catalog/index.ts";
import { TrustStore, refuse } from "../trust/index.ts";
import type { Handle, LifetimeProvider } from "../../ports/lifetime.ts";

export interface RuntimeLimits {
  readonly timeoutMs?: number;
  readonly maxOutputBytes: number;
  readonly parse: ParseLimits;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  maxOutputBytes: 1_048_576,
  parse: DEFAULT_PARSE_LIMITS,
};

export type ServiceHandle = Handle<unknown>;

export interface ServiceScope {
  readonly op: string;
  readonly effects: readonly string[];
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly processContainment: "supervised" | "strict";
}

/** Value-or-Promise evaluation is supplied by the embedding through the L1 lifetime port. */
export interface RunIsolation {
  run(options: {
    readonly source: string;
    readonly filename: string;
    readonly operation: string;
    readonly args: unknown;
    readonly encode: (output: unknown) => string;
    readonly fail: typeof refuse;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly deadline: number;
    readonly settled: () => void;
  }): unknown;
}

export type RunIsolationPort = LifetimeProvider<RunIsolation, void>;

export interface RuntimeOptions {
  readonly clock?: ClockPort;
  readonly isolation?: RunIsolationPort;
  readonly limits?: Partial<RuntimeLimits>;
  /** Constructs clients exposing only scope.effects, never block-wide grants.
   * The embedding owns capability enforcement and partial-open rollback.
   */
  readonly services?: (
    instance: string,
    context: BoundContext,
    scope: ServiceScope,
  ) => Promise<ServiceHandle>;
}

/** Bounded JSON encoding never calls getters or toJSON. Runs inside the same deadline as the handler. */
function encodeOutput(value: unknown, limits: RuntimeLimits): string {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set<object>();
  const parts: string[] = [];
  const append = (text: string): void => {
    bytes += Buffer.byteLength(text);
    if (bytes > limits.maxOutputBytes)
      refuse(
        "LIMIT_EXCEEDED",
        `output exceeds maxOutputBytes ${limits.maxOutputBytes}`,
      );
    parts.push(text);
  };
  const visit = (node: unknown, depth: number): void => {
    nodes++;
    if (nodes > limits.parse.maxNodes)
      refuse(
        "LIMIT_EXCEEDED",
        `output exceeds maxNodes ${limits.parse.maxNodes}`,
      );
    if (depth > limits.parse.maxDepth)
      refuse(
        "LIMIT_EXCEEDED",
        `output exceeds maxDepth ${limits.parse.maxDepth}`,
      );
    if (
      node === null ||
      typeof node === "boolean" ||
      (typeof node === "number" && Number.isFinite(node))
    ) {
      append(JSON.stringify(node));
      return;
    }
    if (typeof node === "string") {
      if (node.length > limits.parse.maxStringLength)
        refuse(
          "LIMIT_EXCEEDED",
          `output exceeds maxStringLength ${limits.parse.maxStringLength}`,
        );
      if (node.length > limits.maxOutputBytes)
        refuse(
          "LIMIT_EXCEEDED",
          `output exceeds maxOutputBytes ${limits.maxOutputBytes}`,
        );
      append(JSON.stringify(node));
      return;
    }
    if (typeof node !== "object")
      refuse("OUTPUT_INVALID", "handler must return JSON data");
    if (ancestors.has(node)) refuse("OUTPUT_INVALID", "cyclic handler output");
    ancestors.add(node);
    const array = Array.isArray(node);
    const prototype: unknown = Object.getPrototypeOf(node);
    if (
      !array &&
      prototype !== null &&
      Object.getPrototypeOf(prototype) !== null
    )
      refuse("OUTPUT_INVALID", "output objects must be plain JSON records");
    if (array && node.length + nodes > limits.parse.maxNodes)
      refuse(
        "LIMIT_EXCEEDED",
        `output exceeds maxNodes ${limits.parse.maxNodes}`,
      );
    const keys = array
      ? Array.from({ length: node.length }, (_, i) => String(i))
      : Object.keys(node);
    if (keys.length + nodes > limits.parse.maxNodes)
      refuse(
        "LIMIT_EXCEEDED",
        `output exceeds maxNodes ${limits.parse.maxNodes}`,
      );
    append(array ? "[" : "{");
    keys.forEach((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor === undefined || !("value" in descriptor))
        refuse(
          "OUTPUT_INVALID",
          "output accessors and sparse arrays are refused",
        );
      if (index > 0) append(",");
      if (!array) {
        if (key.length > limits.parse.maxStringLength)
          refuse("LIMIT_EXCEEDED", "output exceeds maxStringLength");
        append(JSON.stringify(key));
        append(":");
      }
      visit(descriptor.value, depth + 1);
    });
    append(array ? "]" : "}");
    ancestors.delete(node);
  };
  visit(value, 0);
  return parts.join("");
}

function freezeData(value: unknown): unknown {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freezeData(child);
    Object.freeze(value);
  }
  return value;
}

/** One shared API for all transports. The trusted profile is trusted code, never a security sandbox. */
export class Runtime {
  readonly #catalog: Catalog;
  readonly #trust: TrustStore;
  readonly #options: RuntimeOptions;
  readonly #limits: RuntimeLimits;

  constructor(
    catalog: Catalog,
    trust: TrustStore,
    options: RuntimeOptions = {},
  ) {
    this.#catalog = catalog;
    this.#trust = trust;
    this.#options = options;
    this.#limits = Object.freeze({
      ...DEFAULT_RUNTIME_LIMITS,
      ...options.limits,
      parse: Object.freeze({
        ...(options.limits?.parse ?? DEFAULT_RUNTIME_LIMITS.parse),
      }),
    });
    if (this.#limits.timeoutMs !== undefined)
      validateTimeout(this.#limits.timeoutMs);
    const parse = this.#limits.parse;
    for (const limit of [
      this.#limits.maxOutputBytes,
      parse.maxBytes,
      parse.maxDepth,
      parse.maxNodes,
      parse.maxStringLength,
    ]) {
      if (!Number.isSafeInteger(limit) || limit <= 0)
        refuse("INPUT_INVALID", "limits must be positive safe integers");
    }
  }

  /** Shipped blocks are trusted by installing the package; other bytes need human admission and grants. */
  #checkTrust(block: CapturedBlock, effects: readonly string[]): void {
    if (!block.shipped) this.#trust.check(block.digest, effects);
  }

  async invokeText(
    text: string | Uint8Array,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ResultEnvelope> {
    const parsed = parseUntrustedJson(text, this.#limits.parse);
    if (!parsed.ok)
      return { ok: false, status: "FAIL", error: parsed.error, warnings: [] };
    return this.invoke(parsed.value, options);
  }

  /** Parsed values from embeddings are trusted objects; outside text uses invokeText. */
  async invoke(
    value: unknown,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ResultEnvelope> {
    let invocation: InvocationServices | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel: (() => void) | undefined;
    let handle: ServiceHandle | undefined;
    let request: InvocationRequest | undefined;
    let started = false;
    let timeoutMessage: (() => string) | undefined;
    let result: ResultEnvelope;
    try {
      const checked = validateInvocationRequest(value);
      if (!checked.ok) refuse("INPUT_INVALID", "invalid invocation request");
      request = checked.value;
      const { block, operation } = this.#catalog.resolve(request.op);
      const declaration = operation.declaration;
      if (!declaration.callers.includes(request.caller))
        refuse("GRANT_REQUIRED", "caller is not permitted");
      if (request.dryRun === true)
        refuse("UNAVAILABLE", "this profile has no dry-run execution contract");
      const bound = bindContext(declaration, request.context);
      if (!bound.ok) throw new ForgeFailure(bound.error);
      if (!block.validate(declaration.input, request.input))
        refuse("INPUT_INVALID", "input does not match operation schema");
      const config =
        this.#catalog.config.blocks[operation.instance]?.config ?? {};
      if (
        block.manifest.configSchema !== undefined &&
        !block.validate(block.manifest.configSchema, config)
      )
        refuse("INPUT_INVALID", "config does not match block schema");
      this.#checkTrust(block, declaration.effects);
      if (
        this.#catalog.bindings(operation.instance).length > 0 &&
        this.#options.services === undefined
      )
        refuse("PROVIDER_MISSING", "bound clients need a service provider");
      const clock = this.#options.clock ?? { now: () => Date.now() };
      const budget = invocationDeadline(
        {
          declared: declaration.timeoutMs,
          configured:
            this.#catalog.config.blocks[operation.instance]
              ?.operationTimeouts?.[operation.declaredOp],
          host: this.#catalog.config.runtime?.timeoutMs,
          embedding: this.#limits.timeoutMs,
        },
        clock,
      );
      const preparationTimeoutMs = Math.min(
        this.#catalog.config.runtime?.timeoutMs ?? TIMEOUT_BOUNDS.maximum,
        this.#limits.timeoutMs ?? TIMEOUT_BOUNDS.maximum,
      );
      timeoutMessage = () => {
        const instance = this.#catalog.config.blocks[operation.instance]!;
        const configured = instance.operationTimeouts?.[operation.declaredOp];
        const host = this.#catalog.config.runtime?.timeoutMs;
        const embedding = this.#limits.timeoutMs;
        const value = started ? budget.timeoutMs : preparationTimeoutMs;
        if (!started && host !== value && embedding !== value)
          return `Invocation host preparation deadline expired: configured operation and command timeouts add up to more than Node's largest supported timer (2147483647 ms, about 24.8 days). Fix: lower blocks.${operation.instance}.operationTimeouts["${operation.declaredOp}"] or blocks.${operation.instance}.config.timeoutMs in .forge/config.yaml.`;
        const key =
          host === value
            ? "runtime.timeoutMs in .forge/config.yaml"
            : embedding === value
              ? "RuntimeOptions.limits.timeoutMs in the embedding host"
              : configured !== undefined
                ? `blocks.${operation.instance}.operationTimeouts["${operation.declaredOp}"] in .forge/config.yaml`
                : `blocks.${operation.instance}.operationTimeouts["${operation.declaredOp}"] in .forge/config.yaml`;
        return `Invocation ${started ? "operation" : "host preparation"} deadline expired: ${key} (${value / 1000} s). Fix: increase ${key} to more than ${value / 1000} s.`;
      };
      invocation = new InvocationServices(
        clock.now() + preparationTimeoutMs,
        () => {
          this.#checkTrust(block, declaration.effects);
        },
        declaration.processContainment === "strict",
        clock,
        this.#limits.parse,
      );
      const scope = invocation;
      cancel = () =>
        scope.controller.abort(
          new ForgeFailure({
            code: "INVOCATION_CANCELLED",
            message: "Invocation cancelled",
            retry: "reconcile_first",
          }),
        );
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) cancel();
      const armDeadline = (timeoutMs: number): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(
          () =>
            scope.controller.abort(
              new ForgeFailure({
                code: "INVOCATION_TIMEOUT",
                message: "Invocation deadline exceeded",
                retry: "reconcile_first",
              }),
            ),
          timeoutMs,
        );
      };
      armDeadline(preparationTimeoutMs);
      scope.check();
      handle = await scope.wait(
        Promise.resolve(
          this.#options.services?.(
            operation.instance,
            bound.context,
            Object.freeze({
              op: request.op,
              effects: Object.freeze([...declaration.effects]),
              signal: scope.controller.signal,
              get deadline() {
                return scope.deadline;
              },
              processContainment:
                declaration.processContainment ?? "supervised",
            }),
          ),
        ),
        async (late) => {
          if (late?.ownership === "owned") await late.close();
        },
      );
      await scope.prepare(handle?.value);
      scope.check();
      // Opening clients may yield; trust must still hold immediately before execution.
      this.#checkTrust(block, declaration.effects);
      if (this.#options.isolation === undefined)
        refuse("PROVIDER_MISSING", "execution needs an isolation provider");
      const opened = await scope.wait(
        this.#options.isolation.open(),
        async (late) => {
          if (late.ok) await late.handle.close();
        },
      );
      if (!opened.ok) refuse("PROVIDER_MISSING", opened.unavailable.reason);
      let encoded: unknown;
      try {
        // Host preparation has its own ceiling; the handler receives its whole declared budget.
        const handlerStartedAt = clock.now();
        scope.startHandler(handlerStartedAt + budget.remaining());
        armDeadline(
          Math.max(TIMEOUT_BOUNDS.minimum, scope.deadline - clock.now()),
        );
        // Opening the evaluator may yield too; admission must still be current.
        this.#checkTrust(block, declaration.effects);
        scope.check();
        started = true;
        encoded = await scope.wait(
          Promise.resolve(
            opened.handle.value.run({
              source: block.text(block.manifest.entry),
              filename: block.manifest.entry,
              operation: operation.declaredOp,
              args: Object.freeze({
                input: freezeData(structuredClone(request.input)),
                config: freezeData(structuredClone(config)),
                services: scope.wrap(handle?.value ?? Object.freeze({})),
                signal: scope.controller.signal,
                deadline: scope.deadline,
              }),
              encode: (output: unknown) => encodeOutput(output, this.#limits),
              fail: refuse,
              timeoutMs: Math.max(1, scope.deadline - clock.now()),
              deadline: scope.deadline,
              signal: scope.controller.signal,
              settled: () => scope.expire(),
            }),
          ),
        );
        budget.remaining();
      } finally {
        scope.stop();
        await opened.handle.close();
      }
      if (typeof encoded !== "string")
        refuse("OUTPUT_INVALID", "missing JSON output");
      const parsed = parseUntrustedJson(encoded, {
        ...this.#limits.parse,
        maxBytes: this.#limits.maxOutputBytes,
      });
      if (!parsed.ok) throw new ForgeFailure(parsed.error);
      if (!block.validate(declaration.output, parsed.value))
        refuse("OUTPUT_INVALID", "output does not match operation schema");
      this.#checkTrust(block, declaration.effects);
      result = {
        ok: true,
        op: request.op,
        status: "OK",
        result: parsed.value,
        warnings: [],
      };
    } catch (error) {
      const failure =
        error instanceof ForgeFailure
          ? error.error
          : {
              code: "BLOCK_EXECUTION_FAILED",
              message: "block execution failed",
              retry: "never" as const,
            };
      result = {
        ok: false,
        ...(request === undefined ? {} : { op: request.op }),
        status:
          failure.code === "ADMISSION_REQUIRED" ||
          failure.code === "GRANT_REQUIRED" ||
          failure.code === "LIMIT_EXCEEDED" ||
          failure.code === "CONTAINMENT_UNAVAILABLE" ||
          failure.code === "PROCESS_LIMIT_EXCEEDED" ||
          failure.code === "PROVIDER_MISSING"
            ? "INCOMPLETE"
            : "FAIL",
        error: {
          ...failure,
          ...(failure.code === "INVOCATION_TIMEOUT" && timeoutMessage
            ? { message: timeoutMessage() }
            : {}),
          retry: started
            ? "reconcile_first"
            : failure.code === "INVOCATION_TIMEOUT"
              ? "never"
              : failure.retry,
        },
        warnings: [],
      };
    }
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener("abort", cancel);
    invocation?.stop();
    let processCleanupFailed = false;
    try {
      await invocation?.drain();
    } catch {
      processCleanupFailed = true;
    }
    try {
      if (handle?.ownership === "owned") await handle.close();
    } catch {
      return {
        ok: false,
        ...(request === undefined ? {} : { op: request.op }),
        status: "INCOMPLETE",
        error: {
          code: "INTERNAL",
          message: "owned service cleanup failed",
          retry: "reconcile_first",
        },
        warnings: [...(invocation?.warnings() ?? [])],
      };
    }
    if (processCleanupFailed)
      return {
        ok: false,
        ...(request === undefined ? {} : { op: request.op }),
        status: "INCOMPLETE",
        error: {
          code: "PROCESS_CLEANUP_FAILED",
          message: "The process tree could not be confirmed stopped",
          retry: "reconcile_first",
        },
        warnings: [...(invocation?.warnings() ?? [])],
      };
    return {
      ...result,
      warnings: [...result.warnings, ...(invocation?.warnings() ?? [])],
    };
  }
}
