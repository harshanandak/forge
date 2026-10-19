import { expect, test } from "bun:test";
import { ForgeFailure } from "../../../src/contract/failure.ts";
import { fixture } from "./fixture.ts";

for (const legacy of [true, false]) {
  for (const source of [
    "({ input }) => input",
    "async ({ input }) => { await Promise.resolve(); return input; }",
    "({ input }) => ({ then(resolve) { resolve(input); } })",
  ])
    test(`one ABI accepts value/Promise/thenable with legacy=${legacy}: ${source}`, async () => {
      const f = fixture(source, {}, legacy);
      expect(await f.runtime().invoke(f.request)).toMatchObject({
        ok: true,
        result: "hello",
      });
    }, 5000);
}

test("handlers and service factories receive the same runtime signal and declared deadline", async () => {
  const f = fixture(
    "({ input, signal, deadline, services }) => services.inspect(signal, deadline, input)",
    { timeoutMs: 300 },
  );
  const before = Date.now();
  expect(
    await f
      .runtime({
        services: (_instance, _context, scope) =>
          Promise.resolve({
            ownership: "borrowed",
            value: {
              inspect(signal: AbortSignal, deadline: number, input: string) {
                expect(signal).toBe(scope.signal);
                expect(deadline).toBe(scope.deadline);
                expect(deadline).toBeGreaterThanOrEqual(before + 300);
                expect(deadline).toBeLessThanOrEqual(Date.now() + 300);
                expect(signal.aborted).toBe(false);
                return input;
              },
            },
          }),
      })
      .invoke(f.request),
  ).toMatchObject({ ok: true, result: "hello" });
}, 5000);

for (const source of [
  "() => new Promise(() => {})",
  "async () => { await Promise.resolve(); while(true) {} }",
  "() => ({ then() { while(true) {} } })",
])
  test(`deadline bounds pending promises and VM continuations: ${source}`, async () => {
    const f = fixture(source, { timeoutMs: 20 });
    expect(await f.runtime().invoke(f.request)).toMatchObject({
      ok: false,
      error: { code: "INVOCATION_TIMEOUT" },
    });
  }, 5000);

test("cancellation returns a typed failure and closes owned services", async () => {
  const f = fixture("() => new Promise(() => {})");
  const controller = new AbortController();
  let closes = 0;
  const pending = f
    .runtime({
      services: () =>
        Promise.resolve({
          ownership: "owned",
          value: {},
          close: () => {
            closes++;
            return Promise.resolve();
          },
        }),
    })
    .invoke(f.request, { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "INVOCATION_CANCELLED" },
    });
    expect(closes).toBe(1);
  } finally {
    clearTimeout(timer);
  }
}, 5000);

for (const outcome of ["success", "rejected", "timeout", "cancelled"] as const)
  test(`cached state/process/network methods expire on ${outcome} without writes`, async () => {
    const controller = new AbortController();
    const f = fixture(
      `({ services }) => { services.retain(services); ${outcome === "success" ? 'return "hello"' : outcome === "rejected" ? 'throw Error("bad")' : "return new Promise(() => {})"}; }`,
    );
    let retained:
      | {
          state: { put(this: void): void };
          process: { run(): void };
          network: { send(): void };
        }
      | undefined;
    let cached: (() => void) | undefined;
    let writes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const runtime = f.runtime({
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: {
            state: Object.freeze({
              put: () => {
                writes++;
              },
            }),
            process: {
              run: () => {
                writes++;
              },
            },
            network: {
              send: () => {
                writes++;
              },
            },
            retain(services: NonNullable<typeof retained>) {
              retained = services;
              cached = services.state.put;
              if (outcome === "cancelled")
                timer = setTimeout(() => controller.abort(), 0);
            },
          },
        }),
    });
    try {
      const result = await runtime.invoke(f.request, {
        signal: controller.signal,
      });
      expect(result.ok).toBe(outcome === "success");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    for (const call of [
      () => retained!.state.put(),
      () => retained!.process.run(),
      () => retained!.network.send(),
      () => cached!(),
    ]) {
      expect(call).toThrow(ForgeFailure);
      try {
        call();
      } catch (error) {
        expect((error as ForgeFailure).error.code).toBe("SERVICE_EXPIRED");
      }
    }
    expect(writes).toBe(0);
  }, 5000);

test("async effects still need human admission and exact operation grants", async () => {
  const f = fixture(
    "async ({ services }) => { await Promise.resolve(); return services.write(); }",
    { effects: ["sample:write"] },
  );
  let opens = 0;
  let writes = 0;
  const runtime = f.runtime({
    services: (_name, _context, scope) => {
      opens++;
      expect(scope.effects).toEqual(["sample:write"]);
      return Promise.resolve({
        ownership: "borrowed",
        value: {
          write: () => {
            writes++;
            return "hello";
          },
        },
      });
    },
  });
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: false,
    error: { code: "GRANT_REQUIRED" },
  });
  expect(opens).toBe(0);
  expect(writes).toBe(0);
  f.trust.grant("human", f.block.digest, ["sample:write"]);
  expect(await runtime.invoke(f.request)).toMatchObject({ ok: true });
  expect(writes).toBe(1);
  f.trust.revoke("human", f.block.digest);
  expect(await runtime.invoke(f.request)).toMatchObject({
    ok: false,
    error: { code: "ADMISSION_REQUIRED" },
  });
  expect(writes).toBe(1);
}, 5000);

test("cancellation while opening a service closes a late owned handle", async () => {
  const f = fixture("({ input }) => input");
  const controller = new AbortController();
  let release!: (value: {
    ownership: "owned";
    value: object;
    close(): Promise<void>;
  }) => void;
  let closes = 0;
  const pending = f
    .runtime({
      services: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    })
    .invoke(f.request, { signal: controller.signal });
  controller.abort();
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: "INVOCATION_CANCELLED" },
  });
  release({
    ownership: "owned",
    value: {},
    close: () => {
      closes++;
      return Promise.resolve();
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closes).toBe(1);
}, 5000);

test("settlement cancels and drains a process the handler did not await", async () => {
  const f = fixture(
    "({services,input}) => { services.process.run({kind:'resolved',path:'fake'}, [], {cwd:'/',env:{},timeoutMs:10000,maxOutputBytes:100}); return input; }",
  );
  let stopped = false;
  const port = {
    resolve: () => ({ kind: "resolved" as const, path: "fake" }),
    run: (
      _executable: unknown,
      _args: readonly string[],
      options: import("../../../src/ports/process.ts").SpawnOptions,
    ) =>
      new Promise((resolve) => {
        options.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            resolve({});
          },
          { once: true },
        );
      }),
  };
  const result = await f
    .runtime({
      services: () =>
        Promise.resolve({ ownership: "borrowed", value: { process: port } }),
    })
    .invoke(f.request);
  expect(result).toMatchObject({ ok: true, result: "hello" });
  expect(stopped).toBe(true);
}, 5000);

test("revoking trust while an async handler waits prevents its next service write", async () => {
  const f = fixture(
    "async ({services}) => { await services.wait(); return services.write(); }",
    { effects: ["sample:write"] },
  );
  f.trust.grant("human", f.block.digest, ["sample:write"]);
  let writes = 0;
  const result = await f
    .runtime({
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: {
            wait: () => {
              f.trust.revoke("human", f.block.digest);
              return Promise.resolve();
            },
            write: () => {
              writes++;
              return "written";
            },
          },
        }),
    })
    .invoke(f.request);
  expect(result).toMatchObject({
    ok: false,
    error: { code: "ADMISSION_REQUIRED" },
  });
  expect(writes).toBe(0);
}, 5000);

test("scoped services preserve slot enumeration and descriptors cannot leak raw methods", async () => {
  const f = fixture(
    "({services}) => { const put=Object.getOwnPropertyDescriptor(services.state,'put').value; services.retain(put); return Object.keys(services).sort().join(','); }",
  );
  let retained: (() => void) | undefined;
  let writes = 0;
  const result = await f
    .runtime({
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: {
            state: Object.freeze({
              put: () => {
                writes++;
              },
            }),
            retain: (put: () => void) => {
              retained = put;
            },
          },
        }),
    })
    .invoke(f.request);
  expect(result).toMatchObject({ ok: true, result: "retain,state" });
  expect(() => retained!()).toThrow(ForgeFailure);
  expect(writes).toBe(0);
}, 5000);

test("bound service methods stay revoked and shared class methods keep their receiver", async () => {
  class Client {
    readonly #value: string;
    constructor(value: string) {
      this.#value = value;
    }
    read() {
      return this.#value;
    }
  }
  const f = fixture(
    "({services}) => {services.retain(services.first.valueOf().read.bind(services.first.valueOf())); return services.first.read() + services.second.read() + services.first.read.bind(services.first)();}",
  );
  let bound: (() => string) | undefined;
  const result = await f
    .runtime({
      services: () =>
        Promise.resolve({
          ownership: "borrowed",
          value: {
            first: new Client("a"),
            second: new Client("b"),
            retain: (fn: () => string) => {
              bound = fn;
            },
          },
        }),
    })
    .invoke(f.request);
  expect(result).toMatchObject({ ok: true, result: "aba" });
  expect(() => bound!()).toThrow(ForgeFailure);
}, 5000);
