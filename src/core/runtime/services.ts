import { ForgeFailure } from "../../contract/failure.ts";
import { refuse } from "../trust/index.ts";
import type { ProcessPort, SpawnOptions } from "../../ports/process.ts";

/** Revocation covers cached methods as well as clients; the embedding still owns effect checks. */
export class InvocationServices {
  readonly controller: AbortController = new AbortController();
  readonly deadline: number;
  readonly #pending = new Set<Promise<unknown>>();
  #active = true;
  readonly #authorize: () => void;
  constructor(deadline: number, authorize: () => void) {
    this.deadline = deadline;
    this.#authorize = authorize;
  }
  check(): void {
    if (!this.#active)
      refuse("SERVICE_EXPIRED", "Invocation services have expired");
    if (this.controller.signal.aborted) throw this.controller.signal.reason;
    this.#authorize();
    if (Date.now() >= this.deadline) {
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
  }
  wrap(value: unknown): unknown {
    const seen = new WeakMap<object, Map<object | undefined, unknown>>();
    const visit = (entry: unknown, receiver?: object): unknown => {
      if (
        (typeof entry !== "object" || entry === null) &&
        typeof entry !== "function"
      )
        return entry;
      const cached = seen.get(entry)?.get(receiver);
      if (cached) return cached;
      // ProcessPort has this structural pair. Its run must inherit cancellation even if the
      // handler omits or replaces its own signal and timeout.
      const processPort =
        typeof entry === "object" &&
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
            const pending = port.run(executable, args, {
              ...options,
              signal,
              timeoutMs: Math.min(
                options.timeoutMs,
                Math.max(1, this.deadline - Date.now()),
              ),
            });
            this.#pending.add(pending);
            void pending.then(
              () => this.#pending.delete(pending),
              () => this.#pending.delete(pending),
            );
            return pending;
          };
        return visit(Reflect.get(entry, key, entry), entry);
      };
      const proxy = new Proxy(target, {
        get: (_target, key) => read(key),
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
            args,
          );
          return typeof output === "function" ||
            (typeof output === "object" && output !== null && seen.has(output))
            ? visit(output)
            : output;
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
      if (!seen.has(entry)) seen.set(entry, new Map());
      seen.get(entry)!.set(receiver, proxy);
      return proxy;
    };
    return visit(value);
  }
}
