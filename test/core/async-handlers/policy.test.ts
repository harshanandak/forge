import { expect, test } from "bun:test";
import {
  Runtime,
  type RuntimeOptions,
} from "../../../src/core/runtime/index.ts";
import { fixture } from "./fixture.ts";

function configured(declaration: { timeoutMs?: number } = {}) {
  const f = fixture("({input}) => input", declaration);
  let opened = 0;
  let scopeDeadline: (() => number) | undefined;
  const runtime = (options: RuntimeOptions = {}) =>
    new Runtime(f.catalog, f.trust, {
      ...options,
      services: (_instance, _context, scope) => {
        opened++;
        scopeDeadline = () => scope.deadline;
        return Promise.resolve({ ownership: "borrowed", value: {} });
      },
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: { run: ({ encode }) => encode("hello") },
            },
          }),
      },
    });
  return {
    ...f,
    runtime,
    opened: () => opened,
    deadline: () => scopeDeadline?.(),
  };
}

test("an undeclared invocation budget refuses before service or evaluator activation", async () => {
  const f = configured();
  expect(await f.runtime().invoke(f.request)).toMatchObject({
    ok: false,
    status: "FAIL",
    error: { code: "INPUT_INVALID", retry: "never" },
  });
  expect(f.opened()).toBe(0);
}, 5000);

for (const [operation, host, expected] of [
  [250, undefined, 250],
  [undefined, 400, 400],
  [250, 400, 250],
  [400, 250, 250],
] as const) {
  test(`declared budgets select the lower operation=${operation} host=${host}`, async () => {
    const f = configured(
      operation === undefined ? {} : { timeoutMs: operation },
    );
    const before = 1000000;
    expect(
      await f
        .runtime({
          clock: { now: () => before },
          ...(host === undefined ? {} : { limits: { timeoutMs: host } }),
        })
        .invoke(f.request),
    ).toMatchObject({ ok: true, result: "hello" });
    expect(f.deadline()).toBe(before + expected);
  }, 5000);
}

for (const timeoutMs of [0, -1, 0.5, 2147483648, NaN, Infinity]) {
  test(`runtime budget rejects the unsafe timer value ${timeoutMs}`, () => {
    const f = configured({ timeoutMs: 250 });
    expect(() => f.runtime({ limits: { timeoutMs } })).toThrow("timeoutMs");
  }, 5000);
}

for (const timeoutMs of [1, 2147483647]) {
  test(`runtime budget accepts the safety boundary ${timeoutMs}`, () => {
    const f = configured();
    expect(() => f.runtime({ limits: { timeoutMs } })).not.toThrow();
  }, 5000);
}

for (const outcome of ["timeout", "cancelled", "close-failed"] as const) {
  test(`supervision evidence survives ${outcome}`, async () => {
    const f = fixture(
      outcome === "close-failed"
        ? "async ({services,input}) => { await services.process.run({kind:'resolved',path:'fake'}, [], {cwd:'/',env:{},timeoutMs:100,maxOutputBytes:100}); return input; }"
        : "async ({services}) => { await services.process.run({kind:'resolved',path:'fake'}, [], {cwd:'/',env:{},timeoutMs:100,maxOutputBytes:100}); return new Promise(() => {}); }",
      { timeoutMs: outcome === "timeout" ? 20 : 500 },
    );
    const controller = new AbortController();
    const processResult: import("../../../src/ports/process.ts").ProcessResult =
      {
        exitCode: 0,
        signal: null,
        stdout: "available output",
        stderr: "available error",
        timedOut: false,
        truncated: false,
        durationMs: 0,
        supervision: {
          mode: "supervised",
          backend: "process-group",
          supervisorPid: 123,
          stoppedPids: [124],
          confirmed: true,
          supervisorResidentBytes: 1024,
        },
      };
    const port: import("../../../src/ports/process.ts").ProcessPort = {
      capability: "forge.process/v1",
      resolve: () => ({ kind: "resolved", path: "fake" }),
      run: (_executable, _args, options) => {
        if (outcome === "close-failed") return Promise.resolve(processResult);
        return new Promise((resolve) => {
          options.signal!.addEventListener(
            "abort",
            () => resolve(processResult),
            { once: true },
          );
          if (outcome === "cancelled") queueMicrotask(() => controller.abort());
        });
      },
    };
    let now = 0;
    const result = await f
      .runtime({
        clock: { now: () => now },
        isolation: {
          open: () =>
            Promise.resolve({
              ok: true,
              handle: {
                ownership: "owned",
                close: () => Promise.resolve(),
                value: {
                  async run(options) {
                    const args = options.args as {
                      services: {
                        process: import("../../../src/ports/process.ts").ProcessPort;
                      };
                    };
                    const pending = args.services.process.run(
                      { kind: "resolved", path: "fake" },
                      [],
                      {
                        cwd: "/",
                        env: {},
                        timeoutMs: 100,
                        maxOutputBytes: 100,
                      },
                    );
                    if (outcome === "timeout") {
                      now = options.deadline;
                      args.services.process.resolve("fake", {});
                    }
                    await pending;
                    return options.encode("hello");
                  },
                },
              },
            }),
        },
        services: () =>
          Promise.resolve({
            ownership: "owned",
            value: { process: port },
            close: () =>
              outcome === "close-failed"
                ? Promise.reject(Error("close failed"))
                : Promise.resolve(),
          }),
      })
      .invoke(f.request, { signal: controller.signal });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code:
          outcome === "timeout"
            ? "INVOCATION_TIMEOUT"
            : outcome === "cancelled"
              ? "INVOCATION_CANCELLED"
              : "INTERNAL",
      },
      warnings: [{ code: "PROCESS_SUPERVISION" }],
    });
    expect(JSON.parse(result.warnings[0]!.message)).toMatchObject({
      confirmed: true,
      stoppedPids: [124],
    });
    expect(result).toMatchObject({
      error: {
        observed: {
          processes: {
            results: [
              {
                stdout: "available output",
                stderr: "available error",
                exitCode: 0,
              },
            ],
            omittedResults: 0,
          },
        },
      },
    });
  }, 5000);
}

for (const spent of [80, 101])
  test(`preparation has a separate configured ceiling, with elapsed host work=${spent}`, async () => {
    const f = fixture("({input}) => input", { timeoutMs: 20 });
    let now = 0;
    let runs = 0;
    let closed = 0;
    const runtime = new Runtime(f.catalog, f.trust, {
      clock: { now: () => now },
      limits: { timeoutMs: 100 },
      services: () => {
        now += spent;
        return Promise.resolve({
          ownership: "owned",
          value: {},
          close: () => {
            closed++;
            return Promise.resolve();
          },
        });
      },
      isolation: {
        open: () =>
          Promise.resolve({
            ok: true,
            handle: {
              ownership: "owned",
              close: () => Promise.resolve(),
              value: {
                run(options) {
                  runs++;
                  expect(options.timeoutMs).toBe(20);
                  now += 19;
                  return options.encode("hello");
                },
              },
            },
          }),
      },
    });
    const result = await runtime.invoke(f.request);
    if (spent < 100)
      expect(result).toMatchObject({ ok: true, result: "hello" });
    else
      expect(result).toMatchObject({
        ok: false,
        error: { code: "INVOCATION_TIMEOUT", retry: "never" },
      });
    expect(runs).toBe(spent < 100 ? 1 : 0);
    expect(closed).toBe(1);
  }, 5000);
