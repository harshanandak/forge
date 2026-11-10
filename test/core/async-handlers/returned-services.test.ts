import assert from "node:assert/strict";
import { expect, test } from "bun:test";
import { InvocationServices } from "../../../src/core/runtime/services.ts";

test("fresh and Promise-returned clients retain the invocation lease", async () => {
  const scope = new InvocationServices(1000, () => undefined, false, {
    now: () => 0,
  });
  let writes = 0;
  const client = () => ({
    send() {
      writes++;
    },
  });
  const services = scope.wrap({
    open: client,
    openAsync: () => Promise.resolve(client()),
  }) as { open(): { send(): void }; openAsync(): Promise<{ send(): void }> };
  const direct = services.open(),
    promised = await services.openAsync();
  direct.send();
  promised.send();
  expect(writes).toBe(2);
  scope.stop();
  for (const value of [direct, promised])
    expect(() => value.send()).toThrow("SERVICE_EXPIRED");
  expect(writes).toBe(2);
}, 5000);

test("late Promise clients and provider-retained callbacks cannot write after settlement", async () => {
  const scope = new InvocationServices(1000, () => undefined, false, {
    now: () => 0,
  });
  let resolve!: (value: { send(): void }) => void;
  let callback: (() => void) | undefined;
  let writes = 0;
  const services = scope.wrap({
    open: () =>
      new Promise<{ send(): void }>((done) => {
        resolve = done;
      }),
    register(value: () => void) {
      callback = value;
    },
  }) as {
    open(): Promise<{ send(): void }>;
    register(value: () => void): void;
  };
  const pending = services.open();
  services.register(() => {
    writes++;
  });
  scope.stop();
  resolve({
    send() {
      writes++;
    },
  });
  await assert.rejects(pending, /SERVICE_EXPIRED/);
  expect(() => callback!()).toThrow("SERVICE_EXPIRED");
  expect(writes).toBe(0);
}, 5000);

test("JSON snapshots remain usable after a service invocation settles", async () => {
  const scope = new InvocationServices(1000, () => undefined, false, {
    now: () => 0,
  });
  const services = scope.wrap({
    get: () => ({ rows: [{ value: 1 }] }),
    read: () => Promise.resolve({ value: 2 }),
  }) as {
    get(): { rows: { value: number }[] };
    read(): Promise<{ value: number }>;
  };
  const direct = services.get(),
    promised = await services.read();
  scope.stop();
  expect(JSON.stringify(direct)).toBe('{"rows":[{"value":1}]}');
  expect(promised.value).toBe(2);
}, 5000);

test("symbol clients and callback records expire, and data is detached from providers", () => {
  const scope = new InvocationServices(1000, () => undefined, false, {
    now: () => 0,
  });
  let writes = 0;
  let retained: { [Symbol.dispose](): void } | undefined;
  const data: { value: number; send?: () => void } = { value: 1 };
  const services = scope.wrap({
    open: () => ({
      [Symbol.asyncIterator]() {
        writes++;
        return { next: () => ({ done: true }) };
      },
    }),
    register(record: { [Symbol.dispose](): void }) {
      retained = record;
    },
    data: () => data,
  }) as {
    open(): AsyncIterable<unknown>;
    register(record: { [Symbol.dispose](): void }): void;
    data(): typeof data;
  };
  const client = services.open();
  const snapshot = services.data();
  services.register({
    [Symbol.dispose]() {
      writes++;
    },
  });
  scope.stop();
  data.send = () => {
    writes++;
  };
  data.value = 2;
  expect(() => client[Symbol.asyncIterator]()).toThrow("SERVICE_EXPIRED");
  expect(() => retained![Symbol.dispose]()).toThrow("SERVICE_EXPIRED");
  expect(snapshot.value).toBe(1);
  expect(snapshot.send).toBeUndefined();
  expect(writes).toBe(0);
}, 5000);

test("unrelated resolve/run clients retain their declared calling convention", () => {
  const scope = new InvocationServices(1000, () => undefined, false, {
    now: () => 0,
  });
  const services = scope.wrap({
    client: { resolve: () => "value", run: (input: string) => input },
  }) as { client: { run(input: string): string } };
  expect(services.client.run("original argument")).toBe("original argument");
}, 5000);

for (const expired of [false, true]) {
  test(`state deletion finalizers enforce ownership and their bound, expired=${expired}`, async () => {
    const clock = { now: 0, monotonic: 0 };
    const scope = new InvocationServices(
      1000,
      () => undefined,
      false,
      {
        now: () => clock.now,
      },
      undefined,
      () => clock.monotonic,
    );
    const rows = new Map([
      ["foreign", { key: "foreign", revision: 1, value: "keep" }],
    ]);
    const removed: string[] = [];
    const clients = {
      state: {
        get: (key: string) => rows.get(key),
        put(key: string, value: string, options: { expectRevision: number }) {
          expect(rows.get(key)?.revision ?? 0).toBe(options.expectRevision);
          const row = { key, value, revision: options.expectRevision + 1 };
          rows.set(key, row);
          return row;
        },
        delete(key: string, options: { expectRevision: number }) {
          expect(rows.get(key)?.revision).toBe(options.expectRevision);
          removed.push(key);
          rows.delete(key);
        },
      },
    };
    expect(
      (scope.wrap(clients) as { state: { finalizeDelete?: unknown } }).state
        .finalizeDelete,
    ).toBeUndefined();
    scope.authorizeFinalizer(clients.state, "owned");
    const services = scope.wrap(clients) as {
      state: typeof clients.state & {
        finalizeDelete(key: string, revision: number): void;
      };
    };
    const state = services.state;
    expect(typeof state.finalizeDelete).toBe("function");
    expect(() => state.finalizeDelete("foreign", 1)).toThrow();
    const written = state.put("owned", "temporary", { expectRevision: 0 });
    state.put("foreign", "keep", { expectRevision: 1 });
    expect(() => state.finalizeDelete("foreign", 2)).toThrow();
    expect(() => state.finalizeDelete("owned", written.revision + 1)).toThrow();
    state.finalizeDelete("owned", written.revision);
    scope.controller.abort(new Error("cancelled"));
    scope.stop();
    if (expired) {
      clock.now = -1000;
      clock.monotonic = 1000;
    }
    await scope.drain();
    await scope.drain();
    expect(removed).toEqual(expired ? [] : ["owned"]);
    expect(rows.has("foreign")).toBe(true);
    expect(rows.has("owned")).toBe(expired);
  }, 5000);
}
