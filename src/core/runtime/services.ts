import { DEFAULT_PARSE_LIMITS } from "../../contract/untrusted.ts";
import type { ParseLimits } from "../../generated/types.ts";
import type { ClockPort } from "../../ports/clock.ts";
import { ForgeFailure } from "../../contract/failure.ts";
import { refuse } from "../trust/index.ts";
import type {
  ProcessPort,
  SpawnOptions,
  ProcessSupervisionReport,
} from "../../ports/process.ts";

/** Revocation covers cached methods as well as clients; the embedding still owns effect checks. */
export class InvocationServices {
  readonly controller: AbortController = new AbortController();
  readonly deadline: number;
  readonly #pending = new Set<Promise<unknown>>();
  #active = true;
  readonly #cleanupErrors: unknown[] = [];
  readonly #authorize: () => void;
  readonly #strict: boolean;
  readonly #reports: ProcessSupervisionReport[] = [];
  readonly #clock: ClockPort;
  readonly #limits: Pick<ParseLimits, "maxNodes" | "maxDepth">;
  constructor(
    deadline: number,
    authorize: () => void,
    strict = false,
    clock: ClockPort = { now: () => Date.now() },
    limits: Pick<ParseLimits, "maxNodes" | "maxDepth"> = DEFAULT_PARSE_LIMITS,
  ) {
    this.#limits = limits;
    this.#clock = clock;
    this.deadline = deadline;
    this.#authorize = authorize;
    this.#strict = strict;
  }
  check(): void {
    if (!this.#active)
      refuse("SERVICE_EXPIRED", "Invocation services have expired");
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    this.#authorize();
    if (this.#clock.now() >= this.deadline) {
      this.controller.abort(
        new ForgeFailure({
          code: "INVOCATION_TIMEOUT",
          message: "Invocation deadline exceeded",
          retry: "reconcile_first",
        }),
      );
      throw this.controller.signal.reason;
    }
  }
  expire(): void {
    this.#active = false;
  }
  stop(): void {
    this.expire();
    if (!this.controller.signal.aborted)
      this.controller.abort(
        new ForgeFailure({
          code: "SERVICE_EXPIRED",
          message: "Invocation settled",
          retry: "never",
        }),
      );
  }
  async wait<T>(
    pending: Promise<T>,
    late?: (value: T) => Promise<void>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let ended = false;
      const abort = (): void => {
        ended = true;
        const reason: unknown = this.controller.signal.reason;
        reject(
          reason instanceof Error
            ? reason
            : new Error("Invocation aborted", { cause: reason }),
        );
      };
      this.controller.signal.addEventListener("abort", abort, { once: true });
      if (this.controller.signal.aborted) abort();
      void pending.then(
        (value) => {
          this.controller.signal.removeEventListener("abort", abort);
          if (ended) {
            void late?.(value).catch(() => undefined);
            return;
          }
          ended = true;
          resolve(value);
        },
        (error: unknown) => {
          this.controller.signal.removeEventListener("abort", abort);
          if (!ended) {
            ended = true;
            reject(
              error instanceof Error
                ? error
                : new Error("Invocation failed", { cause: error }),
            );
          }
        },
      );
    });
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
    if (this.#cleanupErrors.length)
      throw new AggregateError(this.#cleanupErrors, "Process cleanup failed");
  }
  async prepare(value: unknown): Promise<void> {
    if (!this.#strict) return;
    const seen = new Set<object>();
    const ports: ProcessPort[] = [];
    const visit = (entry: unknown, depth: number): void => {
      if (typeof entry !== "object" || entry === null || seen.has(entry))
        return;
      if (depth > this.#limits.maxDepth || seen.size >= this.#limits.maxNodes)
        refuse(
          "LIMIT_EXCEEDED",
          "Service graph exceeds containment preflight budget",
        );
      seen.add(entry);
      if (
        "capability" in entry &&
        entry.capability === "forge.process/v1" &&
        "run" in entry &&
        "resolve" in entry &&
        typeof entry.run === "function" &&
        typeof entry.resolve === "function"
      ) {
        ports.push(entry as ProcessPort);
        return;
      }
      for (const child of Object.values(entry)) visit(child, depth + 1);
    };
    visit(value, 0);
    if (!ports.length)
      refuse(
        "CONTAINMENT_UNAVAILABLE",
        "Operation requires a containment-capable process provider",
      );
    for (const port of ports) {
      this.check();
      if (!port.containment)
        refuse(
          "CONTAINMENT_UNAVAILABLE",
          "Process provider cannot enforce strict containment",
        );
      const capability = await this.wait(port.containment());
      if (!capability.available)
        refuse("CONTAINMENT_UNAVAILABLE", capability.reason);
    }
  }
  warnings(): readonly { readonly code: string; readonly message: string }[] {
    return this.#reports.map((report) => ({
      code: "PROCESS_SUPERVISION",
      message: JSON.stringify({
        ...report,
        stoppedCount: report.stoppedPids.length,
        stoppedPids: report.stoppedPids.slice(0, 32),
      }),
    }));
  }
  wrap(value: unknown): unknown {
    const seen = new WeakMap<object, Map<object | undefined, unknown>>();
    const proxies = new WeakSet<object>();
    const resource = (
      output: unknown,
      checked = new Set<object>(),
      depth = 0,
    ): boolean => {
      if (output instanceof AbortSignal) return false;
      if (typeof output === "function") return true;
      if (output === null || typeof output !== "object") return false;
      if (proxies.has(output) || seen.has(output)) return true;
      if (checked.has(output)) return false;
      if (
        depth > this.#limits.maxDepth ||
        checked.size >= this.#limits.maxNodes
      )
        refuse("LIMIT_EXCEEDED", "Service result exceeds inspection budget");
      checked.add(output);
      const prototype: unknown = Object.getPrototypeOf(output);
      if (
        !Array.isArray(output) &&
        prototype !== null &&
        typeof prototype === "object" &&
        Object.getPrototypeOf(prototype) !== null
      )
        return true;
      for (const key of Reflect.ownKeys(output)) {
        const descriptor = Object.getOwnPropertyDescriptor(output, key)!;
        if (
          !("value" in descriptor) ||
          resource(descriptor.value, checked, depth + 1)
        )
          return true;
      }
      return false;
    };
    const snapshot = (
      output: unknown,
      copies = new Map<object, object>(),
    ): unknown => {
      if (
        output instanceof AbortSignal ||
        output === null ||
        typeof output !== "object"
      )
        return output;
      const existing = copies.get(output);
      if (existing) return existing;
      const copy: object = Array.isArray(output)
        ? new Array(output.length)
        : (Object.create(null) as object);
      copies.set(output, copy);
      for (const key of Reflect.ownKeys(output)) {
        if (Array.isArray(output) && key === "length") continue;
        const descriptor = Object.getOwnPropertyDescriptor(output, key)!;
        Object.defineProperty(copy, key, {
          value: snapshot(descriptor.value, copies),
          enumerable: descriptor.enumerable ?? false,
          configurable: true,
          writable: true,
        });
      }
      return copy;
    };
    const transfer = (output: unknown): unknown =>
      resource(output) ? visit(output) : snapshot(output);
    const returned = (output: unknown): unknown => {
      if (
        output !== null &&
        typeof output === "object" &&
        typeof (output as { then?: unknown }).then === "function"
      ) {
        const pending = Promise.resolve(output).then((value) =>
          transfer(value),
        );
        void pending.catch(() => undefined);
        return pending;
      }
      return transfer(output);
    };

    const visit = (entry: unknown, receiver?: object): unknown => {
      if (
        (typeof entry !== "object" || entry === null) &&
        typeof entry !== "function"
      )
        return entry;
      if (proxies.has(entry)) return entry;
      const cached = seen.get(entry)?.get(receiver);
      if (cached) return cached;
      // Explicit process capabilities inherit cancellation even if the
      // handler omits or replaces its own signal and timeout.
      const processPort =
        typeof entry === "object" &&
        "capability" in entry &&
        entry.capability === "forge.process/v1" &&
        "resolve" in entry &&
        "run" in entry &&
        typeof entry.resolve === "function" &&
        typeof entry.run === "function";
      const target =
        typeof entry === "function" ? (..._args: unknown[]) => undefined : {};
      const read = (key: string | symbol): unknown => {
        this.check();
        if (
          typeof entry === "function" &&
          (key === "bind" || key === "call" || key === "apply")
        )
          return visit(Reflect.get(target, key, target), proxy);
        if (processPort && key === "run")
          return (
            executable: Parameters<ProcessPort["run"]>[0],
            args: readonly string[],
            options: SpawnOptions,
          ) => {
            this.check();
            const port = entry as ProcessPort;
            const signal = options.signal
              ? AbortSignal.any([this.controller.signal, options.signal])
              : this.controller.signal;
            const pending = port
              .run(executable, args, {
                ...options,
                signal,
                containment: this.#strict ? "strict" : "supervised",
                timeoutMs: Math.min(
                  options.timeoutMs,
                  Math.max(1, this.deadline - this.#clock.now()),
                ),
              })
              .catch((error: unknown) => {
                if (
                  error !== null &&
                  typeof error === "object" &&
                  "code" in error &&
                  (error.code === "CONTAINMENT_UNAVAILABLE" ||
                    error.code === "PROCESS_LIMIT_EXCEEDED")
                )
                  throw new ForgeFailure({
                    code: error.code,
                    message:
                      "message" in error && typeof error.message === "string"
                        ? error.message
                        : "Process capability unavailable",
                    retry: "never",
                  });
                throw error;
              });
            this.#pending.add(pending);
            void pending.then(
              (result) => {
                this.#pending.delete(pending);
                if (result.supervision && this.#reports.length < 32)
                  this.#reports.push(result.supervision);
              },
              (error: unknown) => {
                this.#pending.delete(pending);
                if (
                  error !== null &&
                  typeof error === "object" &&
                  "code" in error &&
                  error.code === "TREE_KILL_FAILED"
                )
                  this.#cleanupErrors.push(error);
              },
            );
            return pending;
          };
        return visit(Reflect.get(entry, key, entry), entry);
      };
      const proxy = new Proxy(target, {
        get: (_target, key) => read(key),
        has: (_target, key) => {
          this.check();
          return Reflect.has(entry, key);
        },
        ownKeys: () => {
          this.check();
          return Reflect.ownKeys(entry);
        },
        getOwnPropertyDescriptor: (_target, key) => {
          this.check();
          const descriptor = Reflect.getOwnPropertyDescriptor(entry, key);
          if (!descriptor) return undefined;
          return {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            ...("value" in descriptor
              ? { writable: false, value: read(key) }
              : { get: () => read(key) }),
          };
        },
        apply: (_target, _this, args: unknown[]) => {
          this.check();
          const output: unknown = Reflect.apply(
            entry as (...args: unknown[]) => unknown,
            receiver,
            args.map(transfer),
          );
          return returned(output);
        },
        set: () => {
          this.check();
          refuse("INPUT_INVALID", "Service clients are read-only");
        },
        defineProperty: () => {
          this.check();
          refuse("INPUT_INVALID", "Service clients are read-only");
        },
        deleteProperty: () => {
          this.check();
          refuse("INPUT_INVALID", "Service clients are read-only");
        },
      });
      proxies.add(proxy);
      if (!seen.has(entry)) seen.set(entry, new Map());
      seen.get(entry)!.set(receiver, proxy);
      return proxy;
    };
    return visit(value);
  }
}
