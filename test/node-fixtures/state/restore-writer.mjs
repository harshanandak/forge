import assert from "node:assert/strict";
import { Worker, isMainThread, workerData } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The store graph is imported dynamically so the worker can report "running"
// (barrier 6) before it pays that cold-start cost, and so the barrier 0 budget
// only covers the store open, not thread start-up plus module loading.
const storeUrl = new URL(
  "../../../src/adapters/store-sqlite/index.ts",
  import.meta.url,
).href;
const wait = (state, index, expected) => {
  const result = Atomics.wait(state, index, expected, 10000);
  assert.notEqual(result, "timed-out", `barrier ${index}`);
};
const signal = (state, index, value = 1) => {
  Atomics.store(state, index, value);
  Atomics.notify(state, index);
};
// Slot 7 counts worker milestones so the main thread can check their order.
const milestone = (state) => Atomics.add(state, 7, 1) + 1;
if (!isMainThread) {
  const { directory, shared, method } = workerData;
  const state = new Int32Array(shared);
  signal(state, 6, milestone(state));
  const { createSqliteStore } = await import(storeUrl);
  const opened = await createSqliteStore(directory, {
    step(step) {
      if (step === "write-pre-lock") {
        signal(state, 0, milestone(state));
        wait(state, 1, 0);
      }
      if (step === "write-lock-attempt") signal(state, 4);
      if (step === "write-locked") signal(state, 5);
    },
  }).open({ path: "live.db", readOnly: false });
  assert.equal(opened.ok, true);
  const db = opened.handle.value;
  try {
    const sql = "INSERT INTO entries VALUES ('writer') RETURNING value";
    if (method === "transaction") db.transaction(() => db.run(sql));
    else db[method](sql);
    signal(state, 2, 2);
  } catch (error) {
    signal(state, 2, error?.code === "restoring" ? 1 : 3);
  } finally {
    await opened.handle.close();
    signal(state, 3);
  }
} else {
  const { createSqliteStore } = await import(storeUrl);
  const mode = process.argv[2];
  const directory = mkdtempSync(join(tmpdir(), "forge-writer-fence-"));
  const handles = [];
  try {
    const open = async (path, hooks = {}) => {
      const result = await createSqliteStore(directory, hooks).open({
        path,
        readOnly: false,
      });
      assert.equal(result.ok, true);
      handles.push(result.handle);
      return result.handle.value;
    };
    const source = await open(":memory:");
    source.exec("CREATE TABLE entries(value TEXT)");
    source.run("INSERT INTO entries VALUES ('snapshot')");
    const image = source.exportImage();
    if (mode === "forced") {
      const { DatabaseSync } = await import("node:sqlite");
      const target = await open("live.db", {
        step(step) {
          if (step === "retained") {
            const raw = new DatabaseSync(join(directory, "live.db"));
            raw.exec("INSERT INTO entries VALUES ('forced')");
            raw.close();
          }
        },
      });
      target.exec("CREATE TABLE entries(value TEXT)");
      assert.throws(
        () =>
          target.restoreImage(
            image,
            () => {},
            () => {},
            () => {},
          ),
        /changed after final approval/,
      );
      assert.deepEqual(
        target.all("SELECT value FROM entries").map((row) => row.value),
        ["forced"],
      );
    } else {
      const [method, boundary] = mode.split(":");
      const state = new Int32Array(new SharedArrayBuffer(32));
      let worker;
      const target = await open("live.db", {
        step(step) {
          if (step === "fenced" && worker && boundary === "queued") {
            signal(state, 1);
            wait(state, 4, 0);
          }
          if (step === "closed" && worker) {
            if (boundary !== "queued") signal(state, 1);
            wait(state, 3, 0);
          }
        },
      });
      target.exec("CREATE TABLE entries(value TEXT)");
      worker = new Worker(new URL(import.meta.url), {
        workerData: { directory, shared: state.buffer, method },
      });
      wait(state, 6, 0);
      wait(state, 0, 0);
      assert.ok(
        Atomics.load(state, 6) < Atomics.load(state, 0),
        "worker must report running before it opens the store",
      );
      target.restoreImage(
        image,
        () => {},
        () => {},
        () => {},
      );
      assert.equal(
        Atomics.load(state, 5),
        1,
        "writer must acquire SQLite lock before refusal",
      );
      assert.equal(
        Atomics.load(state, 2),
        1,
        `${mode}: queued writer must receive typed restoring error`,
      );
      assert.deepEqual(
        target.all("SELECT value FROM entries").map((row) => row.value),
        ["snapshot"],
      );
      await worker.terminate();
    }
    console.log(`PASS ${mode}`);
  } finally {
    for (const handle of handles.reverse()) await handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
