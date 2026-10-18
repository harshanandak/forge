import { Script, createContext } from "node:vm";
import { isPromise } from "node:util/types";
import type {
  RunIsolation,
  RunIsolationPort,
} from "../../core/runtime/index.ts";

/** Trusted synchronous code with a deadline, never a security sandbox. */
const evaluator: RunIsolation = {
  run(options) {
    const context = createContext(
      {
        args: options.args,
        encode: options.encode,
        fail: options.fail,
        operation: options.operation,
        discardPromise: (output: unknown): void => {
          if (isPromise(output)) {
            void Promise.prototype.then.call(
              output,
              undefined,
              () => undefined,
            );
          }
        },
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
        const output = handler(args);
        if (output != null && typeof output.then === 'function') {
          discardPromise(output);
          fail('BLOCK_ASYNC_UNSUPPORTED', 'sync handler returned a thenable');
        }
        encode(output);
      `,
      { filename: options.filename },
    );
    try {
      const encoded: unknown = script.runInContext(context, {
        timeout: options.timeoutMs,
      });
      return encoded;
    } catch (error) {
      if (
        error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
      ) {
        options.fail(
          "LIMIT_EXCEEDED",
          `execution exceeds timeoutMs ${options.timeoutMs}`,
        );
      }
      throw error;
    }
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
