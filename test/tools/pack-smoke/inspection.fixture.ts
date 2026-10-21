import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

// Isolate the fault in a Node process: the group disappears after SIGKILL but ps fails.
const vanished = process.argv[2] === "vanished";
const child = Object.assign(new EventEmitter(), { pid: 12345 });
const failure = Object.assign(new Error("injected ps inspection failure"), {
  code: "EIO",
});
Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(childProcess, "spawn", { value: () => child });
Object.defineProperty(childProcess, "execFile", {
  value: () => {
    throw failure;
  },
});
const signals: (number | NodeJS.Signals | undefined)[] = [];
Object.defineProperty(process, "kill", {
  value: (_pid: number, signal?: number | NodeJS.Signals) => {
    signals.push(signal);
    if (signal === 0 && vanished)
      throw Object.assign(new Error("group gone"), { code: "ESRCH" });
    return true;
  },
});
syncBuiltinESMExports();
const { runWithin } = await import("../../../tools/pack-smoke/bounded.ts");
const pending = runWithin("inspection", "runner", [], {}, 10000).then(
  () => undefined,
  (error: unknown) => error,
);
child.emit("exit", 0, null);
const outcome = await pending;
if (vanished) {
  assert.equal(outcome, undefined);
} else {
  assert.ok(outcome instanceof Error);
  assert.equal(outcome.message, "inspection: process group cleanup failed");
  assert.equal(outcome.cause, failure);
}
assert.deepEqual(signals, ["SIGKILL", 0]);
console.log(`PASS inspection ${vanished ? "vanished" : "present"}`);
