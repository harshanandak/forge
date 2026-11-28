import { equal, ok } from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { isMainThread, Worker, workerData } from "node:worker_threads";
import { load, mode, systemDll, target } from "./koffi-load.fixture.ts";

const slow = 8_000;
const kernel32 = () => load().load(systemDll("kernel32"));
const sleep = () => kernel32().func("void Sleep(uint32_t ms)");
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

function startWorker(ms: number) {
  const state = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { state, ms },
  });
  return { worker, state };
}

if (!isMainThread) {
  const { state, ms } = workerData as { state: Int32Array; ms: number };
  const library = kernel32();
  equal(library.func("uint32_t GetCurrentProcessId()")(), process.pid);
  const wait = library.func("void Sleep(uint32_t ms)");
  Atomics.store(state, 0, process.pid);
  Atomics.notify(state, 0);
  wait(ms);
  Atomics.store(state, 1, 1);
  Atomics.notify(state, 1);
} else if (mode === "pool") {
  await measureFs("idle");
  const wait = sleep();
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
} else {
  let active: ReturnType<typeof startWorker> | undefined;
  const submit = (ms: number) => {
    if (active && Atomics.load(active.state, 1) === 0) return undefined;
    return (active = startWorker(ms));
  };
  const start = performance.now();
  const first = submit(slow);
  ok(first);
  const { worker, state } = first;
  Atomics.wait(state, 0, 0, 5_000);
  equal(
    Atomics.load(state, 0),
    process.pid,
    "(a) worker did not load/call Win32",
  );
  console.log(`(a) worker loaded and called Win32 ${elapsed(start)} ms`);
  if (mode === "unref") {
    equal(Atomics.load(state, 1), 0);
    console.log(`(c) unref while blocked ${Date.now()}`);
    worker.unref();
  } else {
    const duringWait = measureFs("fs submitted before main wait");
    const deadline = performance.now();
    equal(
      Atomics.wait(state, 1, 0, 5_000),
      "timed-out",
      "(b) main wait did not time out",
    );
    console.log(`(b) Atomics.wait timed out ${elapsed(deadline)} ms`);
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
      `(d) replacement worker completed ${elapsed(replacementAt)} ms`,
    );
  }
}
