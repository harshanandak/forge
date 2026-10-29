import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [installed, mode = "write", suppliedStore] = process.argv.slice(2);
const delayMs = 3500;
if (mode === "lock-holder") {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(suppliedStore);
  database.exec("BEGIN IMMEDIATE");
  process.send({ kind: "locked" });
  process.once("message", () => {
    setTimeout(() => {
      database.exec("COMMIT");
      database.close();
      process.disconnect();
    }, delayMs);
  });
} else {
  assert.ok(["write", "readback", "lock"].includes(mode));
  const load = (path) =>
    import(pathToFileURL(join(installed, "dist/src", path)).href);
  const { createCheck, verifyReceipt } = await load("blocks/check/index.js");
  const { finalizationTimeoutMs } = await load("blocks/check/budget.js");
  const { createProcessPort } = await load("adapters/process/index.js");
  const { createRunnerOutput } = await load("adapters/runner-output/index.js");
  const { sqliteStore } = await load("adapters/store-sqlite/index.js");
  const { StateOwner } = await load("core/state/index.js");
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "check-finalization-")),
  );
  const store = join(directory, "state.sqlite");
  const opened = await sqliteStore.open({ path: store, readOnly: false });
  assert.equal(opened.ok, true, "reproduction store opens");
  const owner = new StateOwner(opened.handle.value, { now: () => Date.now() });
  owner.initialize();
  const actor = { kind: "human", id: "finalization-reproduction" };
  const timings = { snapshotMs: 0, writeMs: 0, readbackMs: 0 };
  let receiptId;
  let readBack = false;
  let locker;
  let exited;
  let reopened;
  const delay = () =>
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  try {
    if (mode === "lock") {
      locker = spawn(
        process.execPath,
        [fileURLToPath(import.meta.url), installed, "lock-holder", store],
        {
          env: {
            SystemRoot: process.env.SystemRoot ?? "C:/Windows",
            FORGE_DEVICE_ROOT: join(directory, "device"),
          },
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
        },
      );
      let errors = "";
      locker.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      exited = once(locker, "exit");
      const ready = await Promise.race([
        once(locker, "message"),
        exited.then(() => {
          throw Error("lock holder exited: " + errors);
        }),
      ]);
      assert.equal(ready[0].kind, "locked");
    }
    const state = {
      get(key) {
        const start = performance.now();
        const record = owner.get("forge/check", key);
        if (mode === "readback") delay();
        timings.readbackMs += performance.now() - start;
        readBack = record !== undefined;
        return record;
      },
      put(key, value, options) {
        const start = performance.now();
        receiptId = value.id;
        if (mode === "lock") locker.send({ kind: "release-after-delay" });
        const record = owner.put("forge/check", key, value, actor, options);
        if (mode === "write") delay();
        timings.writeMs += performance.now() - start;
        return record;
      },
      list: (prefix) => owner.list("forge/check", prefix),
      events: (key) => owner.events("forge/check", key),
    };
    const config = {
      commands: {},
      timeoutMs: 3000,
      maxOutputBytes: 8192,
      outputHeadBytes: 1024,
      outputTailBytes: 1024,
      maxMetadataBytes: 32768,
      maxReceiptBytes: 262144,
      report: "auto",
      stopOnFailure: true,
      inputs: [],
      maxInputBytes: 1048576,
      environment: [],
    };
    const engine = createCheck({
      root: directory,
      environment: {},
      state,
      clock: { now: () => Date.now() },
      snapshot: async () => {
        const start = performance.now();
        const result = {
          head: "finalization-reproduction",
          filesDigest: "sha256:" + "a".repeat(64),
        };
        timings.snapshotMs += performance.now() - start;
        return result;
      },
      process: createProcessPort(),
      output: createRunnerOutput(),
    });
    const result = await engine.run({}, config).catch((failure) => failure);
    assert.equal(result.code, undefined, result.message);
    assert.equal(result.status, "NOT_EXECUTED");
    assert.equal(
      readBack,
      true,
      "the returned receipt follows successful readback",
    );
    if (exited) await exited;
    await opened.handle.close();
    reopened = await sqliteStore.open({ path: store, readOnly: true });
    assert.equal(reopened.ok, true, "durable store reopens read-only");
    const reader = new StateOwner(reopened.handle.value, {
      now: () => Date.now(),
    });
    const receipt = reader.get("forge/check", "runs/" + receiptId)?.value;
    assert.ok(receipt, "returned receipt remains durable after reopening");
    assert.deepEqual(result, receipt);
    assert.equal(verifyReceipt(receipt, receipt.inputsDigest), true);
    console.log(
      JSON.stringify({
        mode,
        store,
        budgetMs: finalizationTimeoutMs(config.maxReceiptBytes),
        injectedDelayMs: delayMs,
        timings,
        returnedStatus: result.status,
        receiptId,
        receiptStatus: receipt.status,
        readBackBeforeReturn: readBack,
        durableAfterReopen: true,
      }),
    );
  } finally {
    if (locker?.exitCode === null) {
      locker.kill();
      await exited;
    }
    if (reopened?.ok) await reopened.handle.close();
    await opened.handle.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
