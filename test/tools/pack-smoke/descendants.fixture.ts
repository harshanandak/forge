import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { runWithin } from "../../../tools/pack-smoke/bounded.ts";
import { isRunning } from "../../node-fixtures/process/liveness.ts";

const mode = process.argv[2]!;
let descendant: number | undefined;
let connection: Socket | undefined;
let ready!: () => void;
const readiness = new Promise<void>((resolve) => (ready = resolve));
const server = createServer((socket) => {
  connection = socket;
  socket.on("error", (error: NodeJS.ErrnoException) => {
    // taskkill resets the ready runner's TCP connection on Windows.
    if (descendant === undefined || error.code !== "ECONNRESET") throw error;
  });
  socket.once("data", (data) => {
    descendant = Number(String(data));
    ready();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const grandchild = `
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.send(process.pid);
setInterval(() => {}, 1000);`;
const runner = `
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {stdio:['ignore','ignore','ignore','ipc']});
child.once('message', pid => {
  const socket = require('node:net').connect(${address.port}, '127.0.0.1', () => socket.write(String(pid)));
  socket.on('data', data => process.exit(Number(String(data))));
});
setInterval(() => {}, 1000);`;
// Only the supervisor's deadline is virtual; both descendants are real OS processes.
const timer = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
const realSetTimeout = globalThis.setTimeout;
let expire!: () => void;
Object.defineProperty(globalThis, "setTimeout", {
  value(callback: () => void) {
    expire = callback;
    return realSetTimeout(() => {}, 0);
  },
});
const signals = ["SIGINT", "SIGTERM"] as const;
const counts = signals.map((signal) => process.listenerCount(signal));
let finished = false;
const pending = runWithin(
  "ready tree",
  process.execPath,
  ["-e", runner],
  {},
  2000,
).then(
  () => {
    finished = true;
    return "ok";
  },
  (error: unknown) => {
    finished = true;
    return error;
  },
);
Object.defineProperty(globalThis, "setTimeout", timer);
let startupTimer: ReturnType<typeof setTimeout> | undefined;
try {
  await Promise.race([
    readiness,
    new Promise<never>((_resolve, reject) => {
      startupTimer = setTimeout(
        () => reject(new Error("descendant readiness timed out")),
        10000,
      );
    }),
  ]);
  clearTimeout(startupTimer);
  assert.ok(
    descendant && isRunning(descendant),
    "resistant descendant is ready",
  );
  if (mode === "timeout") expire();
  else if (mode === "SIGTERM" || mode === "SIGINT") process.emit(mode);
  else {
    connection!.write(mode === "success" ? "0" : "3");
  }
  const outcome = await pending;
  const expected =
    mode === "success"
      ? "ok"
      : mode === "failure"
        ? "ready tree failed: exit 3"
        : mode === "timeout"
          ? "ready tree timed out after 2000 ms; its process tree was killed"
          : `ready tree failed: exit ${mode}`;
  if (outcome instanceof Error && outcome.message !== expected) throw outcome;
  assert.equal(outcome instanceof Error ? outcome.message : outcome, expected);
  assert.equal(
    isRunning(descendant),
    false,
    "descendant must be stopped before return",
  );
  for (const [index, signal] of signals.entries())
    assert.equal(process.listenerCount(signal), counts[index]);
  console.log(`PASS ${mode}: resistant descendant stopped; listeners restored`);
} finally {
  clearTimeout(startupTimer);
  Object.defineProperty(globalThis, "setTimeout", timer);
  if (!finished) {
    expire();
    await pending;
  }
  if (descendant && isRunning(descendant)) process.kill(descendant, "SIGKILL");
  connection?.destroy();
  server.close();
}
