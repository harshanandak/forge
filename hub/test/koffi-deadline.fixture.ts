import { equal, ok } from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { load, mode, systemDll, target } from "./koffi-load.fixture.ts";

const slow = 8_000;
const budget = 5_000;
const bound = 5_050;
const dwell = 250;
const kernel32 = () => load().load(systemDll("kernel32"));
const elapsed = (start: number) =>
  Number((performance.now() - start).toFixed(1));

async function measureFs(label: string): Promise<void> {
  await Promise.all(
    ([readFile, stat] as ((path: string) => Promise<unknown>)[]).map(
      async (operation) => {
        const start = performance.now();
        await operation(target);
        console.log(`${label} ${operation.name} ${elapsed(start)} ms`);
      },
    ),
  );
}

function startWorker(ms: number, entry?: unknown) {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { state, ms, entry },
  });
  return { worker, state };
}

if (!isMainThread) {
  const { state, ms, entry } = workerData as {
    state: Int32Array;
    ms: number;
    entry?: unknown;
  };
  const library = kernel32();
  equal(library.func("uint32_t GetCurrentProcessId()")(), process.pid);
  const wait = library.func("void Sleep(uint32_t ms)");
  Atomics.store(state, 0, process.pid);
  Atomics.notify(state, 0);
  try {
    if (entry) {
      const current = library.func("void *GetCurrentProcess()");
      const block = library.func(
        "uint32_t SignalObjectAndWait(void *signal, void *target, uint32_t ms, int alertable)",
      );
      equal(block(entry, current(), ms, 0), 258);
    } else wait(ms);
  } finally {
    Atomics.store(state, 1, 1);
    Atomics.notify(state, 1);
  }
} else if (mode === "pool") {
  await measureFs("idle");
  const wait = kernel32().func("void Sleep(uint32_t ms)");
  const start = performance.now();
  const pending = Array.from(
    { length: 4 },
    (_, i) =>
      new Promise<void>((resolve, reject) => {
        wait.async(slow, (error: unknown) => {
          if (error)
            reject(Error("Koffi async Sleep failed", { cause: error }));
          else {
            console.log(`async Sleep ${i + 1} ${elapsed(start)} ms`);
            resolve();
          }
        });
      }),
  );
  await Promise.all([measureFs("four async calls"), ...pending]);
  console.log("MEASURED pool: PASSED");
} else {
  const library = mode === "unref" ? kernel32() : undefined;
  const entry = library?.func(
    "void *CreateEventW(void *attributes, int manual, int initial, void *name)",
  )(null, 0, 0, null);
  let active: ReturnType<typeof startWorker> | undefined;
  const submit = (ms: number) => {
    if (active && Atomics.load(active.state, 1) === 0) return undefined;
    return (active = startWorker(ms, entry));
  };
  const start = performance.now();
  const remaining = () => Math.max(0, start + budget - performance.now());
  const first = submit(slow);
  ok(first);
  const { worker, state } = first;
  Atomics.wait(state, 0, 0, remaining());
  equal(
    Atomics.load(state, 0),
    process.pid,
    "(a) worker did not load/call Win32",
  );
  const a = elapsed(start);
  if (library) {
    ok(entry);
    const awaitEntry = library.func(
      "uint32_t WaitForSingleObject(void *handle, uint32_t ms)",
    );
    equal(
      awaitEntry(entry, Math.ceil(remaining())),
      0,
      "Worker did not enter its native wait",
    );
    equal(Atomics.wait(state, 1, 0, dwell), "timed-out");
    equal(Atomics.load(state, 1), 0);
    ok(library.func("int CloseHandle(void *event)")(entry));
    console.log(`UNREF ${Date.now()} after ${dwell} ms`);
    worker.unref();
  } else {
    const duringWait = measureFs("fs submitted before main wait");
    equal(
      Atomics.wait(state, 1, 0, remaining()),
      "timed-out",
      "(b) main wait did not time out",
    );
    const b = elapsed(start);
    console.log(`(b) worker startup plus wait ${b} ms (bound ${bound} ms)`);
    ok(b <= bound, `(b) exceeded ${bound} ms`);
    const attempt = performance.now();
    equal(submit(0), undefined);
    console.log(`one in-flight refusal ${elapsed(attempt)} ms`);
    await Promise.all([
      duringWait,
      measureFs("one dedicated worker after main wait"),
    ]);
    equal(
      Atomics.load(state, 1),
      0,
      "The original native call finished before fs completed",
    );
    worker.unref();
    const replacementAt = performance.now();
    active = undefined;
    const replacement = submit(0);
    ok(replacement);
    const { state: current } = replacement;
    Atomics.wait(current, 1, 0, 2_000);
    equal(Atomics.load(current, 0), process.pid);
    equal(Atomics.load(current, 1), 1);
    console.log(
      `MEASURED (a) ${a} ms: PASSED\nMEASURED (b) ${b} ms, bound ${bound} ms: PASSED\nMEASURED (d) ${elapsed(replacementAt)} ms: PASSED`,
    );
  }
}
