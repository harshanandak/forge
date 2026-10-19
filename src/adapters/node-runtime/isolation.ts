import { Script, createContext } from "node:vm";
import type {
  RunIsolation,
  RunIsolationPort,
} from "../../core/runtime/index.ts";

/** Trusted code, not a security sandbox. VM microtasks are pumped under the same deadline. */
const evaluator: RunIsolation = {
  run(options) {
    let synchronous = true;
    let completed = false;
    let result: unknown;
    let failure: unknown;
    const pending = new Promise<unknown>((resolve, reject) => {
      let done = false;
      let pump: ReturnType<typeof setInterval> | undefined;
      const finish = (error: unknown, output?: string): void => {
        if (done) return;
        done = true;
        if (pump !== undefined) clearInterval(pump);
        options.signal.removeEventListener("abort", abort);
        options.settled();
        if (synchronous) {
          completed = true;
          result = output;
          failure = error;
        }
        if (error !== undefined)
          reject(
            error instanceof Error
              ? error
              : new Error("Block execution failed", { cause: error }),
          );
        else resolve(output);
      };
      const abort = (): void => finish(options.signal.reason);
      if (options.signal.aborted) {
        abort();
        return;
      }
      options.signal.addEventListener("abort", abort, { once: true });
      const context = createContext(
        {
          args: options.args,
          encode: options.encode,
          fail: options.fail,
          operation: options.operation,
          completed: (output: string) => finish(undefined, output),
          failed: (error: unknown) => finish(error),
        },
        { microtaskMode: "afterEvaluate" },
      );
      const script = new Script(
        `
        const module = { exports: {} };
        const exports = module.exports;
        (function(module, exports) { "use strict";\n${options.source}\n})(module, exports);
        const handler = module.exports[operation];
        if (typeof handler !== 'function') fail('BLOCK_EXECUTION_FAILED', 'declared handler is missing');
        Promise.resolve(handler(args)).then(output => {
          completed(encode(output));
        }).catch(failed);
      `,
        { filename: options.filename },
      );
      const tick = (script: Script): void => {
        try {
          const remaining = options.deadline - Date.now();
          if (remaining <= 0)
            options.fail("INVOCATION_TIMEOUT", "Invocation deadline exceeded");
          script.runInContext(context, { timeout: Math.max(1, remaining) });
        } catch (error) {
          if (
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
          ) {
            try {
              options.fail(
                "INVOCATION_TIMEOUT",
                "Invocation deadline exceeded",
              );
            } catch (failure) {
              finish(failure);
            }
          } else finish(error);
        }
      };
      tick(script);
      if (!done) {
        const drain = new Script("");
        pump = setInterval(() => tick(drain), 1);
      }
    });
    synchronous = false;
    if (completed) {
      void pending.catch(() => undefined);
      if (failure !== undefined)
        throw failure instanceof Error
          ? failure
          : new Error("Block execution failed", { cause: failure });
      return result;
    }
    return pending;
  },
};

export const nodeRunIsolation: RunIsolationPort = {
  open() {
    return Promise.resolve({
      ok: true,
      handle: {
        ownership: "owned",
        value: evaluator,
        close: () => Promise.resolve(),
      },
    });
  },
};
