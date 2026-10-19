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
        services: async (_instance, _context, scope) => ({
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
      services: async () => ({
        ownership: "owned",
        value: {},
        close: async () => {
          closes++;
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
      { timeoutMs: 30 },
    );
    let retained:
      | {
          state: { put(): void };
          process: { run(): void };
          network: { send(): void };
        }
      | undefined;
    let cached: (() => void) | undefined;
    let writes = 0;
    const runtime = f.runtime({
      services: async () => ({
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
          },
        },
      }),
    });
    const timer =
      outcome === "cancelled"
        ? setTimeout(() => controller.abort(), 10)
        : undefined;
    try {
      await runtime.invoke(f.request, { signal: controller.signal });
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
    services: async (_name, _context, scope) => {
      opens++;
      expect(scope.effects).toEqual(["sample:write"]);
      return {
        ownership: "borrowed",
        value: {
          write: () => {
            writes++;
            return "hello";
          },
        },
      };
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
    close: async () => {
      closes++;
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(closes).toBe(1);
}, 5000);
